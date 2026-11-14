import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminAuditInput } from '../db/admin-audit.js';
import { beginSessionAdminAudit } from './frontend-admin-audit.js';

test('管理员操作他人会话只记录固定开始和终态，同所有者与成员不记录', () => {
  const events: AdminAuditInput[] = [];
  const record = (input: AdminAuditInput) => { events.push(input); return true; };
  const session = { id: 'session-a', owner_user_id: 'member-a' };
  const audit = beginSessionAdminAudit(
    { userId: 'admin', role: 'admin' }, session, 'session.send', { record },
  );
  audit.finish('succeeded');
  beginSessionAdminAudit({ userId: 'member-a', role: 'member' }, session, 'session.stop', { record }).finish('failed');
  beginSessionAdminAudit({ userId: 'admin', role: 'admin' }, { ...session, owner_user_id: 'admin' }, 'session.stop', { record }).finish('failed');
  assert.deepEqual(events, [
    { actorUserId: 'admin', action: 'session.send', resourceType: 'session', resourceId: 'session-a', ownerUserId: 'member-a', result: 'started' },
    { actorUserId: 'admin', action: 'session.send', resourceType: 'session', resourceId: 'session-a', ownerUserId: 'member-a', result: 'succeeded' },
  ]);
});

test('开始审计写入异常时拒绝 WebSocket 管理员代操作', () => {
  const diagnostics: string[] = [];
  assert.throws(() => beginSessionAdminAudit(
    { userId: 'admin', role: 'admin' }, { id: 'session-a', owner_user_id: 'member-a' }, 'session.stop',
    { record: () => { throw new Error('disk'); }, diagnostic: (message) => diagnostics.push(message) },
  ), /disk/);
  assert.deepEqual(diagnostics, ['WebSocket 管理员代操作开始审计写入失败']);
});
