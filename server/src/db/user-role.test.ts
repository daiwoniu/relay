import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { createUserInDatabase } from './queries.js';
import { ensureUserRoleColumn } from './user-role.js';

async function createTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-user-role-'));
  const dbPath = path.join(directory, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
  `);
  return { directory, raw, db: new SQLiteDB(raw, dbPath) };
}

test('旧 users 表增加 role 列且现有用户默认为 member', async () => {
  const { directory, raw, db } = await createTestDatabase();
  try {
    raw.exec("INSERT INTO users VALUES ('u1', 'admin', 'hash', 1, 1)");
    ensureUserRoleColumn(db);
    assert.equal(db.get("SELECT role FROM users WHERE id = 'u1'")?.role, 'member');
  } finally {
    raw.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('普通用户默认创建为 member，管理员角色必须显式指定', async () => {
  const { directory, raw, db } = await createTestDatabase();
  try {
    ensureUserRoleColumn(db);
    const member = createUserInDatabase(db, 'member-user', 'hash-1', undefined, 1, 'member-id');
    const admin = createUserInDatabase(db, 'admin-user', 'hash-2', 'admin', 2, 'admin-id');
    assert.equal(member.role, 'member');
    assert.equal(admin.role, 'admin');
  } finally {
    raw.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
