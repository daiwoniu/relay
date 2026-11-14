import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { ensureProjectMembersTable } from './project-members.js';

async function createLegacyMembersDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const raw = new SQL.Database();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-members-'));
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      members_can_view_sessions INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, user_id)
    );
    INSERT INTO users VALUES ('owner', 'owner', 'hash', 'admin', 1, 1);
    INSERT INTO users VALUES ('member', 'member', 'hash', 'member', 1, 1);
    INSERT INTO projects VALUES ('project-a', 'A', 'D:/a', 1, 1, 1);
    INSERT INTO project_members VALUES ('project-a', 'member', 'collaborator', 1, 1);
  `);
  return {
    raw,
    db: new SQLiteDB(raw, path.join(tempDir, 'relay.db')),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

test('项目成员表迁移补齐按账号查看全部会话字段并回填旧项目开关', async () => {
  const fixture = await createLegacyMembersDatabase();
  try {
    assert.equal(ensureProjectMembersTable(fixture.db), true);
    assert.equal(
      fixture.db.get("SELECT can_view_sessions FROM project_members WHERE project_id = 'project-a' AND user_id = 'member'")?.can_view_sessions,
      1,
    );
    assert.equal(ensureProjectMembersTable(fixture.db), false);
  } finally {
    fixture.raw.close();
    fixture.cleanup();
  }
});