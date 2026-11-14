import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { countActiveSessionsByEngineInDatabase, countActiveSessionsByProjectInDatabase, countActiveSessionsInDatabase, prepareRecoverableSessionsInDatabase } from './queries.js';

test('服务重启时把遗留运行态标记为恢复中并保留恢复上下文', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-session-status-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, engine TEXT NOT NULL DEFAULT 'codex', engine_session_id TEXT, status TEXT NOT NULL, updated_at INTEGER NOT NULL, recovery_previous_status TEXT, codex_thread_id TEXT, active_turn_id TEXT, active_attempt_id TEXT, active_turn_started_at INTEGER, active_turn_usage TEXT, token_usage TEXT, deleted_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE engine_resource_leases (attempt_id TEXT PRIMARY KEY, resource_key TEXT NOT NULL, lease_token TEXT NOT NULL);
    `);
    db.run("INSERT INTO sessions (id, status, updated_at) VALUES ('pending', 'pending', 1)");
    db.run("INSERT INTO sessions (id, status, updated_at, codex_thread_id, engine_session_id, active_turn_id, active_attempt_id, active_turn_started_at, active_turn_usage, token_usage) VALUES ('running', 'processing', 1, 'thread-1', 'thread-1', 'turn-1', 'attempt-running', 1234, ?, ?)", [
      JSON.stringify({ inputTokens: 1200, cachedInputTokens: 800, outputTokens: 260, reasoningOutputTokens: 80, totalTokens: 1460, modelContextWindow: 200000 }),
      JSON.stringify({ inputTokens: 1200, cachedInputTokens: 800, outputTokens: 160, reasoningOutputTokens: 40, totalTokens: 1360, modelContextWindow: 200000 }),
    ]);
    db.run("INSERT INTO engine_resource_leases VALUES ('attempt-running', 'codex:default', 'lease-running')");
    db.run("INSERT INTO sessions (id, status, updated_at) VALUES ('awaiting', 'awaiting_action', 1)");
    db.run("INSERT INTO sessions (id, status, updated_at) VALUES ('stopping', 'stopping', 1)");
    db.run("INSERT INTO sessions (id, status, updated_at) VALUES ('done', 'completed', 1)");

    const recoverable = prepareRecoverableSessionsInDatabase(db);

    assert.equal(db.get("SELECT status FROM sessions WHERE id = 'pending'")?.status, 'recovering');
    assert.equal(db.get("SELECT status FROM sessions WHERE id = 'running'")?.status, 'recovering');
    assert.notEqual(db.get("SELECT active_turn_usage FROM sessions WHERE id = 'running'")?.active_turn_usage, null);
    assert.equal(db.get("SELECT status FROM sessions WHERE id = 'awaiting'")?.status, 'recovering');
    assert.equal(db.get("SELECT status FROM sessions WHERE id = 'stopping'")?.status, 'recovering');
    assert.equal(db.get("SELECT status FROM sessions WHERE id = 'done'")?.status, 'completed');
    assert.deepEqual(recoverable, [
      { id: 'pending', engine: 'codex', previousStatus: 'pending', externalSessionId: null, turnId: null, attemptId: 'legacy:pending:none:none', startedAt: null },
      { id: 'running', engine: 'codex', previousStatus: 'processing', externalSessionId: 'thread-1', turnId: 'turn-1', attemptId: 'attempt-running', startedAt: 1234, resourceKey: 'codex:default', leaseToken: 'lease-running', tokenUsage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 260, reasoningOutputTokens: 80, totalTokens: 1460, modelContextWindow: 200000 }, latestTokenUsage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 160, reasoningOutputTokens: 40, totalTokens: 1360, modelContextWindow: 200000 } },
      { id: 'awaiting', engine: 'codex', previousStatus: 'awaiting_action', externalSessionId: null, turnId: null, attemptId: 'legacy:awaiting:none:none', startedAt: null },
      { id: 'stopping', engine: 'codex', previousStatus: 'stopping', externalSessionId: null, turnId: null, attemptId: 'legacy:stopping:none:none', startedAt: null },
    ]);
    const repeated = prepareRecoverableSessionsInDatabase(db);
    assert.equal(repeated.find((session) => session.id === 'stopping')?.previousStatus, 'stopping');
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('活动会话计数包含恢复中状态', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-active-session-count-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, deleted_at INTEGER)');
    for (const [id, status] of [
      ['pending', 'pending'],
      ['processing', 'processing'],
      ['recovering', 'recovering'],
      ['awaiting', 'awaiting_action'],
      ['stopping', 'stopping'],
      ['idle', 'idle'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['stopped', 'stopped'],
      ['interrupted', 'interrupted'],
    ]) {
      db.run('INSERT INTO sessions (id, status) VALUES (?, ?)', [id, status]);
    }
    assert.equal(countActiveSessionsInDatabase(db), 5);
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('恢复准备拒绝把未知引擎静默降级为 Codex', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-session-unknown-engine-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, engine TEXT NOT NULL, engine_session_id TEXT, status TEXT NOT NULL, updated_at INTEGER NOT NULL, recovery_previous_status TEXT, active_turn_id TEXT, active_attempt_id TEXT, active_turn_started_at INTEGER, active_turn_usage TEXT, token_usage TEXT, deleted_at INTEGER);
      INSERT INTO sessions (id, engine, status, updated_at) VALUES ('unknown', 'future-engine', 'processing', 1);
    `);

    assert.throws(
      () => prepareRecoverableSessionsInDatabase(db),
      /恢复会话包含不受支持的引擎 ID：future-engine/,
    );
    assert.equal(db.get("SELECT status FROM sessions WHERE id = 'unknown'")?.status, 'processing');
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('项目活动会话计数不会锁定其他项目的上传文件清理', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-active-count-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);
  try {
    raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, status TEXT NOT NULL, deleted_at INTEGER)');
    db.run("INSERT INTO sessions (id, project_id, status) VALUES ('a', 'project-a', 'processing')");
    db.run("INSERT INTO sessions (id, project_id, status) VALUES ('b', 'project-b', 'idle')");
    assert.equal(countActiveSessionsByProjectInDatabase(db, 'project-a'), 1);
    assert.equal(countActiveSessionsByProjectInDatabase(db, 'project-b'), 0);
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('活动会话按引擎独立计数', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-engine-active-count-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);
  try {
    raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, engine TEXT NOT NULL, status TEXT NOT NULL, deleted_at INTEGER)');
    db.run("INSERT INTO sessions (id, engine, status) VALUES ('codex-active', 'codex', 'processing')");
    db.run("INSERT INTO sessions (id, engine, status) VALUES ('codex-idle', 'codex', 'idle')");
    db.run("INSERT INTO sessions (id, engine, status) VALUES ('buddy-active', 'codebuddy', 'recovering')");
    assert.equal(countActiveSessionsByEngineInDatabase(db, 'codex'), 1);
    assert.equal(countActiveSessionsByEngineInDatabase(db, 'codebuddy'), 1);
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
