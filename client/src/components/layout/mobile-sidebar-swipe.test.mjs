import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMobileSidebarSwipeDistance,
  getMobileSidebarSwipeTranslateX,
  getMobileSidebarTranslateClass,
  isMobileSidebarOpenSwipeStart,
  resolveMobileSidebarSwipeMovement,
  shouldCommitMobileSidebarSwipe,
} from './mobile-sidebar-swipe.ts';

test('跟手滑动时移除静态位移类，避免两套 transform 叠加', () => {
  assert.equal(getMobileSidebarTranslateClass(false, true), '');
  assert.equal(getMobileSidebarTranslateClass(true, true), '');
  assert.equal(getMobileSidebarTranslateClass(true, false), 'translate-x-0');
  assert.equal(getMobileSidebarTranslateClass(false, false), '-translate-x-full lg:-translate-x-full');
});

test('右滑展开只接受避开系统边缘的 32px 到 96px 起点', () => {
  assert.equal(isMobileSidebarOpenSwipeStart(31.9), false);
  assert.equal(isMobileSidebarOpenSwipeStart(32), true);
  assert.equal(isMobileSidebarOpenSwipeStart(96), true);
  assert.equal(isMobileSidebarOpenSwipeStart(96.1), false);
});

test('手势先锁定明确横向移动，纵向滚动和反向移动会取消', () => {
  assert.equal(resolveMobileSidebarSwipeMovement('open', 11, 0), 'pending');
  assert.equal(resolveMobileSidebarSwipeMovement('open', 18, 9), 'tracking');
  assert.equal(resolveMobileSidebarSwipeMovement('open', 12, 12), 'cancelled');
  assert.equal(resolveMobileSidebarSwipeMovement('open', 18, 12), 'cancelled');
  assert.equal(resolveMobileSidebarSwipeMovement('open', 24, 12), 'tracking');
  assert.equal(resolveMobileSidebarSwipeMovement('open', -12, 0), 'cancelled');
  assert.equal(resolveMobileSidebarSwipeMovement('close', -18, 9), 'tracking');
  assert.equal(resolveMobileSidebarSwipeMovement('close', 12, 0), 'cancelled');
});

test('距离达标或快速短滑可以提交，普通短滑回弹', () => {
  assert.equal(shouldCommitMobileSidebarSwipe(56, 500), true);
  assert.equal(shouldCommitMobileSidebarSwipe(30, 50), true);
  assert.equal(shouldCommitMobileSidebarSwipe(27, 40), false);
  assert.equal(shouldCommitMobileSidebarSwipe(40, 200), false);
});

test('展开与折叠手势使用相反方向并限制在面板宽度内', () => {
  assert.equal(getMobileSidebarSwipeDistance('open', 80), 80);
  assert.equal(getMobileSidebarSwipeDistance('open', -20), 0);
  assert.equal(getMobileSidebarSwipeDistance('close', -80), 80);
  assert.equal(getMobileSidebarSwipeTranslateX('open', 288, 80), -208);
  assert.equal(getMobileSidebarSwipeTranslateX('close', 288, 80), -80);
  assert.equal(getMobileSidebarSwipeTranslateX('open', 288, 400), 0);
  assert.equal(getMobileSidebarSwipeTranslateX('close', 288, 400), -288);
});
