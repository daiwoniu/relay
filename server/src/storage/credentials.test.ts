import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import { credentialIdentity, parseCredentialRequest, type CredentialRequest } from './credential-contracts.js';
import { parseCommandEnvelope } from './command-boundary.js';
import { StoredCredentialService } from '../auth/stored-credentials.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { hashSessionToken, ACCEPTANCE_SESSION_TTL_MS } from '../auth/session.js';

const ownerPassword = 'synthetic-owner-123';
const adminPassword = 'synthetic-admin-456';
const newPassword = 'synthetic-new-789';
const ownerHash = hashSessionToken('synthetic-owner-session');
const adminHash = hashSessionToken('synthetic-admin-session');
const owner = { kind: 'user' as const, userId: 'owner', authSessionHash: ownerHash };
const admin = { kind: 'user' as const, userId: 'admin', authSessionHash: adminHash };

async function prepared() {
  const f = fixture();
  f.mutate(`UPDATE users SET password_hash='${hashPassword(ownerPassword)}' WHERE id='owner';
    UPDATE users SET password_hash='${hashPassword(adminPassword)}' WHERE id='admin';
    DELETE FROM auth_sessions;
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES
      ('${ownerHash}','owner',${Date.now() + 600_000}),
      ('${hashSessionToken('synthetic-other-owner-session')}','owner',${Date.now() + 600_000}),
      ('${adminHash}','admin',${Date.now() + 600_000});`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const service = new StoredCredentialService(port, { storeId: 'store', generation: 1 });
  return { f, port, service, cleanup: async () => { await port.close(); f.cleanup(); } };
}

test('passwords are excluded from fast intent digest; caller and namespace boundaries are strict', async () => {
  const p = await prepared();
  try {
    const original = p.service.preparePasswordChange(owner, ownerPassword, newPassword);
    const altered = structuredClone(original); altered.command.input.newPassword = 'another-valid-password';
    assert.equal(credentialIdentity(original).publicDigest, credentialIdentity(altered).publicDigest);
    assert.notEqual(credentialIdentity(original).secretInput, credentialIdentity(altered).secretInput);
    assert.throws(() => parseCommandEnvelope({ ...markRead(), operationId: original.operationId }), /INVALID_ARGUMENT/);
    assert.throws(() => parseCredentialRequest({ ...original, operationId: 'normal-operation' }), /INVALID_ARGUMENT/);
    assert.throws(() => parseCredentialRequest({ ...original, principal: { kind: 'login' } }), /FORBIDDEN/);
    assert.throws(() => p.service.prepareLogin('owner', ownerPassword, { ttlMs: ACCEPTANCE_SESSION_TTL_MS }), /FORBIDDEN/);
  } finally { await p.cleanup(); }
});

test('login records no raw password/token, replays one session, and never resurrects a revoked login', async () => {
  const p = await prepared();
  try {
    const prepared = p.service.prepareLogin('OwNeR', ownerPassword);
    assert.deepEqual(await p.port.lookupCredential(prepared.operation), { state: 'not-found' });
    const first = await p.service.run(prepared.operation); assert.equal(first.state, 'committed');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 4);
    const row = String(p.f.scalar(`SELECT json_object('owner',owner_key,'authorizer',authorizer_hash,'command',command_name,
      'digest',public_digest,'proof',secret_verifier,'subject',subject_user_id,'result',result_json) FROM _relay_credential_operations`));
    assert.equal(row.includes(prepared.token), false); assert.equal(row.includes(ownerPassword), false);
    const proof = String(p.f.scalar('SELECT secret_verifier FROM _relay_credential_operations'));
    assert.ok(proof.startsWith('scrypt$'));
    assert.equal(verifyPassword(credentialIdentity(prepared.operation).secretInput, proof), true);
    p.f.mutate("UPDATE users SET display_name='updated name' WHERE id='owner'");
    const replay = await p.service.run(prepared.operation); assert.equal(replay.state, 'committed');
    if (replay.state === 'committed') { assert.equal(replay.replayed, true); assert.equal(replay.value.user.displayName, 'updated name'); }
    assert.equal(finiteCount(p.f, 'auth_sessions'), 4);
    p.f.mutate(`DELETE FROM auth_sessions WHERE token_hash='${prepared.operation.command.input.tokenHash}'`);
    const revoked = await p.service.run(prepared.operation); assert.equal(revoked.state, 'rejected');
    if (revoked.state === 'rejected') assert.equal(revoked.code, 'OPERATION_EXPIRED');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 3);
    const recreated = await p.service.run({ ...prepared.operation, operationId: 'credential:changed-id' });
    assert.equal(recreated.state, 'rejected'); if (recreated.state === 'rejected') assert.equal(recreated.code, 'CONFLICT');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 3);
  } finally { await p.cleanup(); }
});

