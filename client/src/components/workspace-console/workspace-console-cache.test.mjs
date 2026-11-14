import assert from 'node:assert/strict';
import test from 'node:test';
import { CACHE_TTL_MS, RESPONSIBILITY_CACHE_TTL_MS, CODEX_CACHE_TTL_MS, coalesceWorkspaceRequest, invalidateWorkspaceDashboard, loadWorkspaceCodexAccount, loadWorkspaceDashboard, readWorkspaceCodexCache, readWorkspaceConsoleCache, rememberDashboard, rememberResponsibility } from './workspace-console-cache.ts';
import { hasWorkspaceCodexResourceOwner, loadWorkspaceCodexResources, subscribeWorkspaceCodexCache } from './workspace-console-cache.ts';

test('资源读取同时通知侧栏和卡片，订阅按用户隔离且可以取消', async () => {
  const observed = [];
  const card = subscribeWorkspaceCodexCache('shared-codex', (value) => observed.push(['card', value.fetchedAt]), true);
  const sidebar = subscribeWorkspaceCodexCache('shared-codex', (value) => observed.push(['sidebar', value.fetchedAt]));
  const other = subscribeWorkspaceCodexCache('other-codex', () => assert.fail('cross-user notification'));
  try {
    assert.equal(hasWorkspaceCodexResourceOwner('shared-codex'), true);
    assert.equal(hasWorkspaceCodexResourceOwner('other-codex'), false);
    await loadWorkspaceCodexResources('shared-codex', async () => ({ account: { status: 'ready', fetchedAt: 1000 }, localUsage: null }));
    assert.deepEqual(observed, [['card', 1000], ['sidebar', 1000]]);
    card();
    assert.equal(hasWorkspaceCodexResourceOwner('shared-codex'), false);
    await loadWorkspaceCodexAccount('shared-codex', async () => ({ status: 'ready', fetchedAt: 2000 }), true);
    assert.deepEqual(observed.at(-1), ['sidebar', 2000]);
    assert.equal(observed.length, 3);
  } finally { card(); sidebar(); other(); }
});

test('较早资源请求晚返回时不能覆盖更新后的账号缓存', async () => {
  let complete;
  const old = loadWorkspaceCodexResources('codex-resource-race', () => new Promise((resolve) => { complete = resolve; }));
  await loadWorkspaceCodexAccount('codex-resource-race', async () => ({ status: 'ready', fetchedAt: 2000 }), true);
  complete({ account: { status: 'ready', fetchedAt: 1000 } });
  await old;
  assert.equal(readWorkspaceCodexCache('codex-resource-race', 2001).value.fetchedAt, 2000);
});

test('successful Feishu and Codex snapshots survive a full page reload in the same tab', async () => {
  const previous = globalThis.sessionStorage;
  const entries = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
  try {
    const before = await import('./workspace-console-cache.ts?cache-reload-before');
    before.rememberResponsibility('reload-user', { sourceUserKey: 'u', workbenchItems: [], items: [{ workItemId: '123' }] }, 1_000);
    await before.loadWorkspaceCodexAccount('reload-user', async () => ({ status: 'ready', fetchedAt: 1_000, rateLimits: [] }), false, 1_000);
    const after = await import('./workspace-console-cache.ts?cache-reload-after');
    assert.equal(after.readWorkspaceConsoleCache('reload-user', 1_000 + RESPONSIBILITY_CACHE_TTL_MS - 1).responsibilityFresh, true);
    assert.equal(after.readWorkspaceCodexCache('reload-user', 1_000 + CODEX_CACHE_TTL_MS - 1).fresh, true);
    assert.equal(after.readWorkspaceConsoleCache('other-user', 1_000).responsibility, null);
  } finally { globalThis.sessionStorage = previous; }
});

