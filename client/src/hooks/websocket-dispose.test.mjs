import assert from 'node:assert/strict';
import test from 'node:test';
import { disposeWebSocket } from './websocket-dispose.ts';

function socket(readyState) {
  return {
    readyState,
    closeCalls: 0,
    onopen: () => { throw new Error('旧 onopen 不应继续执行'); },
    onmessage: () => { throw new Error('旧 onmessage 不应继续执行'); },
    onclose: () => { throw new Error('旧 onclose 不应继续执行'); },
    onerror: () => { throw new Error('旧 onerror 不应继续执行'); },
    close() { this.closeCalls += 1; },
  };
}

function assertInactive(ws) {
  assert.equal(ws.onmessage, null);
  assert.equal(ws.onclose, null);
  assert.equal(ws.onerror, null);
}

test('OPEN WebSocket 卸载时立即关闭', () => {
  const ws = socket(1);
  assert.equal(disposeWebSocket(ws), 'closed');
  assert.equal(ws.closeCalls, 1);
  assertInactive(ws);
});

test('CONNECTING WebSocket 建立后立即关闭且不执行旧 onopen', () => {
  const ws = socket(0);
  assert.equal(disposeWebSocket(ws), 'deferred');
  assert.equal(ws.closeCalls, 0);
  assertInactive(ws);
  ws.onopen();
  assert.equal(ws.closeCalls, 1);
});

test('CLOSING 和 CLOSED WebSocket 不重复关闭', () => {
  for (const state of [2, 3]) {
    const ws = socket(state);
    assert.equal(disposeWebSocket(ws), 'noop');
    assert.equal(ws.closeCalls, 0);
    assertInactive(ws);
  }
});
