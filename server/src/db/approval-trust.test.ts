import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import {
  createApprovalTrustRepository,
  ensureApprovalTrustSettingsTable,
  isApprovalTrustSettingActive,
} from './approval-trust.js';
import { SQLiteDB } from './index.js';

async function createDatabase() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, created_at INTEGER);
    INSERT INTO users VALUES ('user-1', 'admin', 1), ('user-2', 'member', 2);
    CREATE TABLE projects (id TEXT PRIMARY KEY, deleted_at INTEGER);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      deleted_at INTEGER
    );
    INSERT INTO projects VALUES ('project-1', NULL), ('project-2', NULL);
    INSERT INTO sessions VALUES ('session-1', 'project-1', NULL), ('session-2', 'project-2', NULL);
  `);
  const db = new SQLiteDB(raw, ':memory:');
  return { raw, db };
}

test('信任设置迁移幂等且数据库约束拒绝非法作用域与模式', async () => {
  const { raw, db } = await createDatabase();
  try {
    assert.equal(ensureApprovalTrustSettingsTable(db), true);
    assert.equal(ensureApprovalTrustSettingsTable(db), false);
    const columns = db.all('PRAGMA table_info(approval_trust_settings)').map((row) => row.name);
    assert.deepEqual(columns, [
      'id', 'owner_user_id', 'project_id', 'session_id', 'mode', 'expires_at', 'created_at', 'updated_at',
    ]);

    assert.throws(() => db.run(
      `INSERT INTO approval_trust_settings VALUES ('both', 'user-1', 'project-1', 'session-1', 'trusted', NULL, 1, 1)`,
    ));
    assert.throws(() => db.run(
      `INSERT INTO approval_trust_settings VALUES ('neither', 'user-1', NULL, NULL, 'trusted', NULL, 1, 1)`,
    ));
    assert.throws(() => db.run(
      `INSERT INTO approval_trust_settings VALUES ('project-manual', 'user-1', 'project-1', NULL, 'manual', NULL, 1, 1)`,
    ));
    assert.throws(() => db.run(
      `INSERT INTO approval_trust_settings VALUES ('bad-mode', 'user-1', NULL, 'session-1', 'future', NULL, 1, 1)`,
    ));
  } finally {
    raw.close();
  }
});

test('信任设置迁移显式启用外键级联', async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  try {
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, created_at INTEGER);
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
    `);
    const db = new SQLiteDB(raw, ':memory:');
    assert.equal(db.get('PRAGMA foreign_keys')?.foreign_keys, 0);
    ensureApprovalTrustSettingsTable(db);
    assert.equal(db.get('PRAGMA foreign_keys')?.foreign_keys, 1);
  } finally {
    raw.close();
  }
});

test('仓储 upsert 保持单行、更新时间与永久或到期语义', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureApprovalTrustSettingsTable(db);
    let saveCount = 0;
    let idSequence = 0;
    const repository = createApprovalTrustRepository(db, {
      createId: () => `setting-${idSequence += 1}`,
      save: () => { saveCount += 1; },
    });

    const project = repository.upsertProjectTrustSetting({ ownerUserId: 'user-1', projectId: 'project-1', expiresAt: null, now: 10 });
    assert.equal(project.id, 'setting-1');
    assert.equal(project.mode, 'trusted');
    assert.equal(isApprovalTrustSettingActive(project, 999), true);
    const updated = repository.upsertProjectTrustSetting({ ownerUserId: 'user-1', projectId: 'project-1', expiresAt: 50, now: 20 });
    assert.equal(updated.id, project.id);
    assert.equal(updated.createdAt, 10);
    assert.equal(updated.updatedAt, 20);
    assert.equal(isApprovalTrustSettingActive(updated, 49), true);
    assert.equal(isApprovalTrustSettingActive(updated, 50), false);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM approval_trust_settings')?.count, 1);

    const manual = repository.upsertSessionTrustSetting({
      ownerUserId: 'user-1', sessionId: 'session-1', mode: 'manual', expiresAt: null, now: 30,
    });
    assert.equal(manual.mode, 'manual');
    assert.equal(repository.getProjectTrustSetting('user-1', 'project-1')?.expiresAt, 50);
    assert.equal(repository.getSessionTrustSetting('user-1', 'session-1')?.mode, 'manual');
    assert.equal(saveCount, 3);
  } finally {
    raw.close();
  }
});

test('相同项目与会话的信任设置按设置账号完全隔离', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureApprovalTrustSettingsTable(db);
    const repository = createApprovalTrustRepository(db, { save: () => {} });
    repository.upsertProjectTrustSetting({ ownerUserId: 'user-1', projectId: 'project-1', expiresAt: null, now: 1 });
    repository.upsertProjectTrustSetting({ ownerUserId: 'user-2', projectId: 'project-1', expiresAt: 10, now: 2 });
    repository.upsertSessionTrustSetting({ ownerUserId: 'user-1', sessionId: 'session-1', mode: 'manual', expiresAt: null, now: 3 });
    repository.upsertSessionTrustSetting({ ownerUserId: 'user-2', sessionId: 'session-1', mode: 'trusted', expiresAt: null, now: 4 });

    assert.equal(repository.getProjectTrustSetting('user-1', 'project-1')?.expiresAt, null);
    assert.equal(repository.getProjectTrustSetting('user-2', 'project-1')?.expiresAt, 10);
    assert.equal(repository.getSessionTrustSetting('user-1', 'session-1')?.mode, 'manual');
    assert.equal(repository.getSessionTrustSetting('user-2', 'session-1')?.mode, 'trusted');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM approval_trust_settings')?.count, 4);
  } finally {
    raw.close();
  }
});

