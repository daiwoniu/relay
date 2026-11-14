import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalTrustStore, deriveEffectiveApprovalTrust } from './approval-trust.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const manualState = () => ({
  projectSetting: null,
  sessionSetting: null,
  effective: { trusted: false, source: 'manual', effectiveScope: null, expiresAt: null, sessionOverridesProject: false, diagnostic: null },
});

const trustedState = (scope, expiresAt = null) => ({
  projectSetting: scope === 'project' ? { scope, mode: 'trusted', expiresAt, createdAt: 1, updatedAt: 1 } : null,
  sessionSetting: scope === 'session' ? { scope, mode: 'trusted', expiresAt, createdAt: 1, updatedAt: 1 } : null,
  effective: { trusted: true, source: `${scope}_trust`, effectiveScope: scope, expiresAt, sessionOverridesProject: false, diagnostic: null },
});

test('项目与会话使用隔离缓存，切换 active session 不串状态', async () => {
  const api = {
    getProject: async () => trustedState('project'),
    getSession: async (id) => id === 's1' ? trustedState('session') : manualState(),
  };
  const store = createApprovalTrustStore({ api, now: () => 100 });
  await store.getState().activate({ projectId: 'p1', sessionId: 's1' });
  await store.getState().activate({ projectId: 'p1', sessionId: 's2' });
  const current = store.getState();
  assert.equal(current.activeSessionId, 's2');
  assert.equal(current.entries['session:s1'].state.effective.trusted, true);
  assert.equal(current.entries['session:s2'].state.effective.trusted, false);
  assert.equal(current.entries['project:p1'].state.effective.trusted, true);
  store.getState().dispose();
});

test('慢请求不能覆盖同 scope 的新请求或新的 active session', async () => {
  const old = deferred();
  const fresh = deferred();
  let count = 0;
  const store = createApprovalTrustStore({
    api: { getProject: async () => manualState(), getSession: async () => (++count === 1 ? old.promise : fresh.promise) },
    now: () => 100,
  });
  const first = store.getState().activate({ projectId: 'p1', sessionId: 's1' });
  const second = store.getState().refresh('session', 's1');
  fresh.resolve(trustedState('session'));
  await second;
  old.resolve(manualState());
  await first;
  assert.equal(store.getState().entries['session:s1'].state.effective.trusted, true);
  store.getState().dispose();
});

test('多端事件重取对应 scope，项目变化同时重取所属会话', async () => {
  const calls = [];
  const api = {
    getProject: async (id) => { calls.push(`project:${id}`); return manualState(); },
    getSession: async (id) => { calls.push(`session:${id}`); return manualState(); },
  };
  const store = createApprovalTrustStore({ api, now: () => 100 });
  await store.getState().activate({ projectId: 'p1', sessionId: 's1' });
  calls.length = 0;
  await store.getState().handleRemoteUpdate({ type: 'approval_trust_updated', scope: 'project', scopeId: 'p1' });
  assert.deepEqual(calls.sort(), ['project:p1', 'session:s1']);
  calls.length = 0;
  await store.getState().handleRemoteUpdate({ type: 'approval_trust_updated', scope: 'session', scopeId: 's1' });
  assert.deepEqual(calls, ['session:s1']);
  store.getState().dispose();
});

test('到期立即派生为人工且触发权威刷新，不改写原始 expiresAt', async () => {
  let now = 100;
  let scheduled;
  let refreshes = 0;
  const store = createApprovalTrustStore({
    api: { getProject: async () => manualState(), getSession: async () => { refreshes += 1; return trustedState('session', 200); } },
    now: () => now,
    schedule: (run) => { scheduled = run; return 1; },
    cancelSchedule: () => {},
  });
  await store.getState().activate({ projectId: 'p1', sessionId: 's1' });
  const raw = store.getState().entries['session:s1'].state;
  now = 200;
  assert.equal(deriveEffectiveApprovalTrust(raw, now).trusted, false);
  scheduled();
  await Promise.resolve();
  assert.equal(raw.effective.expiresAt, 200);
  assert.equal(refreshes, 2);
  store.getState().dispose();
});