test('a pre-workbench cached responsibility report is fetched again after reload', async () => {
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => JSON.stringify({ responsibility: {
    fetchedAt: 1_000, value: { items: [{ workItemId: '123' }] },
  } }), setItem: () => {} };
  try {
    const cache = await import('./workspace-console-cache.ts?old-workbench-shape');
    assert.equal(cache.readWorkspaceConsoleCache('legacy-user', 1_001).responsibilityFresh, false);
    assert.equal(cache.readWorkspaceConsoleCache('legacy-user', 1_001).responsibility, null);
  } finally { globalThis.sessionStorage = previous; }
});

test('legacy Codex usage snapshots are refreshed instead of hiding newer official metrics', async () => {
  const previous = globalThis.sessionStorage;
  const entries = new Map([['relay:workspace-console:legacy-usage-user', JSON.stringify({ codex: {
    fetchedAt: 1_000,
    value: { status: 'ready', fetchedAt: 1_000, usage: { lifetimeTokens: 500, peakDailyTokens: 50, dailyUsageBuckets: [] } },
  } })]]);
  globalThis.sessionStorage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  try {
    const cache = await import('./workspace-console-cache.ts?legacy-usage-refresh');
    assert.equal(cache.readWorkspaceCodexCache('legacy-usage-user', 1_001).fresh, false);
    let reads = 0;
    const fresh = await cache.loadWorkspaceCodexAccount('legacy-usage-user', async () => {
      reads += 1;
      return { status: 'ready', fetchedAt: 1_002, usage: { lifetimeTokens: 500, peakDailyTokens: 50,
        longestRunningTurnSec: 60, currentStreakDays: 2, longestStreakDays: 4, dailyUsageBuckets: [] } };
    }, false, 1_001);
    assert.equal(reads, 1);
    assert.equal(fresh.usage.longestRunningTurnSec, 60);
    assert.equal(cache.readWorkspaceCodexCache('legacy-usage-user', 1_002).fresh, true);
  } finally { globalThis.sessionStorage = previous; }
});

test('legacy reset-credit snapshots refresh to obtain selectable credit IDs', async () => {
  const previous = globalThis.sessionStorage;
  const entries = new Map([['relay:workspace-console:legacy-reset-user', JSON.stringify({ codex: {
    fetchedAt: 1_000, value: { status: 'ready', fetchedAt: 1_000, usage: null,
      rateLimitResetCredits: { availableCount: 1, credits: [{ title: '完全重置', expiresAt: 2_000 }] } },
  } })]]);
  globalThis.sessionStorage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  try {
    const cache = await import('./workspace-console-cache.ts?legacy-reset-refresh');
    assert.equal(cache.readWorkspaceCodexCache('legacy-reset-user', 1_001).fresh, false);
  } finally { globalThis.sessionStorage = previous; }
});

test('reuses the dashboard for one hour and Feishu responsibility for three hours', () => {
  const dashboard = { tasks: [{ id: 'local' }] };
  const responsibility = { items: [{ workItemId: '123' }] };
  rememberDashboard('cache-admin-a', dashboard, 1_000);
  rememberResponsibility('cache-admin-a', responsibility, 2_000);
  const fresh = readWorkspaceConsoleCache('cache-admin-a', 1_000 + CACHE_TTL_MS - 1);
  assert.equal(fresh.dashboard, dashboard);
  assert.equal(fresh.responsibility, responsibility);
  assert.equal(fresh.dashboardFresh, true);
  assert.equal(fresh.responsibilityFresh, true);
  const expired = readWorkspaceConsoleCache('cache-admin-a', 1_000 + CACHE_TTL_MS);
  assert.equal(expired.dashboardFresh, false);
  assert.equal(expired.responsibilityFresh, true);
  assert.equal(readWorkspaceConsoleCache('cache-admin-a', 2_000 + RESPONSIBILITY_CACHE_TTL_MS - 1).responsibilityFresh, true);
  assert.equal(readWorkspaceConsoleCache('cache-admin-a', 2_000 + RESPONSIBILITY_CACHE_TTL_MS).responsibilityFresh, false);
  const otherUser = readWorkspaceConsoleCache('cache-admin-b', 2_000);
  assert.equal(otherUser.dashboard, null);
  assert.equal(otherUser.responsibility, null);
});