test('历史单账号信任设置迁移后归最早创建的管理员', async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  try {
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, created_at INTEGER);
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('admin-later', 'admin', 20), ('admin-owner', 'admin', 10);
      INSERT INTO projects VALUES ('project-1');
      CREATE TABLE approval_trust_settings (
        id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT, mode TEXT,
        expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO approval_trust_settings VALUES ('legacy', 'project-1', NULL, 'trusted', NULL, 1, 1);
    `);
    const db = new SQLiteDB(raw, ':memory:');
    assert.equal(ensureApprovalTrustSettingsTable(db), true);
    assert.equal(db.get("SELECT owner_user_id FROM approval_trust_settings WHERE id = 'legacy'")?.owner_user_id, 'admin-owner');
    assert.equal(db.all('PRAGMA table_info(approval_trust_settings)').find((row) => row.name === 'owner_user_id')?.notnull, 1);
  } finally {
    raw.close();
  }
});

test('删除、软删除保留、永久删除级联与失败事务回滚', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureApprovalTrustSettingsTable(db);
    const repository = createApprovalTrustRepository(db, { createId: (() => {
      let sequence = 0;
      return () => `setting-${sequence += 1}`;
    })(), save: () => {} });
    repository.upsertProjectTrustSetting({ ownerUserId: 'user-1', projectId: 'project-1', expiresAt: null, now: 1 });
    repository.upsertSessionTrustSetting({ ownerUserId: 'user-1', sessionId: 'session-1', mode: 'trusted', expiresAt: null, now: 1 });

    db.run('UPDATE projects SET deleted_at = 2 WHERE id = ?', ['project-1']);
    db.run('UPDATE sessions SET deleted_at = 2 WHERE id = ?', ['session-1']);
    assert.ok(repository.getProjectTrustSetting('user-1', 'project-1'));
    assert.ok(repository.getSessionTrustSetting('user-1', 'session-1'));
    db.run('UPDATE projects SET deleted_at = NULL WHERE id = ?', ['project-1']);
    db.run('UPDATE sessions SET deleted_at = NULL WHERE id = ?', ['session-1']);
    assert.ok(repository.getProjectTrustSetting('user-1', 'project-1'));

    db.exec(`CREATE TRIGGER reject_trust_update BEFORE UPDATE ON approval_trust_settings
      BEGIN SELECT RAISE(ABORT, 'reject update'); END;`);
    assert.throws(() => repository.upsertProjectTrustSetting({ ownerUserId: 'user-1', projectId: 'project-1', expiresAt: 9, now: 3 }));
    assert.equal(repository.getProjectTrustSetting('user-1', 'project-1')?.expiresAt, null);
    db.exec('DROP TRIGGER reject_trust_update');

    assert.equal(repository.deleteSessionTrustSetting('user-1', 'session-1'), true);
    assert.equal(repository.deleteSessionTrustSetting('user-1', 'session-1'), false);
    db.run('DELETE FROM projects WHERE id = ?', ['project-1']);
    assert.equal(repository.getProjectTrustSetting('user-1', 'project-1'), null);

    repository.upsertSessionTrustSetting({ ownerUserId: 'user-1', sessionId: 'session-2', mode: 'trusted', expiresAt: null, now: 4 });
    db.run('DELETE FROM sessions WHERE id = ?', ['session-2']);
    assert.equal(repository.getSessionTrustSetting('user-1', 'session-2'), null);
  } finally {
    raw.close();
  }
});

test('持久化失败时恢复新增、更新和删除前的内存状态', async () => {
  const { raw, db } = await createDatabase();
  try {
    ensureApprovalTrustSettingsTable(db);
    let failSave = true;
    const repository = createApprovalTrustRepository(db, {
      createId: (() => {
        let sequence = 0;
        return () => `setting-${sequence += 1}`;
      })(),
      save: () => {
        if (failSave) throw new Error('disk full');
      },
    });

    assert.throws(
      () => repository.upsertProjectTrustSetting({ ownerUserId: 'user-1', projectId: 'project-1', expiresAt: 100, now: 10 }),
      /disk full/,
    );
    assert.equal(repository.getProjectTrustSetting('user-1', 'project-1'), null);

    failSave = false;
    const original = repository.upsertProjectTrustSetting({ ownerUserId: 'user-1', projectId: 'project-1', expiresAt: 200, now: 20 });
    repository.upsertSessionTrustSetting({ ownerUserId: 'user-1', sessionId: 'session-1', mode: 'manual', expiresAt: null, now: 20 });
    failSave = true;

    assert.throws(
      () => repository.upsertProjectTrustSetting({ ownerUserId: 'user-1', projectId: 'project-1', expiresAt: null, now: 30 }),
      /disk full/,
    );
    assert.deepEqual(repository.getProjectTrustSetting('user-1', 'project-1'), original);

    assert.throws(() => repository.deleteProjectTrustSetting('user-1', 'project-1'), /disk full/);
    assert.deepEqual(repository.getProjectTrustSetting('user-1', 'project-1'), original);

    assert.throws(() => repository.deleteSessionTrustSetting('user-1', 'session-1'), /disk full/);
    assert.equal(repository.getSessionTrustSetting('user-1', 'session-1')?.mode, 'manual');
  } finally {
    raw.close();
  }
});
