import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceIdentityRefreshTracker, createWorkspaceRefreshTracker } from './workspace-refresh-policy.ts';

test('操作记录旧缓存过期后失败，等待退避而不是每30秒再读', async () => {
  let now = 1000;
  const tracker = createWorkspaceRefreshTracker(() => now);
  const meta = { state: 'live', lastSuccessAt: now, lastAttemptAt: now, error: null };
  await tracker.track(Promise.resolve({}));
  now += 10 * 60_000;
  assert.equal(tracker.reason(meta, 10 * 60_000), 'auto');
  await assert.rejects(tracker.track(Promise.reject(new Error('offline'))));
  now += 30_000;
  assert.equal(tracker.reason(meta, 10 * 60_000), null);
  now += 5 * 60_000 - 30_000;
  assert.equal(tracker.reason(meta, 10 * 60_000), 'retry');
});

test('侧栏切换账号立即补读资源；自身发布和相同账号更新不重复读取', () => {
  const tracker = createWorkspaceIdentityRefreshTracker('A');
  tracker.received('A');
  tracker.observe('A');
  assert.equal(tracker.take(), false);
  tracker.observe('B');
  assert.equal(tracker.take(), true);
  assert.equal(tracker.take(), false);
  tracker.observe('B');
  assert.equal(tracker.take(), false);
  tracker.received('B');
  tracker.observe('B');
  assert.equal(tracker.take(), false);
});

test('读取中账号切换排队，旧账号晚到不吞掉补读；新响应已覆盖切换则无需补读', () => {
  const tracker = createWorkspaceIdentityRefreshTracker('A');
  tracker.received('A');
  tracker.observe('B');
  tracker.received('A');
  assert.equal(tracker.take(), true);
  tracker.observe('C');
  tracker.received('C');
  tracker.observe('C');
  assert.equal(tracker.take(), false);
});

test('台账和飞书在各自期限到期；读取中不重复刷新', async () => {
  let now = 1000;
  const tracker = createWorkspaceRefreshTracker(() => now);
  const meta = { state: 'live', lastSuccessAt: 1000, lastAttemptAt: 1000, error: null };
  now += 60 * 60_000;
  assert.equal(tracker.reason(meta, 60 * 60_000), 'auto');
  assert.equal(tracker.reason(meta, 3 * 60 * 60_000), null);
  let complete;
  const pending = tracker.track(new Promise((resolve) => { complete = resolve; }));
  assert.equal(tracker.reason(meta, 60 * 60_000), null);
  complete({ sourceMeta: meta });
  await pending;
});

test('首次无缓存与网络失败按5、10分钟退避，成功恢复后重置', async () => {
  let now = 1000;
  const tracker = createWorkspaceRefreshTracker(() => now);
  const fail = () => tracker.track(Promise.reject(new Error('network timeout')));
  await assert.rejects(fail(), /timeout/);
  now += 5 * 60_000 - 1;
  assert.equal(tracker.reason(undefined, 100), null);
  now++;
  assert.equal(tracker.reason(undefined, 100), 'retry');
  await assert.rejects(fail());
  now += 5 * 60_000;
  assert.equal(tracker.reason(undefined, 100), null);
  now += 5 * 60_000;
  assert.equal(tracker.reason(undefined, 100), 'retry');
  await tracker.track(Promise.resolve({ sourceMeta: { state: 'live', lastSuccessAt: now, lastAttemptAt: now, error: null } }));
  await assert.rejects(fail());
  now += 5 * 60_000;
  assert.equal(tracker.reason(undefined, 100), 'retry');
});

test('服务端旧快照失败也退避，共用同一请求不重复累计失败', async () => {
  let now = 1000;
  const tracker = createWorkspaceRefreshTracker(() => now);
  const meta = { state: 'failed_snapshot', lastSuccessAt: 1, lastAttemptAt: now, error: 'offline' };
  const request = Promise.resolve({ sourceMeta: meta });
  const first = tracker.track(request);
  assert.equal(tracker.track(request), first);
  await first;
  now += 5 * 60_000;
  assert.equal(tracker.reason(meta, 100), 'retry');
});

test('主动取消读取不会安排失败重试', async () => {
  let now = 1000;
  const tracker = createWorkspaceRefreshTracker(() => now);
  const error = new Error('cancelled');
  error.name = 'AbortError';
  await assert.rejects(tracker.track(Promise.reject(error)), /cancelled/);
  now += 60 * 60_000;
  assert.equal(tracker.reason(undefined, 100), null);
});

test('连续失败的退避上限为一小时', async () => {
  let now = 1000;
  const tracker = createWorkspaceRefreshTracker(() => now);
  for (let attempt = 0; attempt < 8; attempt++) await assert.rejects(tracker.track(Promise.reject(new Error('offline'))));
  now += 60 * 60_000 - 1;
  assert.equal(tracker.reason(undefined, 100), null);
  now++;
  assert.equal(tracker.reason(undefined, 100), 'retry');
});

test('没有来源元数据的成功读取仍按期限更新', async () => {
  let now = 1000;
  const tracker = createWorkspaceRefreshTracker(() => now);
  await tracker.track(Promise.resolve({ account: { authMode: 'apikey' } }));
  now += 99;
  assert.equal(tracker.reason(undefined, 100), null);
  now++;
  assert.equal(tracker.reason(undefined, 100), 'auto');
});