test('会话人工设置只在有效项目信任存在时标记为覆盖', () => {
  const manualSession = { scope: 'session', mode: 'manual', expiresAt: null, createdAt: 1, updatedAt: 1 };
  const activeProject = { scope: 'project', mode: 'trusted', expiresAt: 200, createdAt: 1, updatedAt: 1 };
  const base = { ...manualState(), sessionSetting: manualSession };
  assert.equal(deriveEffectiveApprovalTrust(base, 100).sessionOverridesProject, false);
  assert.equal(deriveEffectiveApprovalTrust({ ...base, projectSetting: activeProject }, 100).sessionOverridesProject, true);
  assert.equal(deriveEffectiveApprovalTrust({ ...base, projectSetting: activeProject }, 200).sessionOverridesProject, false);
});

test('接口错误保留最后一次后端权威状态并记录错误', async () => {
  let fail = false;
  const store = createApprovalTrustStore({
    api: { getProject: async () => manualState(), getSession: async () => { if (fail) throw new Error('network'); return trustedState('session'); } },
    now: () => 100,
  });
  await store.getState().activate({ projectId: 'p1', sessionId: 's1' });
  fail = true;
  await store.getState().refresh('session', 's1');
  const entry = store.getState().entries['session:s1'];
  assert.equal(entry.state.effective.trusted, true);
  assert.equal(entry.status, 'error');
  assert.equal(entry.error, 'network');
  store.getState().dispose();
});

test('保存失败结束 saving 状态且不清空最后一次权威快照', async () => {
  const store = createApprovalTrustStore({
    api: {
      getProject: async () => manualState(),
      getSession: async () => trustedState('session'),
      putSession: async () => { throw new Error('save failed'); },
    },
    now: () => 100,
  });
  await store.getState().activate({ projectId: 'p1', sessionId: 's1' });
  assert.equal(await store.getState().setSessionTrust('s1', { mode: 'manual', duration: 'permanent' }), false);
  const entry = store.getState().entries['session:s1'];
  assert.equal(entry.saving, false);
  assert.equal(entry.state.effective.trusted, true);
  assert.equal(entry.error, 'save failed');
  store.getState().dispose();
});

test('项目保存成功后立即重取所属会话的 effective 状态', async () => {
  let sessionReads = 0;
  const store = createApprovalTrustStore({
    api: {
      getProject: async () => manualState(),
      getSession: async () => { sessionReads += 1; return manualState(); },
      putProject: async () => trustedState('project'),
    },
    now: () => 100,
  });
  await store.getState().activate({ projectId: 'p1', sessionId: 's1' });
  assert.equal(await store.getState().setProjectTrust('p1', 'one_hour'), true);
  assert.equal(sessionReads, 2);
  store.getState().dispose();
});

test('重置项目限时信任会沿用当前时长重新保存', async () => {
  const calls = [];
  const store = createApprovalTrustStore({
    api: {
      getProject: async () => trustedState('project', 3_601_000),
      getSession: async () => manualState(),
      putProject: async (id, duration) => { calls.push([id, duration]); return trustedState('project', 3_601_000); },
    },
    now: () => 1_000,
  });
  await store.getState().activate({ projectId: 'p1', sessionId: null });
  assert.equal(await store.getState().resetProjectTrust('p1', 'one_hour'), true);
  assert.deepEqual(calls, [['p1', 'one_hour']]);
  store.getState().dispose();
});

test('重置会话限时信任会沿用当前时长重新保存', async () => {
  const calls = [];
  const store = createApprovalTrustStore({
    api: {
      getProject: async () => manualState(),
      getSession: async () => trustedState('session', 3_601_000),
      putSession: async (id, setting) => { calls.push([id, setting]); return trustedState('session', 3_601_000); },
    },
    now: () => 1_000,
  });
  await store.getState().activate({ projectId: 'p1', sessionId: 's1' });
  assert.equal(await store.getState().resetSessionTrust('s1', { mode: 'trusted', duration: 'one_hour' }), true);
  assert.deepEqual(calls, [['s1', { mode: 'trusted', duration: 'one_hour' }]]);
  store.getState().dispose();
});
