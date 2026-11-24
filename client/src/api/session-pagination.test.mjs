import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('./sessions.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function mockSessionApi(requestJson) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (name === './client') return { requestJson };
    if (name === '../stores/resource-deletion-notice') return {};
    throw new Error(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}

test('会话列表加载后续 ID 页并恢复按最近活动排序', async () => {
  const first = Array.from({ length: 100 }, (_, n) => ({ id: `item-${String(n).padStart(3, '0')}`, updated_at: 1 }));
  const last = { id: 'item-100', updated_at: 2 };
  const urls = [];
  const signal = new AbortController().signal;
  const { listSessions } = mockSessionApi(async (url, options) => {
    urls.push(url);
    assert.equal(options.signal, signal);
    return urls.length === 1 ? first : [last];
  });
  const sessions = await listSessions(signal);
  assert.deepEqual(urls, ['/api/sessions?limit=100&afterId=', '/api/sessions?limit=100&afterId=item-099']);
  assert.equal(sessions.length, 101);
  assert.deepEqual(sessions.slice(0, 3), [last, first[99], first[98]]);
});

test('后续页失败时不交付不完整的列表', async () => {
  const first = Array.from({ length: 100 }, (_, n) => ({ id: `item-${String(n).padStart(3, '0')}`, updated_at: 1 }));
  const { listSessions } = mockSessionApi(async (url) => {
    if (url.endsWith('afterId=')) return first;
    throw new Error('请求失败');
  });
  await assert.rejects(listSessions(), /请求失败/);
});

test('搜索请求发送账号视图条件，并沿用取消信号', async () => {
  const signal = new AbortController().signal;
  const { searchSessions } = mockSessionApi(async (url, options) => {
    const params = new URL(url, 'http://relay.test').searchParams;
    assert.equal(params.get('q'), '标题 & 内容');
    assert.equal(params.get('ownerUserId'), 'selected-user');
    assert.equal(options.signal, signal);
  });
  await searchSessions('标题 & 内容', { ownerUserId: 'selected-user', signal });
});
