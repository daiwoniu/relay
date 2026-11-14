import assert from 'node:assert/strict';
import test from 'node:test';
import { useSessionEndAttentionStore } from './session-end-attention.ts';

test('会话结束提醒按序排队并逐项确认', () => {
  useSessionEndAttentionStore.setState({ nextSequence: 1, events: [] });
  const store = useSessionEndAttentionStore.getState();
  store.publish({ userId: 'user-1', sessionId: 'a', sessionTitle: '会话 A', status: 'completed', occurredAt: 1 });
  store.publish({ userId: 'user-1', sessionId: 'b', sessionTitle: '会话 B', status: 'failed', occurredAt: 2 });
  assert.deepEqual(useSessionEndAttentionStore.getState().events.map((event) => [event.sequence, event.sessionId]), [[1, 'a'], [2, 'b']]);
  useSessionEndAttentionStore.getState().acknowledge(1);
  assert.deepEqual(useSessionEndAttentionStore.getState().events.map((event) => event.sessionId), ['b']);
});
