import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getNextFollowLatestState } from './message-auto-scroll.ts';

const messageListSource = fs.readFileSync(new URL('./MessageList.tsx', import.meta.url), 'utf8');

test('手动展开暂停期间，贴底钳制和内容增高都不能重新开启跟随', () => {
  for (const [scrollTop,distanceToBottom] of [[900,0],[1000,180],[1200,0.5]]) {
    assert.equal(getNextFollowLatestState({followingLatest:true,previousScrollTop:1000,scrollTop,distanceToBottom,manuallyPaused:true}),false);
  }
});

test('显式解除手动暂停后可以重新跟随底部', () => {
  assert.equal(getNextFollowLatestState({followingLatest:false,previousScrollTop:900,scrollTop:1200,distanceToBottom:0,manuallyPaused:false}),true);
});

test('流式内容增高但滚动位置未向上移动时继续跟随底部', () => {
  assert.equal(getNextFollowLatestState({
    followingLatest: true,
    previousScrollTop: 1000,
    scrollTop: 1000,
    distanceToBottom: 180,
  }), true);
});

test('用户主动向上滚动并离开底部后停止跟随', () => {
  assert.equal(getNextFollowLatestState({
    followingLatest: true,
    previousScrollTop: 1000,
    scrollTop: 920,
    distanceToBottom: 160,
  }), false);
});

test('用户在原底部缓冲区内慢速向上滚动也立即停止跟随', () => {
  assert.equal(getNextFollowLatestState({
    followingLatest: true,
    previousScrollTop: 1000,
    scrollTop: 990,
    distanceToBottom: 10,
  }), false);
});

test('已经停止跟随后向下滚动但未到底部时保持停止', () => {
  assert.equal(getNextFollowLatestState({
    followingLatest: false,
    previousScrollTop: 920,
    scrollTop: 980,
    distanceToBottom: 100,
  }), false);
});

test('停止跟随后进入原底部缓冲区不会提前恢复', () => {
  assert.equal(getNextFollowLatestState({
    followingLatest: false,
    previousScrollTop: 980,
    scrollTop: 1040,
    distanceToBottom: 40,
  }), false);
});

test('真正到达底部后恢复跟随', () => {
  assert.equal(getNextFollowLatestState({
    followingLatest: false,
    previousScrollTop: 1040,
    scrollTop: 1079.5,
    distanceToBottom: 0.5,
  }), true);
});

test('视口变化将位置钳制到底部时不误判为用户上滑', () => {
  assert.equal(getNextFollowLatestState({
    followingLatest: true,
    previousScrollTop: 1200,
    scrollTop: 900,
    distanceToBottom: 0,
  }), true);
});

test('连续的亚像素慢速上滚在离开贴底误差后停止跟随', () => {
  let followingLatest = true;
  let previousScrollTop = 1000;

  for (const [scrollTop, distanceToBottom] of [[999.25, 0.75], [998.5, 1.5]]) {
    followingLatest = getNextFollowLatestState({
      followingLatest,
      previousScrollTop,
      scrollTop,
      distanceToBottom,
    });
    previousScrollTop = scrollTop;
  }

  assert.equal(followingLatest, false);
});

test('消息列表观察真实内容层尺寸并复用单一滚动帧', () => {
  assert.match(messageListSource, /ref=\{contentRef\}/);
  assert.match(messageListSource, /observer\.observe\(content\)/);
  assert.match(messageListSource, /autoScrollFrameRef\.current !== null/);
  assert.match(messageListSource, /autoScrollFrameRef\.current = requestAnimationFrame/);
});

test('组件清理初始滚动帧后释放任务标记以兼容 React 严格模式重挂载', () => {
  assert.match(
    messageListSource,
    /cancelAnimationFrame\(autoScrollFrameRef\.current\);\s*autoScrollFrameRef\.current = null;/,
  );
});

test('消息列表使用滚动方向判断用户是否主动离开底部', () => {
  assert.match(messageListSource, /getNextFollowLatestState\(\{/);
  assert.match(messageListSource, /previousScrollTop: previousScrollTopRef\.current/);
  assert.match(messageListSource, /previousScrollTopRef\.current = container\.scrollTop/);
});
