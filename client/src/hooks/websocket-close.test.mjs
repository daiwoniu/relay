import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthenticationClose } from './websocket-close.ts';

test('WebSocket 认证关闭不应进入普通重连流程', () => {
  assert.equal(isAuthenticationClose(1008), true);
  assert.equal(isAuthenticationClose(1000), false);
  assert.equal(isAuthenticationClose(1006), false);
});
