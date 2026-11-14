import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  getRunningDurationPresentation,
  getSettledDurationPresentation,
} from './message-duration-presentation.ts';

test('耗时按秒、整分钟和分钟秒展示', () => {
  assert.equal(formatDuration(12_000), '12秒');
  assert.equal(formatDuration(120_000), '2分钟');
  assert.equal(formatDuration(135_000), '2分15秒');
});

test('运行中拆分为状态和已用时', () => {
  assert.equal(getRunningDurationPresentation('处理中', 12_000), '处理中 · 已用时 12秒');
  assert.equal(getRunningDurationPresentation('等待你的操作', 75_000), '等待你的操作 · 已用时 1分15秒');
  assert.equal(getRunningDurationPresentation('正在停止', 120_000), '正在停止 · 已用时 2分钟');
});

test('已结束消息保留完成时间并拆分状态和耗时', () => {
  const now = new Date(2026, 7, 9, 15, 0).getTime();
  const today = new Date(2026, 7, 9, 14, 26).getTime();
  const previousDay = new Date(2026, 7, 8, 23, 15).getTime();

  assert.equal(
    getSettledDurationPresentation(today, '已完成', 12_000, now),
    '14:26 · 已完成 · 耗时 12秒',
  );
  assert.equal(
    getSettledDurationPresentation(previousDay, '处理失败', 135_000, now),
    '08-08 23:15 · 处理失败 · 耗时 2分15秒',
  );
  assert.equal(
    getSettledDurationPresentation(today, '已完成', 12_000, now, true),
    '14:26 · 完成 · 12秒',
  );
});

test('缺少有效时间数据时不展示不完整文案', () => {
  assert.equal(getRunningDurationPresentation('处理中', 0), null);
  assert.equal(getSettledDurationPresentation(undefined, '已完成', 12_000), null);
  assert.equal(getSettledDurationPresentation(Date.now(), '已完成', null), null);
});

test('只有恢复后的非用户中断说明墙钟耗时可能包含离线等待', () => {
  const now = new Date(2026, 7, 9, 15, 0).getTime();
  assert.match(
    getSettledDurationPresentation(now, '执行中断', 69 * 60_000, now),
    /69分钟（可能包含离线\/恢复等待）$/,
  );
  assert.doesNotMatch(
    getSettledDurationPresentation(now, '已取消', 5_000, now),
    /离线\/恢复等待/,
  );
});
