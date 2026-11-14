import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import { StoredCredentialService } from '../auth/stored-credentials.js';
import { hashSessionToken } from '../auth/session.js';
import { credentialIdentity } from './credential-contracts.js';

const shared = '11111111-1111-4111-8111-111111111111';
const adminHash = hashSessionToken('synthetic-member-admin');
const ownerHash = hashSessionToken('synthetic-member-owner');
const principal = { kind: 'user' as const, userId: 'admin', authSessionHash: adminHash };
const input = { username: 'new-member', initialPassword: 'synthetic-initial-password', workspacePath: 'D:/synthetic-workspace',
  displayName: 'Member', canCreateProject: false, projectIds: [shared] };
async function prepared() {
  const f = fixture();
  f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${adminHash}','admin',${Date.now()+600_000}),('${ownerHash}','owner',${Date.now()+600_000});
    INSERT INTO projects(id,owner_user_id,path,deleted_at) VALUES('${shared}','owner','D:/shared',NULL)`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  return { f, port, service: new StoredCredentialService(port, { storeId: 'store', generation: 1 }), cleanup: async () => { await port.close(); f.cleanup(); } };
}

test('member, private default project, shared grants, initial password and audit commit once', async () => {
  const p = await prepared();
  try {
    const intent = p.service.prepareCreateMember(principal, input);
    assert.throws(() => p.service.prepareCreateMember(principal, { ...input, role: 'admin' } as any), /INVALID_ARGUMENT/);
    const altered = structuredClone(intent); altered.command.input.initialPassword = 'different-initial-password';
    assert.equal(credentialIdentity(intent).publicDigest, credentialIdentity(altered).publicDigest);
    const first = await p.service.run(intent); assert.equal(first.state, 'committed');
    if (first.state !== 'committed') throw Error('member creation failed');
    assert.equal(first.value.user.role, 'member'); assert.equal(first.value.user.mustChangePassword, true);
    assert.equal(first.value.user.canCreateProject, false); assert.equal(first.value.user.defaultProjectId, first.value.projectId);
    assert.equal(p.f.scalar(`SELECT owner_user_id FROM projects WHERE id='${first.value.projectId}'`), first.value.user.id);
    assert.equal(p.f.scalar(`SELECT role FROM project_members WHERE user_id='${first.value.user.id}'`), 'collaborator');
    assert.equal(p.f.scalar(`SELECT can_view_sessions FROM project_members WHERE user_id='${first.value.user.id}'`), 0);
    assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'), 1);
    const replay = await p.service.run(intent); assert.equal(replay.state, 'committed');
    if (replay.state === 'committed') { assert.equal(replay.replayed, true); assert.equal(replay.value.user.id, first.value.user.id); }
    assert.equal(p.f.scalar("SELECT count(*) FROM users WHERE username='new-member'"), 1);
    assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'), 1);
    assert.equal((await p.service.run(altered)).state, 'rejected');
    const login = p.service.prepareLogin('NEW-MEMBER', input.initialPassword);
    const signed = await p.service.run(login.operation); assert.equal(signed.state, 'committed');
    if (signed.state === 'committed') assert.equal(signed.value.user.mustChangePassword, true);
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    const forbidden = await p.service.run(intent); assert.equal(forbidden.state, 'rejected');
    if (forbidden.state === 'rejected') assert.equal(forbidden.code, 'FORBIDDEN');
  } finally { await p.cleanup(); }
});

test('audit or credential receipt failure leaves no member, default project or partial grants', async () => {
  const p = await prepared();
  try {
    const intent = p.service.prepareCreateMember(principal, input);
    for (const table of ['admin_audit_events', '_relay_credential_operations']) {
      p.f.mutate(`CREATE TRIGGER fail_member BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`);
      assert.equal((await p.service.run(intent)).state, 'unknown');
      assert.equal(p.f.scalar('SELECT count(*) FROM users'), 3);
      assert.equal(p.f.scalar('SELECT count(*) FROM projects'), 2);
      assert.equal(p.f.scalar('SELECT count(*) FROM project_members'), 0);
      assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'), 0);
      p.f.mutate('DROP TRIGGER fail_member');
    }
    assert.equal((await p.service.run(intent)).state, 'committed');
    const second = await p.service.run(p.service.prepareCreateMember(principal, { ...input, username: 'second-member' }));
    assert.equal(second.state, 'committed'); // Same normalized path is isolated by project owner.
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE path='D:/synthetic-workspace'"), 2);
  } finally { await p.cleanup(); }
});

test('member creation rejects unauthorized callers, trashed grants and invalid paths before materialization', async () => {
  const p = await prepared();
  try {
    const forbidden = await p.service.run(p.service.prepareCreateMember({ kind: 'user', userId: 'owner', authSessionHash: ownerHash }, input));
    assert.equal(forbidden.state, 'rejected');
    p.f.mutate(`UPDATE projects SET deleted_at=1 WHERE id='${shared}'`);
    const missing = await p.service.run(p.service.prepareCreateMember(principal, input));
    assert.equal(missing.state, 'rejected'); if (missing.state === 'rejected') assert.equal(missing.reason, 'project_unavailable');
    const relative = await p.service.run(p.service.prepareCreateMember(principal, { ...input, workspacePath: 'relative-path', projectIds: [] }));
    assert.equal(relative.state, 'rejected'); if (relative.state === 'rejected') assert.equal(relative.code, 'INVALID_ARGUMENT');
    assert.equal(p.f.scalar('SELECT count(*) FROM users'), 3); assert.equal(p.f.scalar('SELECT count(*) FROM project_members'), 0);
  } finally { await p.cleanup(); }
});
