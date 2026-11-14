import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getApprovalTrustChoiceDetail,
  getApprovalTrustDurationChoice,
  getApprovalTrustRefreshDelay,
  getApprovalTrustStatusPresentation,
} from './approval-trust-presentation.ts';

const state = (effective, overrides = {}) => ({ projectSetting: null, sessionSetting: null, effective, ...overrides });
const manual = { trusted: false, source: 'manual', effectiveScope: null, expiresAt: null, sessionOverridesProject: false, diagnostic: null };

test('常驻入口区分人工、会话信任、项目信任和会话人工覆盖', () => {
  assert.equal(getApprovalTrustStatusPresentation(state(manual), 1_000).label, '人工审核');
  const sessionTrust = { scope: 'session', mode: 'trusted', expiresAt: 61_000, createdAt: 1, updatedAt: 1 };
  const projectTrust = { scope: 'project', mode: 'trusted', expiresAt: null, createdAt: 1, updatedAt: 1 };
  const manualOverride = { scope: 'session', mode: 'manual', expiresAt: null, createdAt: 1, updatedAt: 1 };
  assert.match(getApprovalTrustStatusPresentation(state({ ...manual, trusted: true, source: 'session_trust', effectiveScope: 'session', expiresAt: 61_000 }, { sessionSetting: sessionTrust }), 1_000).label, /^会话信任 · /);
  assert.match(getApprovalTrustStatusPresentation(state({ ...manual, trusted: true, source: 'project_trust', effectiveScope: 'project', expiresAt: null }, { projectSetting: projectTrust }), 1_000).label, /^项目信任 · 永久$/);
  assert.equal(getApprovalTrustStatusPresentation(state({ ...manual, effectiveScope: 'session', sessionOverridesProject: true }, { sessionSetting: manualOverride, projectSetting: projectTrust }), 1_000).label, '会话人工覆盖项目信任');
});

test('已到期的服务端快照立即按人工显示', () => {
  const expired = state({ ...manual, trusted: true, source: 'session_trust', effectiveScope: 'session', expiresAt: 1_000 }, {
    sessionSetting: { scope: 'session', mode: 'trusted', expiresAt: 1_000, createdAt: 1, updatedAt: 1 },
  });
  assert.equal(getApprovalTrustStatusPresentation(expired, 1_000).label, '人工审核');
});

test('最后一分钟按秒更新倒计时', () => {
  const sessionTrust = { scope: 'session', mode: 'trusted', expiresAt: 60_000, createdAt: 1, updatedAt: 1 };
  const trusted = state({ ...manual, trusted: true, source: 'session_trust', effectiveScope: 'session', expiresAt: 60_000 }, {
    sessionSetting: sessionTrust,
  });
  assert.equal(getApprovalTrustStatusPresentation(trusted, 1_000).label, '会话信任 · 剩余 59 秒');
  assert.equal(getApprovalTrustStatusPresentation(trusted, 1_001).label, '会话信任 · 剩余 59 秒');
  assert.equal(getApprovalTrustStatusPresentation(trusted, 59_001).label, '会话信任 · 剩余 1 秒');
});

test('超过一分钟按分钟展示，不显示秒数', () => {
  const sessionTrust = { scope: 'session', mode: 'trusted', expiresAt: 3_601_000, createdAt: 1_000, updatedAt: 1_000 };
  const trusted = state({ ...manual, trusted: true, source: 'session_trust', effectiveScope: 'session', expiresAt: 3_601_000 }, {
    sessionSetting: sessionTrust,
  });
  assert.equal(getApprovalTrustStatusPresentation(trusted, 1_000).label, '会话信任 · 剩余 1 小时');
  assert.equal(getApprovalTrustStatusPresentation(trusted, 2_000).label, '会话信任 · 剩余 1 小时');
  assert.equal(getApprovalTrustStatusPresentation(trusted, 62_000).label, '会话信任 · 剩余 59 分钟');
});

test('倒计时按当前显示精度安排下一次刷新', () => {
  assert.equal(getApprovalTrustRefreshDelay([3_601_000], 1_000), 60_000);
  assert.equal(getApprovalTrustRefreshDelay([3_600_500], 1_000), 59_500);
  assert.equal(getApprovalTrustRefreshDelay([60_500], 1_000), 500);
  assert.equal(getApprovalTrustRefreshDelay([10_500], 1_000), 500);
  assert.equal(getApprovalTrustRefreshDelay([null, 1_000], 1_000), null);
});

