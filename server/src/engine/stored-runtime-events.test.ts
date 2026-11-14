import test from 'node:test';
import assert from 'node:assert/strict';
import { StoredRuntimeEvents } from './stored-runtime-events.js';
import { createSessionRuntimeState } from './runtime.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { EngineEventEnvelope } from './events.js';

const event: EngineEventEnvelope = { engineId: 'codex', payload: { type: 'turn_start', turnId: 'turn' },
  meta: { source: 'realtime', sequence: 1, observedAt: 100, eventId: 'start', externalSessionId: 'thread', externalTurnId: 'turn' } };
function runtime() {
  const value = createSessionRuntimeState({ sessionId: 'session', projectId: 'project', engine: 'codex' });
  value.attemptId = 'attempt'; value.engineConnectionId = 'connection'; value.leaseToken = 'lease';
  return value;
}

test('actual SessionRuntime receives awaited facts and async observers without invoking its legacy sink', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const current = runtime(); const order: string[] = [];
  current.observeEngineEvent = async () => { await Promise.resolve(); order.push('observer'); };
  current.turnFactSink = { record: () => assert.fail('legacy sink must not be called') } as any;
  const bound = new StoredRuntimeEvents(current, port, { storeId: 'store', generation: 1, runtimeVersion: 1,
    isOwned: (candidate) => candidate === current, onFailure: () => assert.fail('unexpected storage failure') });
  try {
    const result = await bound.route(event, async (_, context) => {
      assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'), 1);
      assert.equal(context.fact?.sessionId, current.sessionId);
      order.push('handler'); await context.persistUsage({ inputTokens: 7 });
    });
    assert.equal(result.state, 'handled'); assert.deepEqual(order, ['observer', 'handler']);
    assert.equal(f.scalar('SELECT active_turn_usage FROM sessions'), '{"inputTokens":7}');
    assert.throws(() => new StoredRuntimeEvents(current, port, { storeId: 'store', generation: 1, runtimeVersion: 1,
      isOwned: () => true, onFailure: () => undefined }), /RUNTIME_STORAGE_CONFLICT/);
  } finally { await bound.close(); await port.close(); f.cleanup(); }
});

test('runtime registry replacement during awaited observation suppresses the old handler', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const current = runtime(); let owned = true; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observing = new Promise<void>((resolve) => { started = resolve; });
  current.observeEngineEvent = async () => { started(); await gate; };
  const bound = new StoredRuntimeEvents(current, port, { storeId: 'store', generation: 1, runtimeVersion: 1,
    isOwned: () => owned, onFailure: () => assert.fail('stale callbacks are not storage failures') });
  try {
    const pending = bound.route(event, () => assert.fail('old callback must not publish'));
    await observing; owned = false; release();
    assert.deepEqual(await pending, { state: 'stale' });
    assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'), 1);
  } finally { release(); await bound.close(); await port.close(); f.cleanup(); }
});

test('connection and attempt changes fence queued void engine callbacks before mutation', async () => {
  const f = fixture(); const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const current = runtime();
  const bound = new StoredRuntimeEvents(current, port, { storeId: 'store', generation: 1, runtimeVersion: 1,
    isOwned: () => true, onFailure: () => assert.fail('stale callbacks are not failures') });
  try {
    current.engineConnectionId = 'new-connection';
    bound.accept(event, () => assert.fail('stale void callback'));
    assert.deepEqual(await bound.route(event, () => assert.fail('stale handler')), { state: 'stale' });
    assert.equal(f.scalar('SELECT count(*) FROM engine_turn_facts'), 0);
  } finally { await bound.close(); await port.close(); f.cleanup(); }
});
