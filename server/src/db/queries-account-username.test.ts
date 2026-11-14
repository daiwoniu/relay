import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { updateUserUsernameAndDeleteOtherSessionsInDatabase } from './queries-account.js';

async function createDatabase(): Promise<{ db: SQLiteDB; close: () => void }> {
  const SQL = await initSqlJs({ locateFile: () => 'node_modules/sql.js/dist/sql-wasm.wasm' });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, ':memory:');
  db.saveToFile = () => undefined;
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, deleted_at INTEGER);
    CREATE TABLE messages (session_id TEXT NOT NULL);
    INSERT INTO users VALUES ('u1', 'old-name', 'hash', 'admin', 1, 1);
    INSERT INTO auth_sessions VALUES ('current-token', 'u1', 999, 1);
    INSERT INTO auth_sessions VALUES ('other-token', 'u1', 999, 1);
  `);
  return { db, close: () => raw.close() };
}

test('修改登录名成功时保留当前会话并删除其他会话', async () => {
  const { db, close } = await createDatabase();
  try {
    const result = updateUserUsernameAndDeleteOtherSessionsInDatabase(db, 'u1', 'new-name', 'current-token');
    assert.equal(result.user.username, 'new-name');
    assert.deepEqual(result.tokenHashes, ['other-token']);
    assert.deepEqual(db.all('SELECT token_hash FROM auth_sessions ORDER BY token_hash'), [{ token_hash: 'current-token' }]);
  } finally {
    close();
  }
});

test('删除其他会话失败时回滚登录名和全部会话', async () => {
  const { db, close } = await createDatabase();
  try {
    db.exec(`
      CREATE TRIGGER force_session_delete_failure
      BEFORE DELETE ON auth_sessions
      BEGIN
        SELECT RAISE(ABORT, 'forced session delete failure');
      END;
    `);
    assert.throws(
      () => updateUserUsernameAndDeleteOtherSessionsInDatabase(db, 'u1', 'new-name', 'current-token'),
      /forced session delete failure/,
    );
    assert.equal(db.get("SELECT username FROM users WHERE id = 'u1'")?.username, 'old-name');
    assert.deepEqual(db.all('SELECT token_hash FROM auth_sessions ORDER BY token_hash'), [
      { token_hash: 'current-token' },
      { token_hash: 'other-token' },
    ]);
  } finally {
    close();
  }
});