function finiteCount(f: ReturnType<typeof fixture>, table: 'auth_sessions' | '_relay_credential_operations' | 'admin_audit_events') {
  return Number(f.scalar(`SELECT count(*) FROM ${table}`));
}

test('own password change and login revocation roll back on receipt failure, and dropped commit replies recover exactly once', async () => {
  const p = await prepared();
  try {
    p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'");
    const intent = p.service.preparePasswordChange(owner, ownerPassword, newPassword);
    p.f.mutate("CREATE TRIGGER fail_credential BEFORE INSERT ON _relay_credential_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await p.service.run(intent)).state, 'unknown');
    assert.equal(verifyPassword(ownerPassword, String(p.f.scalar("SELECT password_hash FROM users WHERE id='owner'"))), true);
    assert.equal(finiteCount(p.f, 'auth_sessions'), 3);
    assert.equal(finiteCount(p.f, '_relay_credential_operations'), 0);
    p.f.mutate('DROP TRIGGER fail_credential');
    const execute = p.port.executeCredential.bind(p.port);
    p.port.executeCredential = (async (request: CredentialRequest) => {
      await execute(request);
      return { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' };
    }) as typeof p.port.executeCredential;
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    let result;
    try { result = await p.service.run(intent); } finally { clearInterval(timer); }
    assert.equal(result.state, 'committed'); assert.ok(ticks > 0, 'password crypto must leave the main event loop responsive');
    if (result.state === 'committed') { assert.equal(result.replayed, true); assert.equal(result.value.revokedSessions, 2); }
    assert.equal(verifyPassword(newPassword, String(p.f.scalar("SELECT password_hash FROM users WHERE id='owner'"))), true);
    assert.equal(p.f.scalar("SELECT must_change_password FROM users WHERE id='owner'"), 0);
    assert.equal(finiteCount(p.f, 'auth_sessions'), 1);
    const altered = structuredClone(intent); altered.command.input.newPassword = 'different-new-password';
    const conflict = await p.service.run(altered); assert.equal(conflict.state, 'rejected');
    if (conflict.state === 'rejected') assert.equal(conflict.code, 'CONFLICT');
    assert.equal(finiteCount(p.f, '_relay_credential_operations'), 1);
    const unrelated = await execute(p.service.preparePasswordChange(owner, newPassword, 'yet-another-password'));
    assert.equal(unrelated.state, 'rejected');
  } finally { await p.cleanup(); }
});

test('rename enforces case-insensitive uniqueness, preserves the presenting session and revokes the others atomically', async () => {
  const p = await prepared();
  try {
    const conflict = await p.service.run(p.service.prepareRename(owner, ownerPassword, 'OTHER'));
    assert.equal(conflict.state, 'rejected'); if (conflict.state === 'rejected') assert.equal(conflict.reason, 'username_exists');
    const intent = p.service.prepareRename(owner, ownerPassword, 'renamed-owner');
    p.f.mutate("CREATE TRIGGER fail_credential BEFORE INSERT ON _relay_credential_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await p.service.run(intent)).state, 'unknown');
    assert.equal(p.f.scalar("SELECT username FROM users WHERE id='owner'"), 'owner');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 3);
    p.f.mutate('DROP TRIGGER fail_credential');
    const result = await p.service.run(intent); assert.equal(result.state, 'committed');
    if (result.state === 'committed') { assert.equal(result.value.user.username, 'renamed-owner'); assert.equal(result.value.revokedSessions, 1); }
    assert.equal((await p.port.authenticateSession({ tokenHash: ownerHash }))?.user.id, 'owner');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 2);
    assert.equal((await p.service.run(intent)).state, 'committed');
    p.f.mutate("UPDATE users SET role='admin',display_name='latest projection' WHERE id='owner'");
    const fresh = await p.service.run(intent); assert.equal(fresh.state, 'committed');
    if (fresh.state === 'committed') { assert.equal(fresh.value.user.role, 'admin'); assert.equal(fresh.value.user.displayName, 'latest projection'); }
  } finally { await p.cleanup(); }
});

test('admin reset validates current credentials and role, audits atomically and forces password change', async () => {
  const p = await prepared();
  try {
    const denied = await p.service.run(p.service.preparePasswordReset(owner, ownerPassword, 'other', newPassword));
    assert.equal(denied.state, 'rejected');
    const invalid = await p.service.run(p.service.preparePasswordReset(admin, 'wrong-password', 'owner', newPassword));
    assert.equal(invalid.state, 'rejected'); if (invalid.state === 'rejected') assert.equal(invalid.reason, 'invalid_current_password');
    const intent = p.service.preparePasswordReset(admin, adminPassword, 'owner', newPassword);
    p.f.mutate("CREATE TRIGGER fail_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await p.service.run(intent)).state, 'unknown');
    assert.equal(verifyPassword(ownerPassword, String(p.f.scalar("SELECT password_hash FROM users WHERE id='owner'"))), true);
    assert.equal(finiteCount(p.f, 'auth_sessions'), 3);
    p.f.mutate('DROP TRIGGER fail_audit');
    const result = await p.service.run(intent); assert.equal(result.state, 'committed');
    assert.equal(p.f.scalar("SELECT must_change_password FROM users WHERE id='owner'"), 1);
    assert.equal(finiteCount(p.f, 'auth_sessions'), 1); assert.equal(finiteCount(p.f, 'admin_audit_events'), 2);
    assert.equal((await p.service.run(intent)).state, 'committed');
    assert.equal(finiteCount(p.f, 'admin_audit_events'), 2);
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    const revoked = await p.service.run(intent); assert.equal(revoked.state, 'rejected');
    if (revoked.state === 'rejected') assert.equal(revoked.code, 'FORBIDDEN');
  } finally { await p.cleanup(); }
});

test('login failure and receipt-only lookup create no session; expired receipts retain their intent key', async () => {
  const p = await prepared();
  try {
    const bad = p.service.prepareLogin('owner', 'wrong-password');
    assert.equal((await p.service.run(bad.operation)).state, 'rejected');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 3);
    const good = p.service.prepareLogin('owner', ownerPassword);
    assert.equal((await p.service.run(good.operation)).state, 'committed');
    p.f.mutate('UPDATE _relay_credential_operations SET expired=1,result_json=NULL');
    const expired = await p.service.run(good.operation); assert.equal(expired.state, 'rejected');
    if (expired.state === 'rejected') assert.equal(expired.code, 'OPERATION_EXPIRED');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 4); assert.equal(finiteCount(p.f, '_relay_credential_operations'), 1);
  } finally { await p.cleanup(); }
});

