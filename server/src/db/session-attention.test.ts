import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import path from 'node:path';
import { SQLiteDB } from './index.js';
import type { Session } from './query-types.js';
import { ensureSessionReadReceipts, listSessionReadReceipts, markSessionResultRead, withSessionResults } from './session-attention.js';

test('已读按用户与结果消息隔离，旧回合确认不能清除新结果且不改执行状态', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw);
  let saves = 0;
  db.saveToFile = () => { saves++; };
  try {
    raw.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, status TEXT, deleted_at INTEGER);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, role TEXT, metadata TEXT, phase TEXT, stopped INTEGER, created_at INTEGER, content TEXT);
      INSERT INTO users VALUES ('owner'), ('viewer');
      INSERT INTO sessions VALUES ('s', 'completed', NULL);
      INSERT INTO messages VALUES ('result-1', 's', 'turn-1', 'assistant', '{"outcome":"completed","executionStage":"responding"}', 'final_answer', 0, 1, '回复');`);
    ensureSessionReadReceipts(db);
    ensureSessionReadReceipts(db);
    assert.equal(markSessionResultRead(db, 'viewer', 's', 'result-1'), true);
    assert.deepEqual(listSessionReadReceipts(db, 'owner'), {});
    assert.deepEqual(listSessionReadReceipts(db, 'viewer'), { s: 'result-1' });
    assert.equal(db.get("SELECT status FROM sessions WHERE id = 's'")?.status, 'completed');
    assert.equal(markSessionResultRead(db, 'viewer', 's', 'result-1'), true);
    assert.equal(saves, 1);
    db.run(`INSERT INTO messages VALUES ('result-2', 's', 'turn-2', 'assistant', '{"outcome":"failed"}', 'error', 0, 2, '')`);
    assert.equal(markSessionResultRead(db, 'viewer', 's', 'result-1'), false);
    const [session] = withSessionResults(db, [{ id: 's', status: 'processing' } as Session]);
    assert.equal(session.status, 'processing');
    assert.equal(session.last_result?.messageId, 'result-2');
    assert.equal(session.last_result?.status, 'failed');
    db.run(`INSERT INTO messages VALUES ('standalone', 's', 'interaction', 'assistant', '{"outcome":"completed"}', 'final_answer', 0, 3, '')`);
    assert.equal(markSessionResultRead(db, 'owner', 's', 'standalone'), false);
    db.run(`INSERT INTO messages VALUES ('new-standalone', 's', 'interaction-2', 'assistant', NULL, 'interaction', 0, 4, '')`);
    assert.equal(withSessionResults(db, [{ id: 's' } as Session])[0].last_result?.messageId, 'result-2');
    assert.equal(markSessionResultRead(db, 'owner', 's', 'new-standalone'), false);
    assert.equal(markSessionResultRead(db, 'owner', 's', 'result-2'), true);
    assert.deepEqual(listSessionReadReceipts(db, 'viewer'), { s: 'result-1' });
    db.run("DELETE FROM sessions WHERE id = 's'");
    assert.deepEqual(listSessionReadReceipts(db, 'owner'), {});
  } finally { raw.close(); }
});

test('历史结果提取支持旧消息、无结果会话和相同时间戳的新回合', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw);
  try {
    raw.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, role TEXT, metadata TEXT, phase TEXT, stopped INTEGER, created_at INTEGER, content TEXT);
      INSERT INTO sessions VALUES ('s'), ('empty');
      INSERT INTO messages VALUES ('old', 's', 'turn-1', 'assistant', NULL, 'final_answer', 0, 1, '回复');
      INSERT INTO messages VALUES ('new', 's', 'turn-2', 'assistant', '{"outcome":"interrupted"}', 'error', 0, 1, '');
      INSERT INTO messages VALUES ('standalone', 's', 'interaction', 'assistant', '{"outcome":"completed"}', 'final_answer', 0, 2, '');`);
    const rows = withSessionResults(db, [{ id: 's' }, { id: 'empty' }] as Session[]);
    assert.equal(rows[0].last_result?.messageId, 'new');
    assert.equal(rows[0].last_result?.status, 'interrupted');
    // 更晚的独立授权卡片不能把意外中断冒充成功。
    db.run("DELETE FROM messages WHERE id = 'new'");
    assert.equal(withSessionResults(db, [{ id: 's' }] as Session[])[0].last_result?.messageId, 'old');
    assert.equal(rows[1].last_result, null);
    assert.deepEqual(withSessionResults(db, []), []);
  } finally { raw.close(); }
});
