import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { appendAdminAuditEventInDatabase, ensureAdminAuditTable } from './admin-audit.js';

async function fixture() {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    INSERT INTO users VALUES ('admin', 'admin'), ('member-a', 'member'), ('member-b', 'member');
  `);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-admin-audit-'));
  return { raw, db: new SQLiteDB(raw, path.join(directory, 'relay.db')), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('管理员代操作只保存固定、无正文的最小元数据', async () => {
  const { raw, db, cleanup } = await fixture();
  try {
    assert.equal(ensureAdminAuditTable(db), true);
    assert.equal(ensureAdminAuditTable(db), false);
    assert.equal(appendAdminAuditEventInDatabase(db, {
      actorUserId: 'admin', action: 'session.delete', resourceType: 'session',
      resourceId: 'session-a', ownerUserId: 'member-a', occurredAt: 123,
    }, () => 'audit-1'), true);
    assert.deepEqual(db.all('SELECT * FROM admin_audit_events'), [{
      id: 'audit-1', actor_user_id: 'admin', action: 'session.delete', resource_type: 'session',
      resource_id: 'session-a', owner_user_id: 'member-a', result: 'succeeded', occurred_at: 123,
    }]);
    const columns = db.all('PRAGMA table_info(admin_audit_events)').map((row) => row.name);
    for (const forbidden of ['content', 'body', 'command', 'path', 'password', 'token', 'cookie', 'payload']) {
      assert.equal(columns.includes(forbidden), false);
    }
  } finally { raw.close(); cleanup(); }
});

test('既有审计表升级结果字段和新增动作且保留历史记录', async () => {
  const { raw, db, cleanup } = await fixture();
  try {
    db.exec(`
      CREATE TABLE admin_audit_events (
        id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL, action TEXT NOT NULL,
        resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      INSERT INTO admin_audit_events VALUES ('old-1', 'admin', 'session.delete', 'session', 's-1', 'member-a', 100);
    `);
    assert.equal(ensureAdminAuditTable(db), true);
    assert.equal(db.get("SELECT result FROM admin_audit_events WHERE id = 'old-1'")?.result, 'succeeded');
    assert.equal(appendAdminAuditEventInDatabase(db, {
      actorUserId: 'admin', action: 'session.send', resourceType: 'session', resourceId: 's-1',
      ownerUserId: 'member-a', result: 'failed', occurredAt: 200,
    }, () => 'new-1'), true);
    assert.equal(db.get("SELECT result FROM admin_audit_events WHERE id = 'new-1'")?.result, 'failed');
  } finally { raw.close(); cleanup(); }
});

test('审计拒绝自由字段、普通成员和非白名单动作，同所有者操作不留记录', async () => {
  const { raw, db, cleanup } = await fixture();
  try {
    ensureAdminAuditTable(db);
    assert.throws(() => appendAdminAuditEventInDatabase(db, {
      actorUserId: 'admin', action: 'project.delete', resourceType: 'project', resourceId: 'p', ownerUserId: 'member-a',
      password: 'secret',
    } as never), /固定元数据/);
    assert.throws(() => appendAdminAuditEventInDatabase(db, {
      actorUserId: 'member-b', action: 'project.delete', resourceType: 'project', resourceId: 'p', ownerUserId: 'member-a',
    }), /只有管理员/);
    assert.throws(() => appendAdminAuditEventInDatabase(db, {
      actorUserId: 'admin', action: 'message.read', resourceType: 'session', resourceId: 's', ownerUserId: 'member-a',
    } as never), /白名单/);
    assert.equal(appendAdminAuditEventInDatabase(db, {
      actorUserId: 'admin', action: 'project.update', resourceType: 'project', resourceId: 'p', ownerUserId: 'admin',
    }), false);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM admin_audit_events')?.count, 0);
  } finally { raw.close(); cleanup(); }
});
