import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRestoreOverlayFocus } from './focus-restoration.ts';

test('浮层关闭且页面没有新焦点目标时恢复原触发器焦点', () => {
  const body = {};

  assert.equal(shouldRestoreOverlayFocus(null, body), true);
  assert.equal(shouldRestoreOverlayFocus(body, body), true);
});

test('浮层关闭后已有新焦点目标时不抢回焦点', () => {
  const body = {};
  const renameInput = {};

  assert.equal(shouldRestoreOverlayFocus(renameInput, body), false);
});
