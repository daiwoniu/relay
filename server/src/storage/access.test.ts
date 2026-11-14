import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs, CoreCommandName, StorageCommandEnvelope } from './contracts.js';

const shared = '11111111-1111-4111-8111-111111111111';
const fallback = '22222222-2222-4222-8222-222222222222';
function command<K extends CoreCommandName>(id: string, name: K, input: CoreCommandInputs[K], actor = 'admin') {
  return { ...markRead(id, actor), command: { name, input } } as StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } };
}
function seed(f: ReturnType<typeof fixture>) {
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,is_system,deleted_at) VALUES
    ('${shared}','admin','D:/shared',0,NULL),('${fallback}','other','D:/private',1,NULL)`);
}

test('project authority stays admin-only; creation permission and receipt replay recheck current role', async () => {
  const f = fixture(); seed(f); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const input = { projectId: shared, userId: 'other', role: 'manager' as const, canViewSessions: true };
    assert.equal((await port.execute(command('grant', 'project.setMember', input))).state, 'committed');
    const denied = await port.execute(command('manager-grant', 'project.setMember', { ...input, userId: 'owner' }, 'other'));
    assert.equal(denied.state, 'rejected'); if (denied.state === 'rejected') assert.equal(denied.code, 'FORBIDDEN');
    const permission = command('permission', 'account.setProjectCreation', { userId: 'other', allowed: false });
    assert.equal((await port.execute(permission)).state, 'committed');
    assert.equal(f.scalar("SELECT can_create_project FROM users WHERE id='other'"), 0);
    assert.equal((await port.execute(permission)).state, 'committed');
    assert.equal(f.scalar('SELECT count(*) FROM admin_audit_events'), 2); // Includes membership changes to admin's own project.
    f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    const replay = await port.execute(permission); assert.equal(replay.state, 'rejected');
    await assert.rejects(port.lookup({ storeId: 'store', operationId: 'permission', principal: permission.principal }), /FORBIDDEN/);
  } finally { await port.close(); f.cleanup(); }
});

test('membership downgrade/removal repairs shared default preference and old receipts cannot restore revoked grants', async () => {
  const f = fixture(); seed(f); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const grant = command('grant', 'project.setMember', { projectId: shared, userId: 'other', role: 'collaborator', canViewSessions: true });
    await port.execute(grant);
    const select = command('default', 'account.setDefaultProject', { projectId: shared }, 'other');
    assert.equal((await port.execute(select)).state, 'committed');
    const downgrade = command('viewer', 'project.setMember', { projectId: shared, userId: 'other', role: 'viewer' });
    const changed = await port.execute(downgrade); assert.equal(changed.state, 'committed');
    if (changed.state === 'committed') { assert.equal(changed.value.defaultProjectId, fallback); assert.equal(changed.value.canViewSessions, true); }
    assert.equal(f.scalar("SELECT default_project_id FROM users WHERE id='other'"), fallback);
    assert.equal((await port.execute({ ...select, operationId: 'viewer-select' })).state, 'rejected');
    await assert.rejects(port.lookup({ storeId: 'store', operationId: 'default', principal: select.principal }), /FORBIDDEN/);
    await port.execute(command('regrant', 'project.setMember', { projectId: shared, userId: 'other', role: 'manager' }));
    await port.execute({ ...select, operationId: 'default-again' });
    assert.equal((await port.execute(command('remove', 'project.removeMember', { projectId: shared, userId: 'other' }))).state, 'committed');
    assert.equal(f.scalar("SELECT default_project_id FROM users WHERE id='other'"), fallback);
    assert.equal((await port.execute(grant)).state, 'committed');
    assert.equal(f.scalar('SELECT count(*) FROM project_members'), 0);
    assert.equal((await port.execute(command('owner', 'project.setMember', { projectId: shared, userId: 'admin', role: 'viewer' }))).state, 'rejected');
  } finally { await port.close(); f.cleanup(); }
});

test('audit and receipt failures roll back visibility, role and default fallback together', async () => {
  const f = fixture(); seed(f); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await port.execute(command('grant', 'project.setMember', { projectId: shared, userId: 'other', role: 'collaborator', canViewSessions: true }));
    await port.execute(command('default', 'account.setDefaultProject', { projectId: shared }, 'other'));
    const intent = command('downgrade', 'project.setMember', { projectId: shared, userId: 'other', role: 'viewer', canViewSessions: false });
    for (const table of ['admin_audit_events', '_relay_storage_operations']) {
      f.mutate(`CREATE TRIGGER fail_access BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`);
      assert.equal((await port.execute(intent)).state, 'unknown');
      assert.equal(f.scalar('SELECT role FROM project_members'), 'collaborator');
      assert.equal(f.scalar('SELECT can_view_sessions FROM project_members'), 1);
      assert.equal(f.scalar("SELECT default_project_id FROM users WHERE id='other'"), shared);
      assert.equal(f.scalar('SELECT count(*) FROM admin_audit_events'), 1);
      f.mutate('DROP TRIGGER fail_access');
    }
    assert.equal((await port.execute(intent)).state, 'committed');
  } finally { await port.close(); f.cleanup(); }
});