test('已到期的时长设置不再保持选中，可直接选择相同时长续期', () => {
  const oneHour = { scope: 'session', mode: 'trusted', expiresAt: 3_601_000, createdAt: 1_000, updatedAt: 1_000 };
  assert.equal(getApprovalTrustDurationChoice(oneHour, 3_600_999), 'one_hour');
  assert.equal(getApprovalTrustDurationChoice(oneHour, 3_601_000), null);
  assert.equal(getApprovalTrustDurationChoice({ ...oneHour, expiresAt: null }, 9_999), 'permanent');
});

test('定时信任按保存完成后的当前时间展示整小时剩余量', () => {
  const savedAt = 10_000;
  const displayedAt = savedAt + 250;
  for (const [hours, source] of [[1, 'session_trust'], [8, 'project_trust']]) {
    const expiresAt = savedAt + hours * 60 * 60_000;
    const scope = source === 'session_trust' ? 'session' : 'project';
    const setting = { scope, mode: 'trusted', expiresAt, createdAt: savedAt, updatedAt: savedAt };
    assert.equal(getApprovalTrustStatusPresentation(state({
      ...manual,
      trusted: true,
      source,
      effectiveScope: scope,
      expiresAt,
    }, { [`${scope}Setting`]: setting }), displayedAt).label, `${scope === 'session' ? '会话' : '项目'}信任 · 剩余 ${hours} 小时`);
  }
});

test('客户端时钟略慢时剩余时间不超过所选信任期限', () => {
  const savedAt = 10_000;
  const displayedAt = savedAt - 250;
  const expiresAt = savedAt + 60 * 60_000;
  const sessionTrust = { scope: 'session', mode: 'trusted', expiresAt, createdAt: savedAt, updatedAt: savedAt };
  assert.equal(getApprovalTrustStatusPresentation(state({
    ...manual,
    trusted: true,
    source: 'session_trust',
    effectiveScope: 'session',
    expiresAt,
  }, { sessionSetting: sessionTrust }), displayedAt).label, '会话信任 · 剩余 1 小时');
});

test('选中项用当前状态替换固定说明且保持两行信息密度', () => {
  const now = 60_000;
  const sessionTrust = { scope: 'session', mode: 'trusted', expiresAt: now + 7 * 60 * 60_000 + 36 * 60_000, createdAt: 1, updatedAt: 1 };
  const projectTrust = { scope: 'project', mode: 'trusted', expiresAt: now + 5 * 60_000, createdAt: 1, updatedAt: 1 };
  const sessionManual = { scope: 'session', mode: 'manual', expiresAt: null, createdAt: 1, updatedAt: 1 };

  assert.deepEqual(getApprovalTrustChoiceDetail(state({ ...manual, trusted: true, source: 'session_trust', effectiveScope: 'session', expiresAt: sessionTrust.expiresAt }, { sessionSetting: sessionTrust }), 'session', now), {
    label: '当前生效 · 剩余 7 小时 36 分钟',
    tone: 'success',
  });
  assert.deepEqual(getApprovalTrustChoiceDetail(state({ ...manual, trusted: true, source: 'project_trust', effectiveScope: 'project', expiresAt: projectTrust.expiresAt }, { projectSetting: projectTrust }), 'session', now), {
    label: '继承项目信任 · 剩余 5 分钟',
    tone: 'warning',
  });
  assert.deepEqual(getApprovalTrustChoiceDetail(state({ ...manual, effectiveScope: 'session' }, { sessionSetting: sessionManual }), 'session', now), {
    label: '当前生效 · 逐次由你确认',
    tone: 'muted',
  });
  assert.deepEqual(getApprovalTrustChoiceDetail(state(manual), 'project', now), {
    label: '当前项目未启用信任',
    tone: 'muted',
  });
});

test('永久、跟随人工和到期状态使用稳定文案', () => {
  const permanentProject = { scope: 'project', mode: 'trusted', expiresAt: null, createdAt: 1, updatedAt: 1 };
  assert.deepEqual(getApprovalTrustChoiceDetail(state({ ...manual, trusted: true, source: 'project_trust', effectiveScope: 'project' }, { projectSetting: permanentProject }), 'project', 1_000), {
    label: '当前生效 · 长期有效',
    tone: 'success',
  });
  assert.deepEqual(getApprovalTrustChoiceDetail(state(manual), 'session', 1_000), {
    label: '当前跟随项目 · 人工审核',
    tone: 'muted',
  });
  const expiredProject = { ...permanentProject, expiresAt: 1_000 };
  assert.deepEqual(getApprovalTrustChoiceDetail(state({ ...manual, trusted: true, source: 'project_trust', effectiveScope: 'project', expiresAt: 1_000 }, { projectSetting: expiredProject }), 'project', 1_000), {
    label: '当前项目未启用信任',
    tone: 'muted',
  });
});
