import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import { ensureSessionFollowupsTable, listSessionFollowups } from '../db/session-followups.js';
import { SessionFollowupDelivery, type FollowupRuntime } from './session-followup-delivery.js';

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-followup-service-'));
  t.after(() => {
    assert(root.startsWith(path.join(os.tmpdir(), 'relay-followup-service-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE projects(id TEXT PRIMARY KEY, deleted_at INTEGER);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT, deleted_at INTEGER);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    INSERT INTO users VALUES('owner');
    INSERT INTO projects VALUES('project', NULL);
    INSERT INTO sessions VALUES('session', 'project', NULL);
    INSERT INTO messages VALUES('initial', 'session');`);
  const db = new SQLiteDB(raw, path.join(root, 'relay.db'));
  ensureSessionFollowupsTable(db);
  let runtime: FollowupRuntime | null = null;
  let outcome: 'completed' | 'failed' | 'unknown' = 'completed';
  const deliveries: string[] = [];
  const accepted: string[] = [];
  const changes: string[] = [];
  const service = new SessionFollowupDelivery({
    db,
    ownerOf: () => 'owner',
    runtimeOf: () => runtime,
    recoveryOutcome: () => outcome,
    dispatch: async (record) => { deliveries.push(record.id); },
    accepted: async (record) => { accepted.push(record.id); },
    changed: (record) => { changes.push(`${record.id}:${record.state}`); },
  });
  const input = (id: string, createdAt = 1) => ({
    id, sessionId: 'session', userId: 'owner', content: id,
    attachmentsJson: '[]', replyToAsyncQuestionId: null, targetTurnId: 'turn', createdAt,
  });
  return { db, service, deliveries, accepted, changes, input, setRuntime: (value: FollowupRuntime | null) => { runtime = value; }, setOutcome: (value: typeof outcome) => { outcome = value; } };
}

test('仅所有者可提交，重复消息 ID 只引导一次', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => { calls++; return 'accepted'; } });
  await assert.rejects(f.service.submitFollowup({ ...f.input('m'), userId: 'other' }), /所有人/);
  assert.equal((await f.service.submitFollowup({ ...f.input('m'), createdAt: 2 })).state, 'steered');
  assert.equal((await f.service.submitFollowup(f.input('m'))).state, 'steered');
  assert.equal(calls, 1);
  assert.deepEqual(f.accepted, ['m']);
  assert.equal(f.deliveries.length, 0);
});

test('引导回执后持久化失败须保留不确定状态，不能谎报已加入', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => 'accepted' });
  const broken = new SessionFollowupDelivery({
    db: f.db, ownerOf: () => 'owner', runtimeOf: () => ({ isRunning: true, turnId: 'turn', steer: async () => 'accepted' }),
    recoveryOutcome: () => 'unknown', dispatch: async () => {},
    accepted: async () => { throw new Error('save failed'); }, changed: () => {},
  });
  assert.equal((await broken.submitFollowup(f.input('save-failed'))).state, 'uncertain');
  assert.equal(listSessionFollowups(f.db, 'session')[0]?.errorCode, 'STEER_MESSAGE_SAVE_FAILED');
});

test('重启时重新核对已引导消息，补齐旧版本未保存的用户消息', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => 'accepted' });
  await f.service.submitFollowup(f.input('legacy'));
  f.setRuntime(null);
  await f.service.recoverSessionFollowups();
  assert.deepEqual(f.accepted, ['legacy', 'legacy']);
});

test('旧版引导消息补存失败时显示不确定，不隐藏原内容', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => 'accepted' });
  await f.service.submitFollowup(f.input('legacy'));
  const recovering = new SessionFollowupDelivery({
    db: f.db, ownerOf: () => 'owner', runtimeOf: () => null,
    recoveryOutcome: () => 'completed', dispatch: async () => {},
    accepted: async () => { throw new Error('save failed'); }, changed: () => {},
  });
  await recovering.recoverSessionFollowups();
  assert.equal(listSessionFollowups(f.db, 'session')[0]?.state, 'uncertain');
});

test('会话或项目在回收站期间重启不恢复队列，恢复后已引导消息保持完成状态', async (t) => {
  for (const table of ['sessions', 'projects']) {
    const f = await fixture(t);
    f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => 'accepted' });
    await f.service.submitFollowup(f.input('steered'));
    f.setRuntime({ isRunning: true, turnId: 'turn' });
    await f.service.submitFollowup(f.input('queued', 2));
    f.setRuntime(null);
    f.db.run(`UPDATE ${table} SET deleted_at = 1`);
    const recovering = new SessionFollowupDelivery({
      db: f.db, ownerOf: () => 'owner', runtimeOf: () => null,
      recoveryOutcome: () => 'completed',
      dispatch: async () => { assert.fail('回收站消息不得派发'); },
      accepted: async () => { throw new Error('会话不存在'); },
      changed: () => { assert.fail('回收站消息不得改变状态'); },
    });
    await recovering.recoverSessionFollowups();
    assert.deepEqual(listSessionFollowups(f.db, 'session').map((row) => row.state), ['steered', 'queued']);
    f.db.run(`UPDATE ${table} SET deleted_at = NULL`);
    await f.service.recoverSessionFollowups();
    assert.deepEqual(listSessionFollowups(f.db, 'session').map((row) => row.state), ['steered', 'delivered']);
    assert.deepEqual(f.accepted, ['steered', 'steered']);
  }
});

test('恢复已确认引导但补存失败的历史记录，只重试保存且不重发引擎', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => 'accepted' });
  await f.service.submitFollowup(f.input('legacy'));
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => { throw new Error('timeout'); } });
  await f.service.submitFollowup(f.input('unknown', 2));
  f.db.run("UPDATE session_followups SET state = 'uncertain', error_code = 'STEER_MESSAGE_SAVE_FAILED' WHERE id = 'legacy'");
  f.setRuntime(null);
  await f.service.recoverSessionFollowups();
  await f.service.recoverSessionFollowups();
  assert.deepEqual(listSessionFollowups(f.db, 'session').map((row) => [row.state, row.errorCode]), [
    ['steered', null], ['uncertain', 'STEER_RESULT_UNKNOWN'],
  ]);
  assert.deepEqual(f.accepted, ['legacy', 'legacy', 'legacy']);
  assert.deepEqual(f.deliveries, []);
});

test('重启恢复只续发未交付队列，途中状态保持不确定', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn' });
  await f.service.submitFollowup(f.input('queued', 1));
  f.db.run("UPDATE session_followups SET state = 'steering' WHERE id = 'queued'");
  f.db.saveToFile();
  await f.service.recoverSessionFollowups();
  assert.equal(listSessionFollowups(f.db, 'session')[0]?.state, 'uncertain');
  assert.deepEqual(f.deliveries, []);
});

test('不支持引导时 FIFO 排队，成功终态只派发一条', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => 'unsupported' });
  await f.service.submitFollowup(f.input('a', 1));
  await f.service.submitFollowup(f.input('b', 2));
  assert.deepEqual(f.deliveries, []);
  f.setRuntime(null);
  await f.service.onTerminal('session', true);
  assert.deepEqual(f.deliveries, ['a']);
  assert.deepEqual(listSessionFollowups(f.db, 'session').map((row) => row.state), ['delivered', 'queued']);
});

test('同一毫秒到达的消息仍按服务端接收顺序续发', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn' });
  await f.service.submitFollowup(f.input('z', 1));
  await f.service.submitFollowup(f.input('a', 1));
  assert.deepEqual(listSessionFollowups(f.db, 'session').map((row) => row.id), ['z', 'a']);
  f.setRuntime(null);
  await f.service.onTerminal('session', true);
  assert.deepEqual(f.deliveries, ['z']);
});

test('引导结果不明不重发；失败终态暂停排队', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => { throw new Error('timeout'); } });
  assert.equal((await f.service.submitFollowup(f.input('a'))).state, 'uncertain');
  f.setRuntime({ isRunning: true, turnId: 'turn' });
  await f.service.submitFollowup(f.input('b', 2));
  f.setRuntime(null);
  await f.service.onTerminal('session', false);
  assert.deepEqual(listSessionFollowups(f.db, 'session').map((row) => row.state), ['uncertain', 'paused']);
  assert.deepEqual(f.deliveries, []);
});

test('排队消息可取消，暂停消息需显式恢复后才续发', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn' });
  await f.service.submitFollowup(f.input('cancelled', 1));
  await assert.rejects(f.service.cancelSessionFollowup('session', 'cancelled', 'other'), /所有人/);
  assert.equal((await f.service.cancelSessionFollowup('session', 'cancelled', 'owner')).state, 'cancelled');
  await f.service.submitFollowup(f.input('paused', 2));
  f.setRuntime(null);
  await f.service.onTerminal('session', false);
  assert.deepEqual(f.deliveries, []);
  await f.service.resumeSessionFollowups('session');
  assert.deepEqual(f.deliveries, ['paused']);
});

test('失败后残留的暂停消息可删除，后续项仍可继续排队', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn' });
  await f.service.submitFollowup(f.input('stale', 1));
  await f.service.submitFollowup(f.input('later', 2));
  f.setRuntime(null);
  await f.service.onTerminal('session', false);
  assert.equal((await f.service.cancelSessionFollowup('session', 'stale', 'owner')).state, 'cancelled');
  await f.service.resumeSessionFollowups('session');
  assert.deepEqual(f.deliveries, ['later']);
});

test('早到的附件或暂停消息阻挡后续引导与续发', async (t) => {
  const f = await fixture(t);
  let steers = 0;
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => { steers++; return 'accepted'; } });
  await f.service.submitFollowup({ ...f.input('attachment', 1), attachmentsJson: '[{"kind":"host_file"}]' });
  assert.equal((await f.service.submitFollowup(f.input('plain', 2))).state, 'queued');
  assert.equal(steers, 0);
  f.setRuntime(null);
  await f.service.onTerminal('session', false);
  assert.equal((await f.service.submitFollowup(f.input('later', 3))).state, 'queued');
  assert.deepEqual(f.deliveries, []);
  await f.service.resumeSessionFollowups('session');
  assert.deepEqual(f.deliveries, ['attachment']);
});

test('重启时只在确认上一轮完成后续发，失败和未知状态暂停', async (t) => {
  for (const outcome of ['completed', 'failed', 'unknown'] as const) {
    const f = await fixture(t);
    f.setRuntime({ isRunning: true, turnId: 'turn' });
    await f.service.submitFollowup(f.input(`m-${outcome}`));
    f.setRuntime(null);
    f.setOutcome(outcome);
    await f.service.recoverSessionFollowups();
    assert.deepEqual(f.deliveries, outcome === 'completed' ? [`m-${outcome}`] : []);
    assert.equal(listSessionFollowups(f.db, 'session')[0]?.state, outcome === 'completed' ? 'delivered' : 'paused');
  }
});

test('结果不确定时后续消息保持顺序，人工核对并取消后才继续', async (t) => {
  const f = await fixture(t);
  f.setRuntime({ isRunning: true, turnId: 'turn', steer: async () => { throw new Error('timeout'); } });
  await f.service.submitFollowup(f.input('uncertain', 1));
  await f.service.submitFollowup(f.input('later', 2));
  f.setRuntime(null);
  await f.service.onTerminal('session', true);
  assert.deepEqual(f.deliveries, []);
  await f.service.cancelSessionFollowup('session', 'uncertain', 'owner');
  assert.deepEqual(f.deliveries, ['later']);
});
