import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLoginViewportState,
  updateLoginViewportState,
} from './login-viewport-recovery.ts';

test('软键盘关闭后要求恢复登录页滚动位置', () => {
  const initial = createLoginViewportState(390, 760);
  const opened = updateLoginViewportState(initial, 390, 420);
  assert.equal(opened.state.keyboardOpen, true);
  assert.equal(opened.shouldResetScroll, false);

  const closed = updateLoginViewportState(opened.state, 390, 720);
  assert.equal(closed.state.keyboardOpen, false);
  assert.equal(closed.shouldResetScroll, true);
});

test('地址栏高度变化不误判为软键盘', () => {
  const initial = createLoginViewportState(390, 720);
  const changed = updateLoginViewportState(initial, 390, 780);
  assert.equal(changed.state.keyboardOpen, false);
  assert.equal(changed.shouldResetScroll, false);
});

test('屏幕方向变化时重建基线且不强制滚动', () => {
  const initial = createLoginViewportState(390, 760);
  const opened = updateLoginViewportState(initial, 390, 420);
  const rotated = updateLoginViewportState(opened.state, 760, 390);
  assert.deepEqual(rotated.state, createLoginViewportState(760, 390));
  assert.equal(rotated.shouldResetScroll, false);
});
