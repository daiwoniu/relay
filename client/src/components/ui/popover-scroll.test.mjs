import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldClosePopoverForScroll } from './popover-scroll.ts';

test('浮层内部滚动时保持打开', () => {
  const child = new EventTarget();
  const popover = { contains: (target) => target === child };

  assert.equal(shouldClosePopoverForScroll(popover, child), false);
});

test('浮层外部滚动时关闭', () => {
  const child = new EventTarget();
  const outside = new EventTarget();
  const popover = { contains: (target) => target === child };

  assert.equal(shouldClosePopoverForScroll(popover, outside), true);
});

test('消息列表动态滚动时保持浮层打开', () => {
  const popover = { contains: () => false };
  const messageScroller = {
    closest: (selector) => selector === '[data-overlay-scroll-preserve]' ? messageScroller : null,
  };

  assert.equal(shouldClosePopoverForScroll(popover, messageScroller), false);
});
