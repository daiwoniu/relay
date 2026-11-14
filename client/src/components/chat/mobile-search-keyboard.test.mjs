import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MOBILE_KEYBOARD_HEIGHT_THRESHOLD,
  retainExpandedViewportHeight,
  shouldKeepComposerBehindSearchKeyboard,
} from './mobile-search-keyboard.ts';

test('移动端搜索框触发明显视口收缩时让消息输入区留在键盘后方', () => {
  assert.equal(shouldKeepComposerBehindSearchKeyboard({
    mobile: true,
    searchInputFocused: true,
    expandedViewportHeight: 780,
    currentViewportHeight: 460,
  }), true);
});

test('消息输入键盘先打开时不会覆盖搜索键盘判定所需的展开高度', () => {
  let expandedViewportHeight = 780;
  expandedViewportHeight = retainExpandedViewportHeight(expandedViewportHeight, 460);

  assert.equal(expandedViewportHeight, 780);
  assert.equal(shouldKeepComposerBehindSearchKeyboard({
    mobile: true,
    searchInputFocused: true,
    expandedViewportHeight,
    currentViewportHeight: 460,
  }), true);
});

test('消息输入框焦点、桌面端和普通地址栏变化不改变输入区位置', () => {
  assert.equal(shouldKeepComposerBehindSearchKeyboard({
    mobile: true,
    searchInputFocused: false,
    expandedViewportHeight: 780,
    currentViewportHeight: 460,
  }), false);
  assert.equal(shouldKeepComposerBehindSearchKeyboard({
    mobile: false,
    searchInputFocused: true,
    expandedViewportHeight: 780,
    currentViewportHeight: 460,
  }), false);
  assert.equal(shouldKeepComposerBehindSearchKeyboard({
    mobile: true,
    searchInputFocused: true,
    expandedViewportHeight: 780,
    currentViewportHeight: 780 - MOBILE_KEYBOARD_HEIGHT_THRESHOLD + 1,
  }), false);
});
