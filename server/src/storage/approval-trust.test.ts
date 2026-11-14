import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs, CoreCommandName, StorageCommandEnvelope } from './contracts.js';

const actor = (userId = 'owner') => ({ kind: 'user' as const, userId, authSessionHash: `auth-${userId}` });
function command<K extends CoreCommandName>(id: string, name: K, input: CoreCommandInputs[K], userId = 'owner') {
  return { protocolVersion: 1, storeId: 'store', workerGeneration: 1, requestId: id, operationId: id, principal: actor(userId),
    command: { name, input } } as StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } };
}
const setProject = () => command('project-trust', 'approvalTrust.set', { scope: 'project', scopeId: 'project', mode: 'trusted', duration: 'permanent' });
const read = (port: StorageWorkerClient, userId = 'owner', scope: 'project' | 'session' = 'project') =>
  port.readApprovalTrust({ principal: actor(userId), scope, scopeId: scope === 'project' ? 'project' : 'session' });

test('trust remains account-private; project viewers do not acquire control of another user session', async () => {
  const f = fixture(); f.mutate("INSERT INTO project_members VALUES('project','other','viewer',1,1,1)");
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    assert.equal((await port.execute(setProject())).state, 'committed');
    assert.equal((await read(port)).effective.trusted, true);
    assert.equal((await read(port, 'other')).effective.trusted, false);
    await port.execute(command('other-trust', 'approvalTrust.set', { scope: 'project', scopeId: 'project', mode: 'trusted', duration: 'one_hour' }, 'other'));
    assert.equal(f.scalar('SELECT count(*) FROM approval_trust_settings'), 2);
    await port.execute(command('manual', 'approvalTrust.set', { scope: 'session', scopeId: 'session', mode: 'manual', duration: 'one_hour' }));
    const manual = await read(port, 'owner', 'session');
    assert.equal(manual.effective.trusted, false); assert.equal(manual.effective.sessionOverridesProject, true);
    await port.execute(command('admin-session', 'approvalTrust.set', { scope: 'session', scopeId: 'session', mode: 'trusted', duration: 'permanent' }, 'admin'));
    assert.equal((await read(port, 'admin', 'session')).effective.trusted, true);
    assert.equal((await read(port, 'owner', 'session')).effective.trusted, false);
    await assert.rejects(read(port, 'other', 'session'), /FORBIDDEN/);
    const denied = await port.execute(command('other-session', 'approvalTrust.set', { scope: 'session', scopeId: 'session', mode: 'trusted', duration: 'permanent' }, 'other'));
    assert.equal(denied.state, 'rejected'); if (denied.state === 'rejected') assert.equal(denied.code, 'FORBIDDEN');
  } finally { await port.close(); f.cleanup(); }
});

test('expiry and manual overrides resolve from current state; replay cannot extend trust or undo a clear', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await port.execute(setProject());
    const manual = command('manual', 'approvalTrust.set', { scope: 'session', scopeId: 'session', mode: 'manual', duration: 'one_hour' });
    await port.execute(manual);
    f.mutate("UPDATE approval_trust_settings SET expires_at=0 WHERE session_id='session'");
    assert.equal((await read(port, 'owner', 'session')).effective.source, 'project_trust');
    assert.equal((await port.execute(manual)).state, 'committed');
    assert.equal(f.scalar("SELECT expires_at FROM approval_trust_settings WHERE session_id='session'"), 0);
    await port.execute(command('clear', 'approvalTrust.clear', { scope: 'session', scopeId: 'session' }));
    await port.execute(manual);
    assert.equal(f.scalar("SELECT count(*) FROM approval_trust_settings WHERE session_id='session'"), 0);
    f.mutate("UPDATE approval_trust_settings SET expires_at=0 WHERE project_id='project'");
    assert.equal((await read(port, 'owner', 'session')).effective.trusted, false);
  } finally { await port.close(); f.cleanup(); }
});

test('receipt failures preserve previous trust and cannot leave partially cleared preferences', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await port.execute(setProject());
    f.mutate("CREATE TRIGGER fail_trust BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await port.execute(command('clear', 'approvalTrust.clear', { scope: 'project', scopeId: 'project' }))).state, 'unknown');
    assert.equal((await read(port)).effective.trusted, true);
    assert.equal((await port.execute(command('manual', 'approvalTrust.set', { scope: 'session', scopeId: 'session', mode: 'manual', duration: 'permanent' }))).state, 'unknown');
    assert.equal((await read(port, 'owner', 'session')).effective.source, 'project_trust');
    assert.equal(f.scalar('SELECT count(*) FROM approval_trust_settings'), 1);
  } finally { await port.close(); f.cleanup(); }
});

test('membership revocation, trash and disabled accounts block current reads, writes and receipt lookup', async () => {
  const f = fixture(); f.mutate("INSERT INTO project_members VALUES('project','other','viewer',0,1,1)");
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const intent = command('other-trust', 'approvalTrust.set', { scope: 'project', scopeId: 'project', mode: 'trusted', duration: 'permanent' }, 'other');
    await port.execute(intent); f.mutate("DELETE FROM project_members WHERE user_id='other'");
    await assert.rejects(read(port, 'other'), /FORBIDDEN/);
    assert.equal((await port.execute(intent)).state, 'rejected');
    await assert.rejects(port.lookup({ storeId: 'store', operationId: intent.operationId, principal: intent.principal }), /FORBIDDEN/);
    f.mutate('UPDATE projects SET deleted_at=1');
    await assert.rejects(read(port, 'owner', 'session'), /FORBIDDEN/);
    f.mutate("UPDATE projects SET deleted_at=NULL; UPDATE users SET disabled_at=1 WHERE id='owner'");
    await assert.rejects(read(port), /FORBIDDEN/);
    assert.equal(f.scalar('SELECT count(*) FROM approval_trust_settings'), 1);
    await assert.rejects(port.execute({ ...setProject(), command: { name: 'approvalTrust.set', input: { ...setProject().command.input, ownerUserId: 'other' } } } as any), /INVALID_ARGUMENT/);
  } finally { await port.close(); f.cleanup(); }
});