test('Codex cache is per user, and each mount checks the server while a manual refresh bypasses it', async () => {
  let reads = 0;
  const fetcher = async () => ({ status: 'ready', fetchedAt: 1_000 + ++reads, rateLimits: [] });
  const [first, second] = await Promise.all([
    loadWorkspaceCodexAccount('codex-a', fetcher, false, 1_000),
    loadWorkspaceCodexAccount('codex-a', fetcher, false, 1_000),
  ]);
  assert.equal(first, second);
  assert.equal(reads, 1);
  await loadWorkspaceCodexAccount('codex-a', fetcher, false, 1_001);
  assert.equal(reads, 2);
  assert.equal(readWorkspaceCodexCache('codex-a', 1_000 + CODEX_CACHE_TTL_MS - 1).fresh, true);
  assert.equal(readWorkspaceCodexCache('codex-a', 1_002 + CODEX_CACHE_TTL_MS).fresh, false);
  assert.equal(readWorkspaceCodexCache('codex-b', 1_001).value, null);
  await loadWorkspaceCodexAccount('codex-a', fetcher, true, 1_002);
  assert.equal(reads, 3);
  assert.equal(readWorkspaceCodexCache('codex-a', 1_002).value.fetchedAt, 1_003);
});

test('server snapshot keeps its original success time when cached in the browser', async () => {
  const old = 1_000;
  const now = old + CODEX_CACHE_TTL_MS + 1;
  await loadWorkspaceCodexAccount('codex-server-snapshot', async () => ({ status: 'ready', fetchedAt: old,
    rateLimits: [], sourceMeta: { state: 'snapshot', lastSuccessAt: old, lastAttemptAt: null, error: null } }), false, now);
  assert.equal(readWorkspaceCodexCache('codex-server-snapshot', now).fresh, false);
  await loadWorkspaceDashboard('dashboard-server-snapshot', async () => ({ tasks: [], errors: [], capturedAt: old,
    sourceMeta: { state: 'snapshot', lastSuccessAt: old, lastAttemptAt: null, error: null } }));
  assert.equal(readWorkspaceConsoleCache('dashboard-server-snapshot', old + CACHE_TTL_MS + 1).dashboardFresh, false);
});

test('an older quota request cannot replace a newer manual refresh', async () => {
  let finishOld;
  const old = loadWorkspaceCodexAccount('codex-race', () => new Promise((resolve) => { finishOld = resolve; }), false, 1_000);
  await loadWorkspaceCodexAccount('codex-race', async () => ({ status: 'ready', fetchedAt: 2, rateLimits: [] }), true, 1_001);
  finishOld({ status: 'ready', fetchedAt: 1, rateLimits: [] });
  await old;
  assert.equal(readWorkspaceCodexCache('codex-race', 1_002).value.fetchedAt, 2);
});

test('task association or session deletion invalidates the dashboard without discarding the Feishu source', () => {
  rememberDashboard('cache-admin-invalidate', { tasks: [{ id: 'old' }] }, 1_000);
  rememberResponsibility('cache-admin-invalidate', { items: [] }, 1_000);
  invalidateWorkspaceDashboard('cache-admin-invalidate');
  const cached = readWorkspaceConsoleCache('cache-admin-invalidate', 1_001);
  assert.equal(cached.dashboard, null);
  assert.equal(cached.dashboardFresh, false);
  assert.deepEqual(cached.responsibility, { items: [] });
});

test('a successful forced refresh replaces the cached snapshot and extends its age', () => {
  const latest = { tasks: [{ id: 'new' }] };
  rememberDashboard('cache-admin-c', { tasks: [] }, 1_000);
  rememberDashboard('cache-admin-c', latest, 1_000 + CACHE_TTL_MS);
  const snapshot = readWorkspaceConsoleCache('cache-admin-c', 1_000 + CACHE_TTL_MS + 1);
  assert.equal(snapshot.dashboard, latest);
  assert.equal(snapshot.dashboardFresh, true);
});