test('credential receipts survive Worker replacement without recreating the revoked presenting session', async () => {
  const p = await prepared();
  let reopened: StorageWorkerClient | undefined;
  try {
    const intent = p.service.preparePasswordChange(owner, ownerPassword, newPassword);
    assert.equal((await p.service.run(intent)).state, 'committed');
    await p.port.close();
    reopened = await StorageWorkerClient.open({ filename: p.f.filename, storeId: 'store', generation: 2 });
    const recovered = await reopened.lookupCredential({ ...intent, workerGeneration: 2 });
    assert.equal(recovered.state, 'committed');
    if (recovered.state === 'committed') { assert.equal(recovered.replayed, true); assert.equal(recovered.value.revokedSessions, 2); }
    assert.equal(await reopened.authenticateSession({ tokenHash: ownerHash }), null);
    assert.equal(finiteCount(p.f, '_relay_credential_operations'), 1);
    assert.equal(finiteCount(p.f, 'auth_sessions'), 1);
  } finally { await reopened?.close(); await p.cleanup(); }
});

test('logout revokes only the presenting login and recovers its exact receipt even during required password change', async () => {
  const p = await prepared();
  try {
    p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'");
    const intent = p.service.prepareLogout(owner);
    p.f.mutate("CREATE TRIGGER fail_logout BEFORE INSERT ON _relay_credential_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await p.service.run(intent)).state, 'unknown');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 3);
    p.f.mutate('DROP TRIGGER fail_logout');
    assert.equal((await p.service.run(intent)).state, 'committed');
    assert.equal(await p.port.authenticateSession({ tokenHash: ownerHash }), null);
    assert.equal(finiteCount(p.f, 'auth_sessions'), 2);
    const replay = await p.service.run(intent); assert.equal(replay.state, 'committed');
    if (replay.state === 'committed') assert.equal(replay.replayed, true);
    assert.equal((await p.service.run(p.service.prepareLogout(owner))).state, 'rejected');
    assert.equal(finiteCount(p.f, 'auth_sessions'), 2);
  } finally { await p.cleanup(); }
});

test('revocation during unknown-result recovery never turns an already committed transaction into a claimed rejection', async () => {
  const p = await prepared();
  try {
    const intent = p.service.preparePasswordReset(admin, adminPassword, 'owner', newPassword);
    const execute = p.port.executeCredential.bind(p.port);
    p.port.executeCredential = (async (request: CredentialRequest) => {
      const committed = await execute(request); assert.equal(committed.state, 'committed');
      p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");
      return { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' };
    }) as typeof p.port.executeCredential;
    assert.equal((await p.service.run(intent)).state, 'unknown');
    assert.equal(verifyPassword(newPassword, String(p.f.scalar("SELECT password_hash FROM users WHERE id='owner'"))), true);
    assert.equal(finiteCount(p.f, 'admin_audit_events'), 1);
    assert.equal(finiteCount(p.f, '_relay_credential_operations'), 1);
  } finally { await p.cleanup(); }
});
