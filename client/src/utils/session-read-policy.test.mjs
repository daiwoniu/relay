import assert from 'node:assert/strict';
import test from 'node:test';
import { canAcknowledgeSessionResult } from './session-read-policy.ts';
import { useSessionReadStore } from '../stores/session-reads.ts';

test('页面可见、窗口有焦点且结果进入视口才能确认已读', () => {
  for (const visible of [false, true]) for (const focused of [false, true]) for (const intersecting of [false, true]) {
    assert.equal(canAcknowledgeSessionResult(visible, focused, intersecting), visible && focused && intersecting);
  }
});

test('单会话收据更新保留其他会话，切换账号清空本地收据', () => {
  const store = useSessionReadStore.getState();
  store.reset();
  store.merge({ a: 'turn-1', b: 'turn-2' });
  store.merge({ a: 'turn-3' });
  assert.deepEqual(useSessionReadStore.getState().receipts, { a: 'turn-3', b: 'turn-2' });
  store.reset();
  assert.deepEqual(useSessionReadStore.getState().receipts, {});
});
