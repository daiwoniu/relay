import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import test, { type TestContext } from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import { appendEngineTurnFactInDatabase, ensureEngineTurnFactTables, insertEngineTerminalDecisionInDatabase } from '../db/engine-turn-facts.js';
import { createOnlineTerminalRepair } from './online-terminal-repair.js';

async function fixture(t: TestContext, extra = 0, filename = ':memory:') {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database(); const db = new SQLiteDB(raw, filename);
  raw.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT, deleted_at INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, engine TEXT, engine_bound INTEGER DEFAULT 1,
      owner_user_id TEXT, project_id TEXT, engine_session_id TEXT, deleted_at INTEGER, status TEXT,
      created_at INTEGER, updated_at INTEGER, message_revision INTEGER DEFAULT 0,
      active_attempt_id TEXT, active_turn_id TEXT, active_turn_usage TEXT, active_turn_started_at INTEGER, recovery_previous_status TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, role TEXT, content TEXT,
      phase TEXT, items TEXT, metadata TEXT, created_at INTEGER, duration INTEGER, stopped INTEGER DEFAULT 0);`);
  ensureEngineTurnFactTables(db);
  const final = 'restored reply';
  for (const [id, owner] of [['own', 'admin'], ['other', 'someone-else'],
    ...Array.from({ length: extra }, (_, index) => [`extra-${String(index).padStart(3, '0')}`, 'admin'])]) {
    db.run(`INSERT INTO sessions (id,title,engine,owner_user_id,engine_session_id,status,created_at,updated_at,message_revision)
      VALUES (?,?,'codex',?,?,'completed',1,200,1)`, [id, id, owner, `thread-${id}`]);
    db.run(`INSERT INTO messages (id,session_id,turn_id,role,content,phase,metadata,created_at)
      VALUES (?,?,?,'assistant','','final_answer','{"outcome":"completed"}',50)`, [`${id}-card`, id, `${id}-turn`]);
    appendEngineTurnFactInDatabase(db, { id: `${id}-fact`, sessionId: id, attemptId: `${id}-attempt`, engineId: 'codex',
      connectionId: 'connection', externalTurnId: `${id}-turn`, factType: 'final_answer_completed', source: 'realtime',
      sequence: 1, idempotencyKey: `${id}-key`, observedAt: 100,
      payload: { hasContent: true, contentLength: final.length, contentDigest: createHash('sha256').update(final).digest('hex') } });
    insertEngineTerminalDecisionInDatabase(db, { id: `${id}-decision`, sessionId: id, attemptId: `${id}-attempt`, engineId: 'codex',
      externalTurnId: `${id}-turn`, outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', factId: `${id}-fact`, decidedAt: 100, projectedAt: 100 });
  }
  t.after(() => db.raw().close());
  const loadTurns = async (threadId: string, turns: Set<string>) => ({ threadId,
    items: new Map([...turns].map((id) => [id, [{ id: 'progress', type: 'agentMessage', phase: 'commentary' as const, text: 'progress' },
      { id: 'final', type: 'agentMessage', phase: 'final_answer' as const, text: final }]])), durations: new Map<string, number>() });
  return { db, loadTurns, final };
}

test('面板预览不写库，在线恢复按账号隔离、先备份、保留时间并幂等发布', async (t) => {
  const { db, loadTurns, final } = await fixture(t);
  db.exec('PRAGMA foreign_keys = ON');
  let backups = 0; let saves = 0; let publications = 0;
  const service = createOnlineTerminalRepair({ db: () => db, loadTurns,
    backup: (bytes) => { backups++; assert.ok(bytes.length); assert.equal(db.get("SELECT COUNT(*) n FROM messages")?.n, 2); },
    persist: () => { saves++; db.raw().export(); }, publish: () => { publications++; } });
  const plan = await service.preview('admin');
  assert.equal(plan.turnCount, 1);
  assert.deepEqual(plan.sessions.map((session) => session.id), ['own']);
  assert.equal(JSON.stringify(plan).includes(final), false);
  assert.equal(backups, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages")?.n, 2);
  assert.deepEqual(service.apply('admin', plan.planId!), { restoredCount: 1 });
  const repaired = db.get("SELECT * FROM messages WHERE session_id = 'own' AND content <> ''")!;
  assert.equal(repaired.content, final); assert.equal(repaired.created_at, 100);
  const metadata = JSON.parse(repaired.metadata);
  assert.equal(metadata.processTimeline.some((entry: { itemId: string }) => entry.itemId === 'final'), false);
  assert.equal(db.get("SELECT updated_at FROM sessions WHERE id = 'own'")?.updated_at, 200);
  assert.equal(db.get("SELECT message_revision FROM sessions WHERE id = 'own'")?.message_revision, 2);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE session_id = 'other'")?.n, 1);
  assert.deepEqual(service.apply('admin', plan.planId!), { restoredCount: 1 });
  assert.deepEqual([backups, saves, publications], [1, 1, 1]);
  assert.equal(db.get('PRAGMA foreign_keys')?.foreign_keys, 1);
  assert.equal((await service.preview('admin')).turnCount, 0);
});

test('检测后出现新任务、维护、错误账号或过期计划时拒绝写库', async (t) => {
  const { db, loadTurns } = await fixture(t);
  let maintenance = false; let clock = 100; let backups = 0;
  const service = createOnlineTerminalRepair({ db: () => db, loadTurns, now: () => clock,
    maintenanceBusy: () => maintenance, backup: () => { backups++; }, persist: () => {}, publish: () => {} });
  const plan = await service.preview('admin');
  assert.throws(() => service.apply('someone-else', plan.planId!), /失效/);
  db.run("UPDATE sessions SET active_attempt_id = 'new', status = 'processing' WHERE id = 'other'");
  assert.throws(() => service.apply('admin', plan.planId!), /任务/);
  db.run("UPDATE sessions SET active_attempt_id = NULL, status = 'completed' WHERE id = 'other'");
  maintenance = true;
  assert.throws(() => service.apply('admin', plan.planId!), /维护/);
  maintenance = false; clock += 600_001;
  assert.throws(() => service.apply('admin', plan.planId!), /失效/);
  assert.equal(backups, 0);
});

test('备份失败不修改内存，保存失败回滚内存并保留原审批记录', async (t) => {
  const { db, loadTurns } = await fixture(t);
  db.exec('PRAGMA foreign_keys = ON');
  const backupFailure = createOnlineTerminalRepair({ db: () => db, loadTurns,
    backup: () => { throw new Error('backup failed'); }, persist: () => {} });
  const first = await backupFailure.preview('admin');
  assert.throws(() => backupFailure.apply('admin', first.planId!), /backup failed/);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages")?.n, 2);
  let saves = 0;
  const saveFailure = createOnlineTerminalRepair({ db: () => db, loadTurns, backup: () => {},
    persist: () => { if (++saves === 1) throw new Error('save failed'); }, publish: () => assert.fail('不得发布失败结果') });
  const plan = await saveFailure.preview('admin');
  assert.throws(() => saveFailure.apply('admin', plan.planId!), /保存失败/);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages")?.n, 2);
  assert.equal(db.get("SELECT message_revision FROM sessions WHERE id = 'own'")?.message_revision, 1);
  assert.equal(saves, 1, 'atomic persistence failure must not trigger a second disk write');
  assert.equal(db.get('PRAGMA foreign_keys')?.foreign_keys, 1);
});

test('正文校验不通过或绑定线程变化时不创建或应用恢复计划', async (t) => {
  const { db, loadTurns } = await fixture(t);
  const wrongContent = createOnlineTerminalRepair({ db: () => db, loadTurns: async (thread, turns) => {
    const result = await loadTurns(thread, turns); for (const items of result.items.values()) items[1].text = 'wrong'; return result;
  } });
  const invalid = await wrongContent.preview('admin');
  assert.equal(invalid.planId, null);
  assert.equal(invalid.turnCount, 0);
  assert.match(invalid.issues[0].reason, /校验不一致/);
  const service = createOnlineTerminalRepair({ db: () => db, loadTurns, backup: () => assert.fail('不应备份') });
  const plan = await service.preview('admin');
  db.run("UPDATE sessions SET engine_session_id = 'changed' WHERE id = 'own'");
  assert.throws(() => service.apply('admin', plan.planId!), /变化/);
});

test('超过二十条按稳定游标分批，恢复后继续下一批不漏条且可从头复查', async (t) => {
  const { db, loadTurns } = await fixture(t, 24);
  const service = createOnlineTerminalRepair({ db: () => db, loadTurns, backup: () => {}, persist: () => {}, publish: () => {} });
  const first = await service.preview('admin');
  assert.equal(first.turnCount, 20);
  assert.ok(first.nextCursor);
  assert.deepEqual(service.apply('admin', first.planId!), { restoredCount: 20 });
  const second = await service.preview('admin', first.nextCursor!);
  assert.equal(second.turnCount, 5);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(service.apply('admin', second.planId!), { restoredCount: 5 });
  const empty = await service.preview('admin');
  assert.equal(empty.turnCount, 0);
  assert.equal(empty.planId, null);
  assert.deepEqual(empty.issues, []);
});

test('首批全部缺日志仍可下一批，单条正文损坏也不阻断同线程的可用记录', async (t) => {
  const { db, loadTurns } = await fixture(t, 24);
  const service = createOnlineTerminalRepair({ db: () => db, loadTurns: async (thread, turns) => {
    if (Number(thread.match(/extra-(\d+)/)?.[1]) < 20) throw new Error('C:/private/missing.jsonl');
    return loadTurns(thread, turns);
  }, backup: () => {}, persist: () => {}, publish: () => {} });
  const first = await service.preview('admin');
  assert.equal(first.turnCount, 0); assert.equal(first.issues.length, 20); assert.ok(first.nextCursor);
  assert.equal(JSON.stringify(first).includes('private'), false);
  const next = await service.preview('admin', first.nextCursor!);
  assert.equal(next.turnCount, 5);
  assert.deepEqual(service.apply('admin', next.planId!), { restoredCount: 5 });
  db.run("UPDATE sessions SET engine_session_id='shared-thread' WHERE id IN ('extra-000','extra-001')");
  const mixed = createOnlineTerminalRepair({ db: () => db, loadTurns: async (thread, turns) => {
    const parsed = await loadTurns(thread, turns);
    if (thread !== 'shared-thread') throw new Error('unavailable');
    parsed.items.get('extra-000-turn')![1].text = 'bad content';
    return parsed;
  }, backup: () => {}, persist: () => {}, publish: () => {} });
  const result = await mixed.preview('admin');
  assert.equal(result.turnCount, 1);
  assert.equal(result.issues.length, 19);
  assert.deepEqual(mixed.apply('admin', result.planId!), { restoredCount: 1 });
});

for (const withDraft of [false, true]) test(`默认恢复落盘使用完整原子快照（存在草稿：${withDraft}）`, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repair-save-'));
  const filename = path.join(directory, 'relay.db');
  t.after(() => { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); });
  const { db, loadTurns, final } = await fixture(t, 0, filename);
  if (withDraft) db.run("INSERT INTO sessions (id,engine,status,owner_user_id) VALUES ('draft','codex','idle','admin')");
  db.saveToFile();
  db.exec('PRAGMA foreign_keys = ON');
  const service = createOnlineTerminalRepair({ db: () => db, loadTurns, backup: () => {}, publish: () => {} });
  const plan = await service.preview('admin');
  assert.deepEqual(service.apply('admin', plan.planId!), { restoredCount: 1 });
  assert.equal(db.get('PRAGMA foreign_keys')?.foreign_keys, 1);
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const persisted = new SQL.Database(fs.readFileSync(filename));
  try {
    assert.equal(persisted.exec("SELECT content FROM messages WHERE session_id='own' AND content<>''")[0].values[0][0], final);
    assert.equal(persisted.exec('PRAGMA integrity_check')[0].values[0][0], 'ok');
    assert.equal(persisted.exec("SELECT COUNT(*) FROM sessions WHERE id='draft'")[0].values[0][0], 0);
    assert.equal(db.get("SELECT COUNT(*) n FROM sessions WHERE id='draft'")?.n, withDraft ? 1 : 0);
  } finally { persisted.close(); }
  assert.deepEqual(fs.readdirSync(directory), ['relay.db']);
});
