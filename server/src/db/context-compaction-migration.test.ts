import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { backfillContextCompactionEvents, ensureContextCompactionStorage } from './context-compaction.js';

test('旧数据库迁移保留会话并补齐上下文自动整理计数与幂等事实表', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-context-compaction-migration-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const previousDbPath = process.env.RELAY_DB_PATH;

  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const legacy = new SQL.Database();
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER DEFAULT 0, is_system INTEGER DEFAULT 0);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, project_id TEXT, codex_thread_id TEXT, codex_archived INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle', token_usage TEXT, active_turn_usage TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, phase TEXT, items TEXT, metadata TEXT, created_at INTEGER NOT NULL, duration INTEGER, stopped INTEGER DEFAULT 0);
      INSERT INTO projects VALUES ('project-1', '项目', 'D:\\work', 1, 1, 0, 1);
      INSERT INTO sessions (id, title, created_at, updated_at, project_id, codex_archived) VALUES ('session-1', '保留的会话', 1, 2, 'project-1', 1);
      INSERT INTO messages (id, session_id, turn_id, role, content, created_at) VALUES ('message-1', 'session-1', 'turn-1', 'user', '保留的消息', 1);
    `);
    fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
    legacy.close();

    process.env.RELAY_DB_PATH = dbPath;
    const { initDB } = await import('./index.js');
    const db = await initDB();

    assert.equal(db.get("SELECT context_compaction_count FROM sessions WHERE id = 'session-1'")?.context_compaction_count, 0);
    assert.equal(db.get("SELECT codex_archived_for_trash FROM sessions WHERE id = 'session-1'")?.codex_archived_for_trash, 0);
    assert.equal(db.get("SELECT title FROM sessions WHERE id = 'session-1'")?.title, '保留的会话');
    assert.ok(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_compaction_events'"));
    assert.doesNotThrow(() => ensureContextCompactionStorage(db));
  } finally {
    if (previousDbPath === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = previousDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('历史 contextCompaction 过程项只补记一次且忽略正文误命中', async () => {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, engine_session_id TEXT, codex_thread_id TEXT, context_compaction_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, items TEXT);
    INSERT INTO sessions VALUES ('session-1', 'thread-1', 'thread-1', 0);
    INSERT INTO messages VALUES ('message-1', 'session-1', 'turn-1', '[{"id":"compact-1","type":"contextCompaction","status":"completed"}]');
    INSERT INTO messages VALUES ('message-2', 'session-1', 'turn-2', '[{"id":"answer-1","type":"agentMessage","text":"contextCompaction"}]');
  `);
  const { SQLiteDB } = await import('./index.js');
  const db = new SQLiteDB(raw, ':memory:');
  ensureContextCompactionStorage(db);

  assert.equal(backfillContextCompactionEvents(db), 1);
  assert.equal(backfillContextCompactionEvents(db), 0);
  assert.equal(db.get("SELECT context_compaction_count FROM sessions WHERE id = 'session-1'")?.context_compaction_count, 1);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM context_compaction_events')?.count, 1);
  raw.close();
});
