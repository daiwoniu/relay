import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineEventEmitter, type EngineEventEnvelope } from './events.js';

test('每个连接的事件 sequence 严格递增且 observedAt 可注入', () => {
  const envelopes: EngineEventEnvelope[] = [];
  const emit = createEngineEventEmitter({
    engineId: 'codex',
    emit: (envelope) => envelopes.push(envelope),
    now: () => 123,
  });

  emit({ type: 'request_forwarded' }, { source: 'local' });
  emit({ type: 'turn_start', turnId: 'turn-1' }, {
    source: 'realtime',
    observedAt: 456,
    eventId: 'event-1',
    externalSessionId: 'thread-1',
    externalTurnId: 'turn-1',
  });

  assert.deepEqual(envelopes.map((envelope) => envelope.meta.sequence), [1, 2]);
  assert.equal(envelopes[0]?.meta.observedAt, 123);
  assert.deepEqual(envelopes[1]?.meta, {
    observedAt: 456,
    source: 'realtime',
    sequence: 2,
    eventId: 'event-1',
    externalSessionId: 'thread-1',
    externalTurnId: 'turn-1',
  });
});

test('事件信封保留原 payload 引用且不同连接独立计数', () => {
  const first: EngineEventEnvelope[] = [];
  const second: EngineEventEnvelope[] = [];
  const payload = { type: 'delta' as const, itemId: 'item-1', content: '内容' };
  createEngineEventEmitter({ engineId: 'codex', emit: (event) => first.push(event) })(payload, { source: 'realtime' });
  createEngineEventEmitter({ engineId: 'codebuddy', emit: (event) => second.push(event) })(payload, { source: 'realtime' });

  assert.equal(first[0]?.payload, payload);
  assert.equal(first[0]?.meta.sequence, 1);
  assert.equal(second[0]?.meta.sequence, 1);
});
