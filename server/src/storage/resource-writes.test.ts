import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import { normalizeProjectPathForOwnership } from '../db/multi-account.js';
import type { CoreCommand, StorageCommandEnvelope } from './contracts.js';
const actor = (userId = 'owner') => ({ kind: 'user' as const, userId, authSessionHash: `auth-${userId}` });
async function prepared() {
  const f = fixture();
  f.mutate(`UPDATE projects SET normalized_path='${normalizeProjectPathForOwnership('D:/synthetic').replaceAll("'", "''")}' WHERE id='project';
    UPDATE users SET default_project_id='project' WHERE id='owner'; UPDATE sessions SET status='idle' WHERE id='session'`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  let seq = 0;
  const request = (command: CoreCommand, user = 'owner', operationId = `resource-${++seq}`): StorageCommandEnvelope => ({ protocolVersion: 1,
    storeId: 'store', workerGeneration: 1, requestId: `req-${seq}`, operationId, principal: actor(user), command });
  return { f, port, request, run: (command: CoreCommand, user = 'owner') => port.execute(request(command, user) as any),
    cleanup: async () => { await port.close(); f.cleanup(); } };
}
test('project create preserves per-owner normalized paths, trash conflicts and atomic permission checks', async () => {
  const p = await prepared();
  try {
    const input = { projectId: 'new-project', path: 'D:/new-storage', name: 'New' };
    assert.equal((await p.run({ name: 'project.create', input })).state, 'committed');
    assert.equal((await p.run({ name: 'project.create', input: { ...input, projectId: 'unused' } })).state, 'committed');
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE owner_user_id='owner' AND path='D:/new-storage'"), 1);
    assert.equal((await p.run({ name: 'project.create', input: { ...input, projectId: 'other-project' } }, 'other')).state, 'committed');
    p.f.mutate("UPDATE users SET can_create_project=0 WHERE id='other'");
    const denied = await p.run({ name: 'project.create', input: { ...input, projectId: 'forbidden', path: 'D:/denied' } }, 'other');
    assert.equal(denied.state, 'rejected'); if (denied.state === 'rejected') assert.equal(denied.code, 'FORBIDDEN');
    p.f.mutate("UPDATE projects SET deleted_at=1 WHERE id='new-project'");
    const trash = await p.run({ name: 'project.create', input: { ...input, projectId: 'unused-again' } });
    assert.equal(trash.state, 'rejected'); if (trash.state === 'rejected') assert.equal(trash.code, 'CONFLICT');
    const invalid = await p.run({ name: 'project.create', input: { ...input, path: 'relative/path' } });
    assert.equal(invalid.state, 'rejected');
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE id='forbidden'"), 0);
  } finally { await p.cleanup(); }
});
test('session creation supports shared collaborator defaults and draft engine storage without giving viewer creation access', async () => {
  const p = await prepared();
  try {
    const input = { sessionId: 'draft', projectId: 'project', title: null, engine: null };
    assert.equal((await p.run({ name: 'session.create', input })).state, 'committed');
    assert.equal(p.f.scalar("SELECT engine FROM sessions WHERE id='draft'"), 'codex');
    assert.equal(p.f.scalar("SELECT engine_bound FROM sessions WHERE id='draft'"), 0);
    assert.equal((await p.port.readSession({ principal: actor(), sessionId: 'draft' }))?.engine, null);
    p.f.mutate("INSERT INTO project_members VALUES('project','other','viewer',1,1,1)");
    assert.equal((await p.run({ name: 'session.create', input: { ...input, sessionId: 'viewer' } }, 'other')).state, 'rejected');
    p.f.mutate("UPDATE project_members SET role='collaborator',can_view_sessions=0 WHERE user_id='other'; UPDATE users SET default_project_id='project',can_create_project=0 WHERE id='other'");
    const created = await p.run({ name: 'session.create', input: { ...input, projectId: null, sessionId: 'shared' } }, 'other');
    assert.equal(created.state, 'committed'); assert.equal(p.f.scalar("SELECT owner_user_id FROM sessions WHERE id='shared'"), 'other');
    assert.equal(await p.port.readSession({ principal: actor('other'), sessionId: 'session' }), null);
    assert.equal((await p.port.readSession({ principal: actor('other'), sessionId: 'shared' }))?.owner?.id, 'other');
    p.f.mutate("DELETE FROM project_members WHERE user_id='other'");
    assert.equal((await p.run({ name: 'session.create', input: { ...input, sessionId: 'after-revoke' } }, 'other')).state, 'rejected');
  } finally { await p.cleanup(); }
});
test('administrator session creation uses own same-directory project and receipt failure rolls back its implicit project', async () => {
  const p = await prepared();
  try {
    const input = { sessionId: 'admin-session', projectId: 'project', title: 'Admin', engine: 'codex' as const };
    p.f.mutate("CREATE TRIGGER fail_receipt BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await p.run({ name: 'session.create', input }, 'admin')).state, 'unknown');
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE owner_user_id='admin'"), 0);
    assert.equal(p.f.scalar("SELECT count(*) FROM sessions WHERE id='admin-session'"), 0);
    p.f.mutate('DROP TRIGGER fail_receipt');
    const request = p.request({ name: 'session.create', input }, 'admin');
    const first = await p.port.execute(request as any); assert.equal(first.state, 'committed');
    assert.equal(p.f.scalar("SELECT owner_user_id FROM sessions WHERE id='admin-session'"), 'admin');
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE owner_user_id='admin'"), 1);
    assert.equal((await p.port.execute(request as any)).state, 'committed');
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE owner_user_id='admin'"), 1);
  } finally { await p.cleanup(); }
});
test('project/session updates and admin audit commit together; replay never reverts later changes', async () => {
  const p = await prepared();
  try {
    const request = p.request({ name: 'project.update', input: { projectId: 'project', changes: { name: 'first', pinned: true } } }, 'admin');
    assert.equal((await p.port.execute(request as any)).state, 'committed');
    assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'), 2);
    assert.equal((await p.run({ name: 'project.update', input: { projectId: 'project', changes: { name: 'second' } } })).state, 'committed');
    assert.equal((await p.port.execute(request as any)).state, 'committed');
    assert.equal(p.f.scalar("SELECT name FROM projects WHERE id='project'"), 'second');
    assert.equal((await p.run({ name: 'session.update', input: { sessionId: 'session', changes: { title: 'renamed', pinned: true } } }, 'admin')).state, 'committed');
    assert.equal(p.f.scalar("SELECT title_manually_set FROM sessions WHERE id='session'"), 1);
    assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'), 4);
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    assert.equal((await p.port.execute(request as any)).state, 'rejected');
    await assert.rejects(p.port.lookup({ storeId: 'store', operationId: request.operationId, principal: actor('admin') }), { code: 'FORBIDDEN' });
  } finally { await p.cleanup(); }
});
test('preferences use revision and running guards; admin denial audit and operation receipts do not fabricate success', async () => {
  const p = await prepared();
  try {
    const input = { sessionId: 'session', modelId: 'test-model', reasoningEffort: null, serviceTier: null, expectedRevision: 0 };
    const request = p.request({ name: 'session.setPreferences', input });
    assert.equal((await p.port.execute(request as any)).state, 'committed');
    assert.equal(p.f.scalar("SELECT engine_preferences_revision FROM sessions WHERE id='session'"), 1);
    assert.equal((await p.port.execute(request as any)).state, 'committed');
    assert.equal(p.f.scalar("SELECT engine_preferences_revision FROM sessions WHERE id='session'"), 1);
    const denied = await p.run({ name: 'session.setPreferences', input }, 'admin');
    assert.equal(denied.state, 'rejected'); assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"), 1);
    p.f.mutate("UPDATE sessions SET status='processing' WHERE id='session'");
    assert.equal((await p.run({ name: 'session.setPreferences', input: { ...input, expectedRevision: 1 } })).state, 'rejected');
    assert.equal((await p.run({ name: 'session.update', input: { sessionId: 'session', changes: { projectId: 'project' } } })).state, 'rejected');
  } finally { await p.cleanup(); }
});
test('resource receipt/audit failures leave no partial edits, and expired receipts cannot be replayed', async () => {
  const p = await prepared();
  try {
    p.f.mutate("CREATE TRIGGER fail_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await p.run({ name: 'session.update', input: { sessionId: 'session', changes: { title: 'must-rollback' } } }, 'admin')).state, 'unknown');
    assert.equal(p.f.scalar("SELECT title FROM sessions WHERE id='session'"), 'test');
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_storage_operations'), 0);
    p.f.mutate('DROP TRIGGER fail_audit');
    const request = p.request({ name: 'session.update', input: { sessionId: 'session', changes: { title: 'saved' } } });
    assert.equal((await p.port.execute(request as any)).state, 'committed');
    p.f.mutate(`UPDATE _relay_storage_operations SET expired=1,result_json=NULL WHERE operation_id='${request.operationId}'`);
    const expired = await p.port.execute(request as any); assert.equal(expired.state, 'rejected');
    if (expired.state === 'rejected') assert.equal(expired.code, 'OPERATION_EXPIRED');
    assert.equal(p.f.scalar("SELECT title FROM sessions WHERE id='session'"), 'saved');
  } finally { await p.cleanup(); }
});
test('shared first-send admission creates its owned draft, message and queue in the same transaction', async () => {
  const p = await prepared();
  try {
    p.f.mutate("INSERT INTO project_members VALUES('project','other','collaborator',0,1,1)");
    const request: StorageCommandEnvelope = { ...markRead(), principal: actor('other'), operationId: 'shared-first-send', command: { name: 'turn.enqueue', input: {
      sessionId: 'shared-draft', attemptId: 'shared-attempt', messageId: 'shared-message', engineId: 'codex', resourceKey: 'codex:default',
      content: 'synthetic', metadata: null, expectedPreferencesRevision: 0, origin: { kind: 'direct' },
      draft: { projectId: 'project', title: 'shared title', titleManuallySet: true },
    } } };
    assert.equal((await p.port.execute(request as any)).state, 'committed');
    assert.equal(p.f.scalar("SELECT owner_user_id FROM sessions WHERE id='shared-draft'"), 'other');
    assert.equal(p.f.scalar("SELECT requested_by_user_id FROM engine_queue_entries WHERE session_id='shared-draft'"), 'other');
    assert.equal((await p.port.execute(request as any)).state, 'committed');
    assert.equal(p.f.scalar("SELECT count(*) FROM messages WHERE id='shared-message'"), 1);
  } finally { await p.cleanup(); }
});
