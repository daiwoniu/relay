import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  ensureMultiAccountSchema,
  finalizeMultiAccountOwnership,
  normalizeProjectPathForOwnership,
} from './multi-account.js';
import { ensureProjectMembersTable } from './project-members.js';
import {
  createMemberWithDefaultProjectInDatabase,
  getUserDefaultProjectInDatabase,
  setUserDefaultProjectInDatabase,
} from './queries-account.js';

async function createLegacyDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT,
      avatar_mime TEXT,
      avatar_data BLOB,
      avatar_updated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0,
      pinned_at INTEGER,
      is_system INTEGER DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL
    );
    INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
      ('admin', 'admin', 'hash', 'admin', 1, 1),
      ('member', 'member', 'hash', 'member', 2, 2);
    INSERT INTO projects VALUES
      ('workspace', 'Relay 默认项目', 'D:/relay/workspace', 1, 1, 0, NULL, 1, NULL),
      ('other', '其他项目', 'D:/shared', 2, 2, 0, NULL, 0, NULL);
    INSERT INTO sessions VALUES
      ('session-1', '历史会话', 'other', 3, 3);
  `);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-multi-account-'));
  return {
    raw,
    db: new SQLiteDB(raw, path.join(tempDir, 'relay.db')),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

test('多账号迁移把历史项目会话归管理员并为每个账号创建个人默认项目', async () => {
  const { raw, db, cleanup } = await createLegacyDatabase();
  try {
    assert.equal(ensureMultiAccountSchema(db), true);
    const result = finalizeMultiAccountOwnership(db, {
      adminUserId: 'admin',
      workspacePath: 'D:/relay/workspace',
      adminSystemProjectId: 'workspace',
      now: 10,
      createId: (userId) => `${userId}-workspace`,
    });

    assert.equal(result.createdSystemProjects, 1);
    assert.equal(db.get("SELECT owner_user_id FROM projects WHERE id = 'other'")?.owner_user_id, 'admin');
    assert.equal(db.get("SELECT owner_user_id FROM sessions WHERE id = 'session-1'")?.owner_user_id, 'admin');
    assert.equal(db.get("SELECT default_project_id FROM users WHERE id = 'admin'")?.default_project_id, 'workspace');
    assert.equal(db.get("SELECT default_project_id FROM users WHERE id = 'member'")?.default_project_id, 'member-workspace');
    assert.deepEqual(
      db.get("SELECT owner_user_id, path, is_system FROM projects WHERE id = 'member-workspace'"),
      { owner_user_id: 'member', path: 'D:/relay/workspace', is_system: 1 },
    );
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  } finally {
    raw.close();
    cleanup();
  }
});

test('项目路径只在账号内唯一并允许不同账号登记相同目录', async () => {
  const { raw, db, cleanup } = await createLegacyDatabase();
  try {
    ensureMultiAccountSchema(db);
    finalizeMultiAccountOwnership(db, {
      adminUserId: 'admin', workspacePath: 'D:/relay/workspace', adminSystemProjectId: 'workspace',
      now: 10, createId: (userId) => `${userId}-workspace`,
    });
    const normalized = normalizeProjectPathForOwnership('D:/shared');
    db.run(
      `INSERT INTO projects
       (id, name, path, normalized_path, owner_user_id, created_at, updated_at, pinned, is_system)
       VALUES (?, ?, ?, ?, ?, 20, 20, 0, 0)`,
      ['member-shared', '共享', 'D:/shared', normalized, 'member'],
    );
    assert.throws(() => db.run(
      `INSERT INTO projects
       (id, name, path, normalized_path, owner_user_id, created_at, updated_at, pinned, is_system)
       VALUES (?, ?, ?, ?, ?, 21, 21, 0, 0)`,
      ['member-shared-2', '重复', 'D:/shared', normalized, 'member'],
    ), /UNIQUE constraint failed/);
  } finally {
    raw.close();
    cleanup();
  }
});

test('迁移幂等且共享项目成员会话可保留本人所有者', async () => {
  const first = await createLegacyDatabase();
  try {
    ensureMultiAccountSchema(first.db);
    const options = {
      adminUserId: 'admin', workspacePath: 'D:/relay/workspace', adminSystemProjectId: 'workspace',
      now: 10, createId: (userId: string) => `${userId}-workspace`,
    };
    finalizeMultiAccountOwnership(first.db, options);
    // 成员被授权协作 admin 的项目后，在其中创建归属自己的会话（与 projects.owner_user_id 不同）。
    ensureProjectMembersTable(first.db);
    first.db.run(
      "INSERT INTO project_members (project_id, user_id, role, can_view_sessions, created_at, updated_at) VALUES ('workspace', 'member', 'collaborator', 0, 20, 20)",
    );
    first.db.run(
      "INSERT INTO sessions (id, title, project_id, owner_user_id, created_at, updated_at) VALUES ('member-session', '成员会话', 'workspace', 'member', 20, 20)",
    );
    assert.equal(first.db.get("SELECT owner_user_id FROM sessions WHERE id = 'member-session'")?.owner_user_id, 'member');
    // 重启路径：再次执行所有权收口不得因会话与项目所有者不同而失败。
    const rerun = finalizeMultiAccountOwnership(first.db, options);
    assert.equal(rerun.createdSystemProjects, 0);
    assert.equal(first.db.get("SELECT owner_user_id FROM sessions WHERE id = 'member-session'")?.owner_user_id, 'member');
    assert.deepEqual(first.db.all('PRAGMA foreign_key_check'), []);
  } finally {
    first.raw.close();
    first.cleanup();
  }
});

test('多账号迁移幂等且失败时回滚所有归属写入', async () => {
  const first = await createLegacyDatabase();
  try {
    ensureMultiAccountSchema(first.db);
    const options = {
      adminUserId: 'admin', workspacePath: 'D:/relay/workspace', adminSystemProjectId: 'workspace',
      now: 10, createId: (userId: string) => `${userId}-workspace`,
    };
    finalizeMultiAccountOwnership(first.db, options);
    assert.equal(ensureMultiAccountSchema(first.db), false);
    const originalSave = first.db.saveToFile.bind(first.db);
    let saves = 0;
    first.db.saveToFile = () => { saves += 1; originalSave(); };
    assert.equal(finalizeMultiAccountOwnership(first.db, options).createdSystemProjects, 0);
    assert.equal(saves, 0, '无变更时不应再次导出整库');
    first.db.run("UPDATE projects SET is_system = 0 WHERE id = 'workspace'");
    finalizeMultiAccountOwnership(first.db, options);
    assert.equal(saves, 1, '修复默认项目时仍须持久化');
    assert.equal(first.db.get("SELECT is_system FROM projects WHERE id = 'workspace'")?.is_system, 1);
    assert.equal(first.db.get('SELECT COUNT(*) AS count FROM projects')?.count, 3);
  } finally {
    first.raw.close();
    first.cleanup();
  }

  const second = await createLegacyDatabase();
  try {
    ensureMultiAccountSchema(second.db);
    assert.throws(() => finalizeMultiAccountOwnership(second.db, {
      adminUserId: 'admin', workspacePath: 'D:/relay/workspace', adminSystemProjectId: 'workspace',
      now: 10, createId: (userId) => `${userId}-workspace`,
      beforeCommit: () => { throw new Error('模拟失败'); },
    }), /模拟失败/);
    assert.equal(second.db.get("SELECT owner_user_id FROM projects WHERE id = 'other'")?.owner_user_id, null);
    assert.equal(second.db.get("SELECT default_project_id FROM users WHERE id = 'member'")?.default_project_id, null);
    assert.equal(second.db.get('SELECT COUNT(*) AS count FROM projects')?.count, 2);
  } finally {
    second.raw.close();
    second.cleanup();
  }
});

test('多账号结构迁移失败时回滚全部字段和表重建', async () => {
  const fixture = await createLegacyDatabase();
  try {
    assert.throws(
      () => ensureMultiAccountSchema(fixture.db, { beforeCommit: () => { throw new Error('结构迁移失败'); } }),
      /结构迁移失败/,
    );
    assert.equal(fixture.db.all('PRAGMA table_info(users)').some((column) => column.name === 'default_project_id'), false);
    assert.equal(fixture.db.all('PRAGMA table_info(projects)').some((column) => column.name === 'owner_user_id'), false);
    assert.equal(fixture.db.all('PRAGMA table_info(sessions)').some((column) => column.name === 'owner_user_id'), false);
    assert.equal(fixture.db.get('PRAGMA foreign_keys')?.foreign_keys, 1);
    assert.equal(fixture.db.get('SELECT COUNT(*) AS count FROM projects')?.count, 2);
  } finally {
    fixture.raw.close();
    fixture.cleanup();
  }
});

test('创建成员原子创建个人 Relay 默认项目且默认可选本人或授权协作项目', async () => {
  const fixture = await createLegacyDatabase();
  try {
    ensureMultiAccountSchema(fixture.db);
    finalizeMultiAccountOwnership(fixture.db, {
      adminUserId: 'admin', workspacePath: 'D:/relay/workspace', adminSystemProjectId: 'workspace',
      now: 10, createId: (userId) => `${userId}-workspace`,
    });
    const created = createMemberWithDefaultProjectInDatabase(fixture.db, {
      username: 'new-member', passwordHash: 'temporary-hash', displayName: '新成员',
      workspacePath: 'D:/relay/workspace', userId: 'new-member', projectId: 'new-member-workspace', now: 20,
    });
    assert.equal(created.user.role, 'member');
    assert.equal(created.user.must_change_password, 1);
    assert.equal(created.user.default_project_id, 'new-member-workspace');
    assert.equal(created.project.owner_user_id, 'new-member');
    ensureProjectMembersTable(fixture.db);
    assert.equal(getUserDefaultProjectInDatabase(fixture.db, 'new-member')?.id, 'new-member-workspace');
    assert.throws(
      () => setUserDefaultProjectInDatabase(fixture.db, 'new-member', 'workspace'),
      /账号可创建会话的有效项目/,
    );
    fixture.db.run(
      "INSERT INTO project_members (project_id, user_id, role, can_view_sessions, created_at, updated_at) VALUES ('workspace', 'new-member', 'collaborator', 0, 20, 20)",
    );
    assert.equal(setUserDefaultProjectInDatabase(fixture.db, 'new-member', 'workspace').id, 'workspace');
    assert.equal(getUserDefaultProjectInDatabase(fixture.db, 'new-member')?.id, 'workspace');
    assert.throws(() => createMemberWithDefaultProjectInDatabase(fixture.db, {
      username: 'rolled-back', passwordHash: 'temporary-hash', workspacePath: 'D:/relay/workspace',
      userId: 'rolled-back', projectId: 'workspace', now: 30,
    }), /UNIQUE constraint failed/);
    assert.equal(fixture.db.get("SELECT id FROM users WHERE id = 'rolled-back'"), undefined);
  } finally {
    fixture.raw.close();
    fixture.cleanup();
  }
});

test('历史数据库副本迁移演练保留内存空会话归属并允许跨账号重复 realpath', async () => {
  const source = await createLegacyDatabase();
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const copiedRaw = new SQL.Database(source.raw.export());
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-migration-copy-'));
  const copied = new SQLiteDB(copiedRaw, path.join(copyDir, 'relay.db'));
  try {
    ensureMultiAccountSchema(copied);
    finalizeMultiAccountOwnership(copied, {
      adminUserId: 'admin', workspacePath: 'D:/relay/workspace', adminSystemProjectId: 'workspace',
      now: 20, createId: (userId) => `${userId}-workspace`,
    });
    assert.equal(copied.get("SELECT owner_user_id FROM sessions WHERE id = 'session-1'")?.owner_user_id, 'admin');
    const normalized = normalizeProjectPathForOwnership('D:/shared');
    copied.run(
      `INSERT INTO projects
       (id, name, path, normalized_path, owner_user_id, created_at, updated_at, pinned, is_system)
       VALUES ('member-shared-copy', '共享副本', 'D:/shared', ?, 'member', 30, 30, 0, 0)`,
      [normalized],
    );
    assert.deepEqual(copied.all("SELECT owner_user_id FROM projects WHERE normalized_path = ? ORDER BY owner_user_id", [normalized]), [
      { owner_user_id: 'admin' }, { owner_user_id: 'member' },
    ]);
    assert.equal(copied.get("SELECT default_project_id FROM users WHERE id = 'member'")?.default_project_id, 'member-workspace');
    assert.deepEqual(copied.all('PRAGMA foreign_key_check'), []);
  } finally {
    copiedRaw.close();
    source.raw.close();
    source.cleanup();
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
});
