import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { openNewsRepository } from './news-repository.js';
import { persistDatabase } from './news-database.js';
import type { NewsItemInput } from '../types.js';

function fixtureDirectory(): string {
  const root = path.resolve('..', '.relay-dev', 'news-tests');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'case-'));
}

function item(id: string, publishedAt: number, eventId = id): NewsItemInput {
  return {
    id, eventId, sourceId: 'source-a', url: `https://example.org/${id}`,
    title: `Story ${id}`, description: null, publishedAt, firstFetchedAt: publishedAt + 1000,
    categoryId: 'research', topicIds: ['agent'], entityIds: [], eventTypeId: 'release', language: 'en',
  };
}

test('资讯写入独立月份文件并在重开后保留', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const when = Date.parse('2026-10-10T10:00:00Z');
    const result = await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: when + 1000, nextFetchAt: when + 60_000, items: [item('a', when), item('b', when - 1000)] });
    assert.equal(result.inserted, 2);
    await repo.close();
    assert.equal(fs.existsSync(path.join(dir, 'news.db')), true);
    assert.equal(fs.existsSync(path.join(dir, 'news-2026-10.db')), true);
    assert.equal(fs.existsSync(path.join(dir, 'relay.db')), false);

    const reopened = await openNewsRepository(dir);
    const page = await reopened.list({ from: when - 10_000, to: when + 10_000, limit: 20 });
    assert.deepEqual(page.items.map((entry) => entry.id), ['a', 'b']);
    assert.equal(page.version, 1);
    await reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('按来源集合过滤资讯，空集合不返回任意来源', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const at = Date.parse('2026-10-16T09:00:00Z');
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: at, nextFetchAt: at + 60_000, items: [item('a', at)] });
    await repo.upsertBatch({ sourceId: 'source-b', fetchedAt: at, nextFetchAt: at + 60_000, items: [{ ...item('b', at), sourceId: 'source-b' }] });
    assert.deepEqual((await repo.list({ from: at - 1000, to: at + 1000, limit: 20, filters: { sourceIds: ['source-b'] } })).items.map((entry) => entry.id), ['b']);
    assert.deepEqual((await repo.list({ from: at - 1000, to: at + 1000, limit: 20, filters: { sourceIds: [] } })).items, []);
    await repo.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('总采集数按来源累计各月份实际入库条目，重复抓取不重复计数', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const january = Date.parse('2026-01-10T10:00:00Z');
    const february = Date.parse('2026-02-10T10:00:00Z');
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: january, nextFetchAt: january + 60_000, items: [item('a', january)] });
    assert.deepEqual({ ...repo.getSourceItemCounts() }, { 'source-a': 1 });
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: february, nextFetchAt: february + 60_000, items: [item('b', february)] });
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: february + 1000, nextFetchAt: february + 61_000, items: [item('b', february)] });
    await repo.upsertBatch({ sourceId: 'source-b', fetchedAt: february, nextFetchAt: february + 60_000, items: [{ ...item('c', february), sourceId: 'source-b' }] });
    assert.deepEqual({ ...repo.getSourceItemCounts() }, { 'source-a': 2, 'source-b': 1 });
    await repo.close();
    const reopened = await openNewsRepository(dir);
    assert.deepEqual({ ...reopened.getSourceItemCounts() }, { 'source-a': 2, 'source-b': 1 });
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('跨月份按稳定条目 ID 识别已收录的社交原帖', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const at = Date.parse('2026-09-30T23:00:00Z');
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: at, nextFetchAt: at + 60_000, items: [item('same-url', at)] });
    assert.equal(repo.hasItemId('same-url', at - 86_400_000, at + 86_400_000), true);
    assert.equal(repo.hasItemId('missing', at - 86_400_000, at + 86_400_000), false);
    await repo.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('旧资讯元库缺少分片计数时启动只回填一次', async () => {
  const dir = fixtureDirectory();
  try {
    const at = Date.parse('2026-10-10T10:00:00Z');
    const repo = await openNewsRepository(dir);
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: at, nextFetchAt: at + 60_000, items: [item('legacy', at)] });
    await repo.close();
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const metadata = new SQL.Database(fs.readFileSync(path.join(dir, 'news.db')));
    metadata.run('DELETE FROM news_shard_stats');
    fs.writeFileSync(path.join(dir, 'news.db'), Buffer.from(metadata.export()));
    metadata.close();
    const reopened = await openNewsRepository(dir);
    assert.equal(reopened.getStatistics().itemCount, 1);
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('来源、全站规则、纠错和审计保存在独立元库', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const source = { id: 'example-source', name: 'Example', kind: 'rss_atom' as const, url: 'https://example.com/feed', allowedHosts: ['example.com'], enabled: true, intervalMinutes: 30, categoryId: 'research' };
    repo.ensureSources([source]);
    repo.saveSource({ ...source, enabled: false }, 'admin-1');
    repo.saveGlobalPolicy({ blockedDomains: ['example.com'], blockedKeywords: [], blockedUrls: [] }, 'admin-1');
    repo.saveCorrection('item-1', { hidden: true }, 'admin-1');
    repo.saveCategory('research', '研究论文', 'admin-1');
    await repo.close();
    const reopened = await openNewsRepository(dir);
    assert.equal(reopened.listSources()[0]?.enabled, false);
    assert.deepEqual(reopened.getGlobalPolicy().blockedDomains, ['example.com']);
    assert.equal(reopened.getCorrection('item-1')?.hidden, true);
    assert.equal(reopened.listCategories().find((entry) => entry.id === 'research')?.label, '研究论文');
    assert.equal(reopened.listAudit().length, 4);
    assert.equal(reopened.getStatus().version, 3);
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('升级时清理无入库记录的旧停用默认源，恢复可用源并保留管理员修改与历史', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const oldSource = (id: string) => ({ id, name: id, kind: 'rss_atom' as const, url: `https://example.org/${id}`, allowedHosts: ['example.org'], enabled: false, intervalMinutes: 60, categoryId: 'research', disabledReason: '旧探测失败' });
    const obsolete = oldSource('obsolete');
    const revived = oldSource('revived');
    const edited = oldSource('edited');
    const historical = oldSource('historical');
    repo.ensureSources([obsolete, revived, edited, historical]);
    repo.scheduleSource(obsolete.id, 1000);
    repo.saveSource({ ...edited, url: 'https://changed.example.org/feed' }, 'admin');
    const at = Date.parse('2026-10-20T00:00:00Z');
    await repo.upsertBatch({ sourceId: historical.id, fetchedAt: at, nextFetchAt: at + 60_000, items: [{ ...item('old', at), sourceId: historical.id }] });
    const replacement = { ...revived, enabled: true, disabledReason: undefined, region: 'global' as const };
    const legacy = [obsolete, revived, edited, historical].map((source) => ({ ...source, region: 'global' as const }));
    repo.ensureSources([replacement], legacy);
    assert.deepEqual(repo.listSources().map((source) => source.id), ['edited', 'historical', 'revived']);
    assert.equal(repo.listSources().find((source) => source.id === 'revived')?.enabled, true);
    assert.equal(repo.listSources().find((source) => source.id === 'edited')?.url, 'https://changed.example.org/feed');
    assert.equal(repo.getSourceState('obsolete'), null);
    await repo.close();
    const reopened = await openNewsRepository(dir);
    assert.deepEqual(reopened.listSources().map((source) => source.id), ['edited', 'historical', 'revived']);
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('不同成员的关注与屏蔽规则隔离并在重启后保留', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    repo.saveUserPreferences('member-a', { rules: [{ id: 'a', kind: 'follow', topic: 'agent' }] });
    repo.saveUserPreferences('member-b', { rules: [{ id: 'b', kind: 'mute', source: 'source-a' }] });
    await repo.close();
    const reopened = await openNewsRepository(dir);
    assert.equal(reopened.getUserPreferences('member-a').rules[0]?.kind, 'follow');
    assert.equal(reopened.getUserPreferences('member-b').rules[0]?.kind, 'mute');
    assert.deepEqual(reopened.getUserPreferences('member-c'), { rules: [] });
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('跨月事件合成一张卡并保留两篇出处', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const january = Date.parse('2026-01-31T23:30:00Z');
    const february = Date.parse('2026-02-01T00:30:00Z');
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: february + 1000, nextFetchAt: february + 60_000, items: [item('jan', january, 'event-1'), item('feb', february, 'event-1')] });
    const page = await repo.list({ from: january - 1000, to: february + 1000, limit: 20 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.eventId, 'event-1');
    assert.deepEqual(page.items[0]?.sources.map((source) => source.id), ['feb', 'jan']);
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同事件卡片优先展示官方原发布，仍保留较新的媒体出处', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const at = Date.parse('2026-10-16T09:00:00Z');
    repo.ensureSources([
      { id: 'official', name: '官方', kind: 'github_releases', url: 'https://api.github.com/repos/example/ai/releases', allowedHosts: ['api.github.com'], enabled: true, intervalMinutes: 60, categoryId: 'open_source' },
      { id: 'media', name: '媒体', kind: 'rss_atom', url: 'https://example.org/feed', allowedHosts: ['example.org'], enabled: true, intervalMinutes: 60, categoryId: 'industry' },
    ]);
    await repo.upsertBatch({ sourceId: 'official', fetchedAt: at, nextFetchAt: at + 60_000, items: [{ ...item('original', at, 'same'), sourceId: 'official' }] });
    await repo.upsertBatch({ sourceId: 'media', fetchedAt: at + 60_000, nextFetchAt: at + 120_000, items: [{ ...item('report', at + 60_000, 'same'), sourceId: 'media' }] });
    const event = (await repo.list({ from: at - 1000, to: at + 120_000, limit: 20 })).items[0];
    assert.equal(event?.sourceId, 'official');
    assert.deepEqual(event?.sources.map((source) => source.sourceId), ['official', 'media']);
    await repo.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('同级出处优先展示中文内容，仍保留较新的英文原文', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const at = Date.parse('2026-10-16T09:00:00Z');
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: at, nextFetchAt: at + 60_000, items: [{ ...item('zh', at, 'same'), title: '中文报道', language: 'zh' }] });
    await repo.upsertBatch({ sourceId: 'source-b', fetchedAt: at + 60_000, nextFetchAt: at + 120_000, items: [{ ...item('en', at + 60_000, 'same'), sourceId: 'source-b' }] });
    const event = (await repo.list({ from: at - 1000, to: at + 120_000, limit: 20 })).items[0];
    assert.equal(event?.title, '中文报道');
    assert.deepEqual(event?.sources.map((source) => source.id), ['zh', 'en']);
    await repo.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('历史查询限制时间范围与单页条数', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const now = Date.parse('2026-10-15T00:00:00Z');
    await assert.rejects(repo.list({ from: now - 32 * 86_400_000, to: now, limit: 20 }), /31/);
    await assert.rejects(repo.list({ from: now - 86_400_000, to: now, limit: 51 }), /50/);
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('第二个月份写盘失败后重启恢复，半批不提前发布', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir, { persistDatabase: (filename, database) => {
      if (filename.endsWith('news-2026-02.db')) throw new Error('模拟第二分片写盘失败');
      persistDatabase(filename, database);
    } });
    const january = Date.parse('2026-01-31T23:30:00Z');
    const february = Date.parse('2026-02-01T00:30:00Z');
    await assert.rejects(repo.upsertBatch({ sourceId: 'source-a', fetchedAt: february, nextFetchAt: february + 60_000, items: [item('jan', january), item('feb', february)] }));
    assert.equal(repo.getStatus().available, false);
    await assert.rejects(repo.list({ from: january, to: february, limit: 20 }), /不可用/);
    await repo.close();

    const reopened = await openNewsRepository(dir);
    const page = await reopened.list({ from: january, to: february, limit: 20 });
    assert.deepEqual(page.items.map((entry) => entry.id), ['feb', 'jan']);
    assert.equal(page.version, 1);
    assert.equal(reopened.getSourceState('source-a')?.lastSuccessAt, february);
    assert.equal(reopened.getStatistics().itemCount, 2);
    await reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('所有分片已落盘但元库尚未提交时重放仍递增版本', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const when = Date.parse('2026-10-10T10:00:00Z');
    const newsItem = item('a', when);
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: when, nextFetchAt: when + 60_000, items: [newsItem] });
    await repo.close();

    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const metadata = new SQL.Database(fs.readFileSync(path.join(dir, 'news.db')));
    metadata.run("UPDATE news_meta SET value = '0' WHERE key = 'version'");
    metadata.run('DELETE FROM news_source_state');
    metadata.run('INSERT INTO pending_news_batch (id, payload) VALUES (1, ?)', [JSON.stringify({ batch: { sourceId: 'source-a', fetchedAt: when, nextFetchAt: when + 60_000, items: [newsItem] }, targetVersion: 1 })]);
    fs.writeFileSync(path.join(dir, 'news.db'), Buffer.from(metadata.export()));
    metadata.close();

    const recovered = await openNewsRepository(dir);
    assert.equal(recovered.getStatus().version, 1);
    assert.equal(recovered.getSourceState('source-a')?.lastSuccessAt, when);
    assert.equal(recovered.getStatistics().itemCount, 1);
    await recovered.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('仅打开查询窗口命中的月份分片', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const january = Date.parse('2026-01-10T10:00:00Z');
    const october = Date.parse('2026-10-10T10:00:00Z');
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: january, nextFetchAt: january + 60_000, items: [item('jan', january)] });
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: october, nextFetchAt: october + 60_000, items: [item('oct', october)] });
    await repo.close();
    const reopened = await openNewsRepository(dir);
    await reopened.list({ from: october - 1000, to: october + 1000, limit: 20 });
    assert.deepEqual(reopened.getStatus().loadedShards, ['2026-10']);
    await reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('资讯元库损坏时只让资讯域不可用', async () => {
  const dir = fixtureDirectory();
  try {
    const relayPath = path.join(dir, 'relay.db');
    fs.writeFileSync(relayPath, 'relay-placeholder');
    fs.writeFileSync(path.join(dir, 'news.db'), 'corrupt-news-file');
    const repo = await openNewsRepository(dir);
    assert.equal(repo.getStatus().available, false);
    await assert.rejects(repo.list({ from: 1, to: 2, limit: 20 }), /不可用/);
    assert.equal(fs.readFileSync(relayPath, 'utf8'), 'relay-placeholder');
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('待恢复分片再次写盘失败时不向读者暴露半批内容', async () => {
  const dir = fixtureDirectory();
  try {
    const when = Date.parse('2026-02-01T00:30:00Z');
    const failFebruary = { persistDatabase: (filename: string, database: Parameters<typeof persistDatabase>[1]) => {
      if (filename.endsWith('news-2026-02.db')) throw new Error('磁盘故障');
      persistDatabase(filename, database);
    } };
    const first = await openNewsRepository(dir, failFebruary);
    await assert.rejects(first.upsertBatch({ sourceId: 'source-a', fetchedAt: when, nextFetchAt: when + 60_000, items: [item('feb', when)] }));
    await first.close();
    const failedRecovery = await openNewsRepository(dir, failFebruary);
    assert.equal(failedRecovery.getStatus().available, false);
    await assert.rejects(failedRecovery.list({ from: when - 1000, to: when + 1000, limit: 20 }), /不可用/);
    await failedRecovery.close();
    const recovered = await openNewsRepository(dir);
    assert.equal((await recovered.list({ from: when - 1000, to: when + 1000, limit: 20 })).items.length, 1);
    await recovered.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('搜索把百分号作为普通文字而不是通配符', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const when = Date.parse('2026-10-10T10:00:00Z');
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: when, nextFetchAt: when + 60_000, items: [item('a', when)] });
    const page = await repo.list({ from: when - 1000, to: when + 1000, limit: 20, filters: { q: '%' } });
    assert.equal(page.items.length, 0);
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: when + 1, nextFetchAt: when + 60_000, items: [{ ...item('percent', when), title: '模型效率提升 50%' }] });
    const literal = await repo.list({ from: when - 1000, to: when + 1000, limit: 20, filters: { q: '%' } });
    assert.deepEqual(literal.items.map((entry) => entry.id), ['percent']);
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('游标分页能遍历单月超过一千条历史事件', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const start = Date.parse('2026-10-10T00:00:00Z');
    const items = Array.from({ length: 1001 }, (_, index) => item(`item-${String(index).padStart(4, '0')}`, start + index * 1000));
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: start + 1001 * 1000, nextFetchAt: start + 1002 * 1000, items });
    let cursor: string | undefined;
    const found: string[] = [];
    do {
      const page = await repo.list({ from: start, to: start + 1001 * 1000, limit: 50, cursor });
      found.push(...page.items.map((entry) => entry.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(found.length, 1001);
    assert.equal(new Set(found).size, 1001);
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('跨月事件翻页不会在较早月份再次出现', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    const january = Date.parse('2026-01-31T22:00:00Z');
    const february = Date.parse('2026-02-01T01:00:00Z');
    await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: february + 3600_000, nextFetchAt: february + 7200_000, items: [
      item('older', january), item('shared-jan', january + 3600_000, 'shared'),
      item('shared-feb', february, 'shared'), item('newest', february + 3600_000),
    ] });
    let cursor: string | undefined;
    const seen: string[] = [];
    do {
      const page = await repo.list({ from: january, to: february + 3600_000, limit: 1, cursor });
      seen.push(...page.items.map((entry) => entry.eventId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, ['newest', 'shared', 'older']);
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('逐月读取历史只保留有限数量的分片句柄', async () => {
  const dir = fixtureDirectory();
  try {
    const repo = await openNewsRepository(dir);
    for (let month = 1; month <= 7; month++) {
      const at = Date.UTC(2025, month - 1, 15);
      await repo.upsertBatch({ sourceId: 'source-a', fetchedAt: at, nextFetchAt: at + 60_000, items: [item(`month-${month}`, at)] });
    }
    for (let month = 1; month <= 7; month++) {
      const at = Date.UTC(2025, month - 1, 15);
      assert.equal((await repo.list({ from: at - 1000, to: at + 1000, limit: 20 })).items[0]?.id, `month-${month}`);
      assert.ok(repo.getStatus().loadedShards.length <= 4);
    }
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
