import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { ensureUserProfileColumns } from './user-profile.js';

test('旧 users 表补齐账号资料列且保留现有用户', async () => {
  const SQL = await initSqlJs({ locateFile: () => 'node_modules/sql.js/dist/sql-wasm.wasm' });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, ':memory:');
  try {
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('u1', 'admin', 'hash', 'admin', 1, 1);
    `);
    assert.deepEqual(ensureUserProfileColumns(db), [
      'display_name', 'avatar_mime', 'avatar_data', 'avatar_updated_at', 'default_engine', 'default_model_id',
    ]);
    assert.deepEqual(ensureUserProfileColumns(db), []);
    const row = db.get("SELECT username, display_name, avatar_mime, avatar_updated_at, default_engine, default_model_id FROM users WHERE id = 'u1'");
    assert.deepEqual(row, { username: 'admin', display_name: null, avatar_mime: null, avatar_updated_at: null, default_engine: 'codex', default_model_id: null });
  } finally {
    raw.close();
  }
});
