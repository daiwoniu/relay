import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs, StorageCommandEnvelope } from './contracts.js';

function setDisabled(disabled = true) {
  return { ...markRead(disabled ? 'disable' : 'enable', 'admin'), command: { name: 'account.setDisabled', input: { userId: 'owner', disabled } } } as
    StorageCommandEnvelope & { command: { name: 'account.setDisabled'; input: CoreCommandInputs['account.setDisabled'] } };
}
async function queued(port: StorageWorkerClient) {
  assert.equal((await port.execute({ ...markRead('enqueue'), command: { name: 'turn.enqueue', input: {
    sessionId: 'draft', attemptId: 'waiting-attempt', messageId: 'waiting-message', engineId: 'codex', resourceKey: 'codex:default',
    content: 'waiting', metadata: null, expectedPreferencesRevision: 0, origin: { kind: 'direct' },
    draft: { projectId: 'project', title: 'queued', titleManuallySet: false },
  } } })).state, 'committed');
}

test('disable, queued cancellations, auth revocation, audit and receipt commit once; running leases survive', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await queued(port);
    const result = await port.execute(setDisabled()); assert.equal(result.state, 'committed');
    if (result.state === 'committed') {
      assert.equal(result.value.revokedSessions, 1); assert.ok(result.value.user.disabledAt);
      assert.equal(result.value.cancelledSessions.length, 1);
      assert.equal(result.value.cancelledSessions[0].sessionId, 'draft');
      assert.equal(result.value.cancelledSessions[0].revision, 2);
    }
    assert.equal(f.scalar("SELECT count(*) FROM auth_sessions WHERE user_id='owner'"), 0);
    assert.equal(f.scalar('SELECT count(*) FROM engine_queue_entries'), 0);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 1);
    assert.equal(f.scalar('SELECT count(*) FROM admin_audit_events'), 1);
    const replay = await port.execute(setDisabled()); assert.equal(replay.state, 'committed');
    if (replay.state === 'committed') assert.equal(replay.replayed, true);
    assert.equal(f.scalar("SELECT count(*) FROM messages WHERE session_id='draft'"), 2);
    assert.equal(f.scalar('SELECT count(*) FROM admin_audit_events'), 1);
    assert.equal((await port.execute(setDisabled(false))).state, 'committed');
    assert.equal(f.scalar("SELECT disabled_at FROM users WHERE id='owner'"), null);
    assert.equal(f.scalar("SELECT count(*) FROM auth_sessions WHERE user_id='owner'"), 0);
  } finally { await port.close(); f.cleanup(); }
});

test('audit or receipt failure rolls back account state, queue cancellations and token revocation', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await queued(port);
    for (const table of ['admin_audit_events', '_relay_storage_operations']) {
      f.mutate(`CREATE TRIGGER fail_disable BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`);
      assert.equal((await port.execute(setDisabled())).state, 'unknown');
      assert.equal(f.scalar("SELECT disabled_at FROM users WHERE id='owner'"), null);
      assert.equal(f.scalar("SELECT count(*) FROM auth_sessions WHERE user_id='owner'"), 1);
      assert.equal(f.scalar("SELECT state FROM engine_queue_entries WHERE session_id='draft'"), 'queued');
      assert.equal(f.scalar("SELECT count(*) FROM messages WHERE session_id='draft'"), 1);
      assert.equal(f.scalar('SELECT count(*) FROM admin_audit_events'), 0);
      f.mutate('DROP TRIGGER fail_disable');
    }
    assert.equal((await port.execute(setDisabled())).state, 'committed');
  } finally { await port.close(); f.cleanup(); }
});

test('admin capability is rechecked for effects, receipt replay and lookup', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const invalid = { ...setDisabled(), principal: markRead('x', 'other').principal };
    assert.deepEqual(await port.execute(invalid), { state: 'rejected', operationId: 'disable', code: 'FORBIDDEN' });
    assert.deepEqual(await port.execute({ ...setDisabled(), command: { name: 'account.setDisabled', input: { userId: 'admin', disabled: true } } }),
      { state: 'rejected', operationId: 'disable', code: 'CONFLICT' });
    assert.equal((await port.execute(setDisabled())).state, 'committed');
    f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    assert.deepEqual(await port.execute(setDisabled()), { state: 'rejected', operationId: 'disable', code: 'FORBIDDEN' });
    await assert.rejects(port.lookup({ storeId: 'store', operationId: 'disable', principal: setDisabled().principal }), /FORBIDDEN/);
    assert.equal(f.scalar('SELECT count(*) FROM admin_audit_events'), 1);
  } finally { await port.close(); f.cleanup(); }
});
