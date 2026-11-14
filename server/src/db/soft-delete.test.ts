import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  deleteProjectInDatabase,
  deleteSessionInDatabase,
  searchSessionsInDatabase,
} from './queries.js';

async function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-soft-delete-'));
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0, pinned_at INTEGER, is_system INTEGER DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, title_manually_set INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0, pinned_at INTEGER, archived INTEGER DEFAULT 0,
      project_id TEXT, engine TEXT NOT NULL DEFAULT 'codex', engine_session_id TEXT,
      engine_metadata TEXT, codex_thread_id TEXT, codex_archived INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle', token_usage TEXT, active_turn_usage TEXT,
      active_turn_id TEXT, active_turn_started_at INTEGER, recovery_previous_status TEXT,
      message_revision INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, phase TEXT, items TEXT, metadata TEXT,
      created_at INTEGER NOT NULL, duration INTEGER, stopped INTEGER DEFAULT 0
    );
    CREATE TABLE shared_records (id TEXT PRIMARY KEY, source_session_id TEXT);
    CREATE TABLE sidebar_order_items (scope TEXT, item_type TEXT, item_id TEXT, position INTEGER);
    CREATE TABLE sidebar_order_scopes (scope TEXT PRIMARY KEY, updated_at INTEGER);
    INSERT INTO projects VALUES ('project-1', '项目', 'D:/work', 1, 1, 0, NULL, 0, NULL);
    INSERT INTO sessions (
      id, title, created_at, updated_at, project_id, engine, status, deleted_at
    ) VALUES
      ('session-1', '键盘研究', 1, 2, 'project-1', 'codex', 'idle', NULL),
      ('session-2', '另一个会话', 2, 3, 'project-1', 'codex', 'idle', NULL);
    INSERT INTO messages (id, session_id, turn_id, role, content, created_at)
      VALUES ('message-1', 'session-1', 'turn-1', 'user', '机械键盘', 2);
    INSERT INTO shared_records VALUES ('share-1', 'session-1');
  `);
  return {
    directory,
    raw,
    db: new SQLiteDB(raw, path.join(directory, 'relay.db')),
    cleanup() { raw.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test('删除会话只标记 deleted_at 并保留消息与分享来源', async () => {
  const current = await createHarness();
  try {
    deleteSessionInDatabase(current.db, 'session-1', 100);
    assert.equal(current.db.get("SELECT deleted_at FROM sessions WHERE id = 'session-1'")?.deleted_at != null, true);
    assert.equal(current.db.get("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'session-1'")?.count, 1);
    assert.equal(current.db.get("SELECT source_session_id FROM shared_records WHERE id = 'share-1'")?.source_session_id, 'session-1');
    assert.equal(getSessionInHarness(current.db, 'session-1'), undefined);
    assert.deepEqual(listSessionsInHarness(current.db).map((session) => session.id), ['session-2']);
    assert.equal(searchSessionsInDatabase(current.db, '键盘').length, 0);
  } finally { current.cleanup(); }
});

test('删除项目标记项目及其会话并保留底层内容', async () => {
  const current = await createHarness();
  try {
    deleteProjectInDatabase(current.db, 'project-1', 100);
    assert.equal(current.db.get("SELECT deleted_at FROM projects WHERE id = 'project-1'")?.deleted_at != null, true);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE project_id = ? AND deleted_at IS NOT NULL', ['project-1'])?.count, 2);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM messages')?.count, 1);
    assert.equal(current.db.get("SELECT source_session_id FROM shared_records WHERE id = 'share-1'")?.source_session_id, 'session-1');
    assert.equal(getProjectInHarness(current.db, 'project-1'), undefined);
    assert.deepEqual(listProjectsInHarness(current.db), []);
  } finally { current.cleanup(); }
});

function getSessionInHarness(db: SQLiteDB, id: string) { return db.get('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL', [id]); }
function getProjectInHarness(db: SQLiteDB, id: string) { return db.get('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL', [id]); }
function listSessionsInHarness(db: SQLiteDB) { return db.all('SELECT * FROM sessions WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC'); }
function listProjectsInHarness(db: SQLiteDB) { return db.all('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC'); }
