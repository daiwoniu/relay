import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldAutoRefreshSnapshot, shouldRetryFailedSnapshot, snapshotNotice, canUseCodexReset, taskCountDisplay } from './workspace-persistent-snapshot.ts';

test('stale server snapshot refreshes once and a failed snapshot does not loop', () => {
  const now = 4_000_000;
  const old = { state: 'snapshot', lastSuccessAt: 1_000, lastAttemptAt: null, error: null };
  assert.equal(shouldAutoRefreshSnapshot(old, now, 60_000), true);
  assert.equal(shouldAutoRefreshSnapshot({ ...old, state: 'live' }, now, 60_000, true), true);
  assert.equal(shouldAutoRefreshSnapshot({ ...old, state: 'live' }, now, 60_000), false);
  assert.equal(shouldAutoRefreshSnapshot({ ...old, state: 'failed_snapshot', lastAttemptAt: now }, now, 60_000), false);
  assert.equal(shouldAutoRefreshSnapshot({ ...old, lastSuccessAt: now - 1_000 }, now, 60_000), false);
});

test('each failed source has one concise local notice with the old success time', () => {
  const meta = { state: 'failed_snapshot', lastSuccessAt: 1_000, lastAttemptAt: 2_000, error: 'request failed' };
  assert.match(snapshotNotice('飞书', meta), /^任务报表本次未完成更新，显示 .+ 的上次成功数据。$/);
  assert.match(snapshotNotice('Codex', meta), /^Codex 更新失败，显示 .+ 的旧数据。$/);
  assert.equal(snapshotNotice('飞书', { ...meta, state: 'snapshot' }), null);
});

test('failed task reports retry after a cooldown and stop retrying after success', () => {
  const failed = { state: 'failed_snapshot', lastSuccessAt: 1_000, lastAttemptAt: 10_000, error: 'invalid report' };
  assert.equal(shouldRetryFailedSnapshot(failed, 309_999, 0, 300_000), false);
  assert.equal(shouldRetryFailedSnapshot(failed, 310_000, 0, 300_000), true);
  assert.equal(shouldRetryFailedSnapshot(failed, 310_000, 309_000, 300_000), false);
  assert.equal(shouldRetryFailedSnapshot({ ...failed, state: 'live' }, 700_000, 0, 300_000), false);
});

test('old or unverified Codex credits require a live account read', () => {
  assert.equal(canUseCodexReset({ status: 'ready' }), false);
  assert.equal(canUseCodexReset({ status: 'ready', sourceMeta: { state: 'live' } }), false);
  assert.equal(canUseCodexReset({ status: 'ready', identityVerified: true }), false);
  assert.equal(canUseCodexReset({ status: 'ready', identityVerified: false, sourceMeta: { state: 'snapshot' } }), false);
  assert.equal(canUseCodexReset({ status: 'ready', identityVerified: true, sourceMeta: { state: 'failed_snapshot' } }), false);
  assert.equal(canUseCodexReset({ status: 'ready', identityVerified: true, sourceMeta: { state: 'live' } }), true);
});

test('stored task list keeps its count while missing data never displays a false zero', () => {
  assert.equal(taskCountDisplay(true, 7, false, true), '7 项 · 旧数据');
  assert.equal(taskCountDisplay(false, 0, false, false), '不可用');
  assert.equal(taskCountDisplay(false, 0, true, false), '读取中');
});