test('页面重新打开时即使台账缓存新鲜也重新请求当前会话', async () => {
  let reads = 0;
  const userId = 'live-task-action-refresh';
  const fetcher = async () => ({ capturedAt: Date.now(), errors: [], tasks: [], sessions: ++reads === 1 ? [] : [{ sessionId: 'new' }] });
  await loadWorkspaceDashboard(userId, fetcher);
  assert.equal(readWorkspaceConsoleCache(userId).dashboardFresh, true);
  const reopened = await loadWorkspaceDashboard(userId, fetcher);
  assert.equal(reads, 2);
  assert.deepEqual(reopened.sessions.map((session) => session.sessionId), ['new']);
});

test('concurrent page mounts share one request per user and source', async () => {
  let reads = 0;
  let complete;
  const first = coalesceWorkspaceRequest('cache-admin-d', 'dashboard', () => {
    reads += 1;
    return new Promise((resolve) => { complete = resolve; });
  });
  const second = coalesceWorkspaceRequest('cache-admin-d', 'dashboard', () => {
    reads += 1;
    return Promise.resolve('unexpected');
  });
  assert.equal(first, second);
  assert.equal(reads, 1);
  complete('done');
  assert.equal(await second, 'done');
  await coalesceWorkspaceRequest('cache-admin-d', 'dashboard', async () => { reads += 1; return 'next'; });
  assert.equal(reads, 2);
});

test('强制刷新在普通读取后执行且多个强制刷新合并为一次', async () => {
  let complete;
  let reads = 0;
  const warm = coalesceWorkspaceRequest('force-after-warm', 'responsibility', () => new Promise((resolve) => { complete = resolve; }));
  const force = () => { reads++; return Promise.resolve('fresh'); };
  const first = coalesceWorkspaceRequest('force-after-warm', 'responsibility', force, true);
  assert.equal(coalesceWorkspaceRequest('force-after-warm', 'responsibility', force, true), first);
  assert.equal(coalesceWorkspaceRequest('force-after-warm', 'responsibility', () => Promise.resolve('old')), first);
  complete('cached');
  assert.equal(await warm, 'cached');
  assert.equal(await first, 'fresh');
  assert.equal(reads, 1);
});

test('普通读取失败不会取消已排队的强制刷新', async () => {
  let fail;
  const warm = coalesceWorkspaceRequest('force-after-error', 'responsibility', () => new Promise((_resolve, reject) => { fail = reject; }));
  const first = coalesceWorkspaceRequest('force-after-error', 'responsibility', async () => 'recovered', true);
  fail(new Error('offline'));
  await assert.rejects(warm, /offline/);
  assert.equal(await first, 'recovered');
});

test('an invalidated in-flight dashboard read retries and caches only the new result', async () => {
  let finishOld;
  let reads = 0;
  const fetcher = () => {
    reads += 1;
    return reads === 1 ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve({ tasks: [{ id: 'new' }], errors: [] });
  };
  const first = loadWorkspaceDashboard('cache-admin-race', fetcher);
  invalidateWorkspaceDashboard('cache-admin-race');
  const second = loadWorkspaceDashboard('cache-admin-race', fetcher);
  assert.equal(reads, 2);
  finishOld({ tasks: [{ id: 'old' }], errors: [] });
  assert.deepEqual((await first).tasks, [{ id: 'new' }]);
  assert.deepEqual((await second).tasks, [{ id: 'new' }]);
  assert.deepEqual(readWorkspaceConsoleCache('cache-admin-race').dashboard.tasks, [{ id: 'new' }]);
});

test('an invalidated dashboard failure yields the newer successful read', async () => {
  let failOld;
  let reads = 0;
  const fetcher = () => ++reads === 1 ? new Promise((_, reject) => { failOld = reject; }) : Promise.resolve({ tasks: [{ id: 'recovered' }], errors: [] });
  const first = loadWorkspaceDashboard('cache-admin-recovered', fetcher);
  invalidateWorkspaceDashboard('cache-admin-recovered');
  failOld(new Error('old network failure'));
  assert.deepEqual((await first).tasks, [{ id: 'recovered' }]);
  assert.equal(reads, 2);
});
