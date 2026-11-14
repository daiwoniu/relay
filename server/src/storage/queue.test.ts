import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs, CoreCommandName, StorageCommandEnvelope } from './contracts.js';

function command<K extends CoreCommandName>(operationId: string, name: K, input: CoreCommandInputs[K]) {
  return { ...markRead(), operationId, principal: { kind: 'system' as const, purpose: 'scheduler' as const },
    command: { name, input } } as StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } };
}
async function queued(client: StorageWorkerClient, suffix = '') {
  const request: StorageCommandEnvelope = { ...markRead(), operationId: `enqueue${suffix}`, command: { name: 'turn.enqueue', input: {
    sessionId: `draft${suffix}`, attemptId: `attempt${suffix}`, messageId: `message${suffix}`, engineId: 'codex',
    resourceKey: 'codex:default', content: 'test', metadata: null, expectedPreferencesRevision: 0,
    origin: { kind: 'direct' }, draft: { projectId: 'project', title: 'test', titleManuallySet: false },
  } } };
  assert.equal((await client.execute(request)).state, 'committed');
}

test('claim uses trusted capacity, replays the original lease, and does not cancel an already claimed task', async () => {
  const f = fixture(); f.mutate('DELETE FROM engine_resource_leases');
  const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1,
    initialize: true, defaultConcurrency: { 'codex:default': 1 } });
  try {
    await queued(client); await queued(client, '-second');
    const claim = command('claim', 'queue.claim', { resourceKey: 'codex:default', claimToken: 'token' });
    const first = await client.execute(claim);
    assert.equal(first.state, 'committed');
    if (first.state !== 'committed' || !first.value) throw Error('claim failed');
    assert.equal(first.value.sessionId, 'draft');
    const replay = await client.execute(claim);
    assert.equal(replay.state, 'committed');
    if (replay.state === 'committed') { assert.equal(replay.replayed, true); assert.deepEqual(replay.value, first.value); }
    const full = await client.execute(command('full', 'queue.claim', { resourceKey: 'codex:default', claimToken: 'other' }));
    assert.equal(full.state, 'committed'); if (full.state === 'committed') assert.equal(full.value, null);
    const running = await client.execute(command('running', 'queue.markRunning', {
      sessionId: 'draft', attemptId: 'attempt', leaseToken: first.value.leaseToken }));
    assert.equal(running.state, 'committed');
    assert.equal(f.scalar("SELECT state FROM engine_resource_leases WHERE attempt_id='attempt'"), 'running');
    const cancel = { ...command('cancel-claimed', 'queue.cancel', { sessionId: 'draft', expectedAttemptId: 'attempt', messageId: 'cancelled' }),
      principal: markRead().principal };
    const result = await client.execute(cancel);
    assert.equal(result.state, 'committed'); if (result.state === 'committed') assert.equal(result.value.cancelled, false);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 1);
    const pending = await client.execute({ ...command('cancel-queued', 'queue.cancel', {
      sessionId: 'draft-second', expectedAttemptId: 'attempt-second', messageId: 'cancelled-second' }), principal: markRead().principal });
    assert.equal(pending.state, 'committed'); if (pending.state === 'committed') assert.equal(pending.value.cancelled, true);
    assert.equal(f.scalar("SELECT count(*) FROM engine_queue_entries WHERE session_id='draft-second'"), 0);
  } finally { await client.close(); f.cleanup(); }
});

test('claim and fairness updates roll back together if the receipt cannot commit', async () => {
  const f = fixture(); f.mutate('DELETE FROM engine_resource_leases');
  const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1,
    initialize: true, defaultConcurrency: { 'codex:default': 1 } });
  try {
    await queued(client);
    f.mutate("CREATE TRIGGER fail_claim BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='queue.claim' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const claim = command('claim', 'queue.claim', { resourceKey: 'codex:default', claimToken: 'token' });
    assert.equal((await client.execute(claim)).state, 'unknown');
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 0);
    assert.equal(f.scalar('SELECT count(*) FROM engine_queue_fairness'), 0);
    assert.equal(f.scalar("SELECT state FROM engine_queue_entries WHERE session_id='draft'"), 'queued');
    f.mutate('DROP TRIGGER fail_claim');
    assert.equal((await client.execute(claim)).state, 'committed');
  } finally { await client.close(); f.cleanup(); }
});

test('claim refuses missing server capacity instead of accepting caller-selected limits', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    assert.deepEqual(await client.execute(command('claim', 'queue.claim', { resourceKey: 'codex:default', claimToken: 'token' })),
      { state: 'rejected', operationId: 'claim', code: 'NOT_SUPPORTED' });
  } finally { await client.close(); f.cleanup(); }
});

test('expired cooldown grants one probe atomically and start acceptance clears it with its event', async () => {
  const f = fixture(); f.mutate(`DELETE FROM engine_resource_leases;
    INSERT INTO engine_provider_cooldowns VALUES('codex:default',1,1,NULL,1,NULL,1)`);
  const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1,
    initialize: true, defaultConcurrency: { 'codex:default': 2 } });
  try {
    await queued(client); await queued(client, '-second');
    const claim = command('probe', 'queue.claim', { resourceKey: 'codex:default', claimToken: 'probe-token' });
    f.mutate("CREATE TRIGGER fail_claim BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='queue.claim' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await client.execute(claim)).state, 'unknown');
    assert.equal(f.scalar('SELECT probe_attempt_id FROM engine_provider_cooldowns'), null);
    assert.equal(f.scalar('SELECT count(*) FROM engine_capacity_events'), 0);
    f.mutate('DROP TRIGGER fail_claim');
    assert.equal((await client.execute(claim)).state, 'committed');
    assert.equal(f.scalar('SELECT probe_attempt_id FROM engine_provider_cooldowns'), 'attempt');
    const blocked = await client.execute(command('blocked-probe', 'queue.claim', { resourceKey: 'codex:default', claimToken: 'other' }));
    assert.equal(blocked.state, 'committed'); if (blocked.state === 'committed') assert.equal(blocked.value, null);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'), 1);
    const running = command('probe-running', 'queue.markRunning', { sessionId: 'draft', attemptId: 'attempt', leaseToken: 'probe-token' });
    f.mutate("CREATE TRIGGER fail_running BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='queue.markRunning' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await client.execute(running)).state, 'unknown');
    assert.equal(f.scalar('SELECT state FROM engine_resource_leases'), 'claimed');
    assert.equal(f.scalar('SELECT probe_attempt_id FROM engine_provider_cooldowns'), 'attempt');
    assert.equal(f.scalar("SELECT count(*) FROM engine_capacity_events WHERE event_type='start_accepted'"), 0);
    f.mutate('DROP TRIGGER fail_running');
    assert.equal((await client.execute(running)).state, 'committed');
    assert.equal(f.scalar('SELECT probe_attempt_id FROM engine_provider_cooldowns'), null);
    assert.equal(f.scalar('SELECT consecutive_overloads FROM engine_provider_cooldowns'), 0);
    assert.equal((await client.execute({ ...running, operationId: 'running-again' })).state, 'committed');
    assert.equal(f.scalar("SELECT count(*) FROM engine_capacity_events WHERE event_type='start_accepted'"), 1);
    const second = await client.execute(command('after-acceptance', 'queue.claim', { resourceKey: 'codex:default', claimToken: 'second' }));
    assert.equal(second.state, 'committed'); if (second.state === 'committed') assert.equal(second.value?.sessionId, 'draft-second');
  } finally { await client.close(); f.cleanup(); }
});
