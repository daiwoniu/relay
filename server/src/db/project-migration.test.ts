import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { migrateDefaultProjectInDatabase } from './queries.js';

test('迁移默认项目时保留项目 ID、会话和消息并合并重复项目', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-migration-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({
    locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);

  try {
    raw.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        normalized_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        pinned INTEGER DEFAULT 0,
        is_system INTEGER DEFAULT 0
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE sidebar_order_scopes (
        scope TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sidebar_order_items (
        scope TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(scope, item_type, item_id)
      );
    `);
    db.run(
      'INSERT INTO projects (id, name, path, normalized_path, created_at, updated_at, is_system) VALUES (?, ?, ?, ?, 1, 1, ?)',
      ['legacy-id', 'daiwoniu-relay', 'D:\\relay', 'd:\\relay', 1],
    );
    db.run(
      'INSERT INTO projects (id, name, path, normalized_path, created_at, updated_at, is_system) VALUES (?, ?, ?, ?, 1, 1, ?)',
      ['duplicate-id', 'workspace', 'D:\\relay\\workspace', 'd:\\relay\\workspace', 0],
    );
    db.run('INSERT INTO sessions (id, title, project_id) VALUES (?, ?, ?)', ['legacy-session', '旧会话', 'legacy-id']);
    db.run('INSERT INTO sessions (id, title, project_id) VALUES (?, ?, ?)', ['duplicate-session', '重复项目会话', 'duplicate-id']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-1', 'legacy-session', '旧消息']);
    db.run('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)', ['message-2', 'duplicate-session', '重复项目消息']);

    migrateDefaultProjectInDatabase(db, 'legacy-id', 'D:\\relay\\workspace', 'Relay 工作区', 'duplicate-id');

    assert.equal(db.get('SELECT COUNT(*) AS count FROM projects')?.count, 1);
    assert.deepEqual(
      db.get('SELECT id, name, path, is_system FROM projects WHERE id = ?', ['legacy-id']),
      { id: 'legacy-id', name: 'Relay 工作区', path: 'D:\\relay\\workspace', is_system: 1 },
    );
    assert.equal(db.get('SELECT project_id FROM sessions WHERE id = ?', ['legacy-session'])?.project_id, 'legacy-id');
    assert.equal(db.get('SELECT project_id FROM sessions WHERE id = ?', ['duplicate-session'])?.project_id, 'legacy-id');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM messages')?.count, 2);
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
