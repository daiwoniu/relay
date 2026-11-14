import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';

test('现有会话迁移后统一保持自动标题状态', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-title-migration-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const previousDbPath = process.env.RELAY_DB_PATH;

  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const legacy = new SQL.Database();
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        pinned INTEGER DEFAULT 0,
        is_system INTEGER DEFAULT 0
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '新对话',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        pinned INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        project_id TEXT,
        codex_thread_id TEXT,
        codex_archived INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        token_usage TEXT,
        active_turn_usage TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        phase TEXT,
        items TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        duration INTEGER,
        stopped INTEGER DEFAULT 0
      );
      INSERT INTO projects (id, name, path, created_at, updated_at, is_system)
      VALUES ('project-1', '项目', 'D:\\work', 1, 1, 1);
      INSERT INTO sessions (id, title, created_at, updated_at, project_id)
      VALUES ('session-1', '现有标题', 1, 1, 'project-1');
      INSERT INTO messages (id, session_id, turn_id, role, content, created_at)
      VALUES ('message-1', 'session-1', 'turn-1', 'user', '第一条消息', 1);
    `);
    fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
    legacy.close();

    process.env.RELAY_DB_PATH = dbPath;
    const { initDB } = await import('./index.js');
    const db = await initDB();
    const migrated = db.get('SELECT title_manually_set FROM sessions WHERE id = ?', ['session-1']);

    assert.equal(migrated?.title_manually_set, 0);
  } finally {
    if (previousDbPath === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = previousDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
