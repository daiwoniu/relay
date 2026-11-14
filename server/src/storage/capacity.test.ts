import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs, StorageCommandEnvelope } from './contracts.js';

const runtime = { kind: 'runtime' as const, sessionId: 'session', attemptId: 'attempt', connectionId: 'connection', runtimeVersion: 1 };
function observation(operationId = 'overload', event: CoreCommandInputs['capacity.observe']['event'] = { type: 'overload', retryAfterMs: null }) {
  return { ...markRead(), operationId, principal: runtime,
    command: { name: 'capacity.observe', input: { sessionId: 'session', attemptId: 'attempt', event } } } as
    StorageCommandEnvelope & { command: { name: 'capacity.observe'; input: CoreCommandInputs['capacity.observe'] } };
}

test('overload, cooldown and capacity events commit atomically and replay without increasing backoff', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    await port.registerRuntime({ storeId: 'store', workerGeneration: 1, leaseToken: 'lease', runtime });
    f.mutate("CREATE TRIGGER fail_capacity BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='capacity.observe' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await port.execute(observation())).state, 'unknown');
    assert.equal(f.scalar('SELECT count(*) FROM engine_provider_cooldowns'), 0);
    assert.equal(f.scalar('SELECT count(*) FROM engine_capacity_events'), 0);
    f.mutate('DROP TRIGGER fail_capacity');
    const result = await port.execute(observation()); assert.equal(result.state, 'committed');
    assert.equal(f.scalar('SELECT consecutive_overloads FROM engine_provider_cooldowns'), 1);
    assert.equal(f.scalar('SELECT count(*) FROM engine_capacity_events'), 2);
    const before = f.scalar('SELECT cooldown_until FROM engine_provider_cooldowns');
    const replay = await port.execute(observation()); assert.equal(replay.state, 'committed');
    if (replay.state === 'committed') assert.equal(replay.replayed, true);
    assert.equal(f.scalar('SELECT cooldown_until FROM engine_provider_cooldowns'), before);
    assert.equal(f.scalar('SELECT count(*) FROM engine_capacity_events'), 2);
    await port.execute(observation('retry', { type: 'request_retry' }));
    assert.equal(f.scalar('SELECT consecutive_overloads FROM engine_provider_cooldowns'), 1);
    assert.equal(f.scalar('SELECT count(*) FROM engine_capacity_events'), 3);
    f.mutate("UPDATE engine_resource_leases SET lease_token='rotated'");
    assert.deepEqual(await port.execute(observation('late')), { state: 'rejected', operationId: 'late', code: 'FORBIDDEN' });
  } finally { await port.close(); f.cleanup(); }
});
