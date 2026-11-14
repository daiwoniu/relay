import assert from 'node:assert/strict';
import test from 'node:test';
import { formatEngineReleaseTime, getEngineMaintenancePresentation, getReleaseOverviewPresentation } from './engine-maintenance-presentation.ts';
import { getEngineSummary, selectEngineId } from './engine-maintenance-layout.ts';

const engine = (overrides = {}) => ({
  engineId: 'codex', label: 'Codex', installedVersion: '1.2.3', runningVersion: '1.2.3', latestVersion: '1.2.3',
  updateAvailable: false, latestCheckStatus: 'success', latestCheckedAt: 1, installSource: 'official_npm_global',
  activeTaskCount: 0, activeInstanceCount: 0, instanceVersions: [], readiness: 'ready', readinessCheckedAt: 1,
  availabilityStage: 'ready', recommendedAction: null, actions: [], ...overrides,
});

test('发布时间按浏览器本地时区精确到分钟且无效值隐藏', () => {
  const timestamp = new Date(2026, 7, 24, 8, 28, 59).getTime();
  assert.equal(formatEngineReleaseTime(timestamp), '2026-08-24 08:28');
  assert.equal(formatEngineReleaseTime(null), null);
  assert.equal(formatEngineReleaseTime(Number.NaN), null);
  assert.equal(formatEngineReleaseTime(Number.MAX_SAFE_INTEGER), null);
});

test('正常态保持安静且不自动展开安装详情', () => {
  const result = getEngineMaintenancePresentation(engine());
  assert.equal(result.statusLabel, '运行正常');
  assert.equal(result.statusTone, 'success');
  assert.equal(result.versionHeadline, '已是最新版本');
  assert.equal(result.openInstallationDetails, false);
});

test('存在更新时突出新旧版本并只选一个推荐动作', () => {
  const result = getEngineMaintenancePresentation(engine({
    latestVersion: '1.3.0', updateAvailable: true, recommendedAction: 'upgrade_and_restart',
    actions: [
      { action: 'restart', label: '重启', enabled: true, reason: null, interruptsActiveTasks: false },
      { action: 'upgrade_and_restart', label: '升级并重启', enabled: true, reason: null, interruptsActiveTasks: false },
    ],
  }));
  assert.equal(result.versionHeadline, 'v1.2.3 → v1.3.0');
  assert.equal(result.primaryAction?.action, 'upgrade_and_restart');
  assert.deepEqual(result.secondaryActions.map((item) => item.action), ['restart']);
  assert.equal(result.openInstallationDetails, true);
});

test('未安装、待登录和 readiness 失败使用明确状态语义', () => {
  assert.deepEqual(
    getEngineMaintenancePresentation(engine({ installedVersion: null, runningVersion: null, availabilityStage: 'not_installed', readiness: 'unknown' })).statusLabel,
    '尚未安装',
  );
  assert.equal(getEngineMaintenancePresentation(engine({ availabilityStage: 'installed_auth_required', loginCommand: 'codex login' })).statusLabel, '需要登录');
  assert.equal(getEngineMaintenancePresentation(engine({ availabilityStage: 'readiness_failed', readiness: 'failed' })).statusTone, 'danger');
  const failedAuthStage = getEngineMaintenancePresentation(engine({ availabilityStage: 'installed_auth_required', readiness: 'failed' }));
  assert.equal(failedAuthStage.statusLabel, '运行异常');
  assert.equal(failedAuthStage.statusTone, 'danger');
});

test('运行版本不一致和安装来源异常自动展开详情', () => {
  assert.equal(getEngineMaintenancePresentation(engine({ runningVersion: '1.2.2' })).openInstallationDetails, true);
  assert.equal(getEngineMaintenancePresentation(engine({ installSource: 'unknown' })).openInstallationDetails, true);
});

test('标准发布概览使用中文计数、主题和补充统计', () => {
  assert.deepEqual(getReleaseOverviewPresentation({
    sourceStatus: 'available',
    counts: { features: 3, improvements: 0, fixes: 6, documentation: 1, chores: 2 },
    topics: ['permissions_security', 'mcp_extensions', 'plugins_skills'],
    officialSource: 'codex_github',
    officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.151.0',
  }), {
    headline: '3 项功能增强 · 6 项问题修复',
    detail: '重点涉及安全、权限与沙箱、MCP 与扩展、插件与 Skills',
    supplemental: '另含 1 项文档、2 项内部维护',
  });
});

test('CodeBuddy 复用版本概览并显示官方改进数量', () => {
  assert.deepEqual(getReleaseOverviewPresentation({
    sourceStatus: 'available',
    counts: { features: 3, improvements: 3, fixes: 18, documentation: 1, chores: 0 },
    topics: ['plugins_skills', 'tasks_sessions', 'models_providers'],
    officialSource: 'codebuddy_cnb',
    officialUrl: 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/release-notes/v2.142.0.md',
  }), {
    headline: '3 项功能增强 · 3 项优化 · 18 项问题修复',
    detail: '重点涉及插件与 Skills、任务与会话、模型与 Provider',
    supplemental: '另含 1 项文档',
  });
});

test('单项修复、仅 Changelog 和不可用状态不强凑内容', () => {
  assert.deepEqual(getReleaseOverviewPresentation({
    sourceStatus: 'available',
    counts: { features: 0, improvements: 0, fixes: 1, documentation: 0, chores: 0 },
    topics: ['permissions_security'],
    officialSource: 'codex_github',
    officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.146.1',
  }), {
    headline: '维护版本 · 1 项问题修复',
    detail: '涉及安全、权限与沙箱',
    supplemental: null,
  });
  assert.equal(getReleaseOverviewPresentation({
    sourceStatus: 'metadata_only', counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 }, topics: [],
    officialSource: 'codex_github',
    officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.149.1',
  }).headline, '官方未提供分类说明');
  assert.equal(getReleaseOverviewPresentation({
    sourceStatus: 'unavailable', counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 }, topics: [],
    officialSource: 'codex_github',
    officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.151.0',
  }).headline, '官方说明暂时无法读取');
  assert.deepEqual(getReleaseOverviewPresentation({
    sourceStatus: 'unrecognized', counts: { features: 0, improvements: 0, fixes: 0, documentation: 0, chores: 0 }, topics: [],
    officialSource: 'codex_github',
    officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.152.0',
  }), {
    headline: '官方未提供可解析的版本说明',
    detail: '未生成推测性摘要，请查看官方页面',
    supplemental: null,
  });
});

test('引擎摘要只投影首屏需要的状态和版本信息', () => {
  const summary = getEngineSummary(engine({
    label: 'CodeBuddy', latestVersion: '1.3.0', updateAvailable: true,
    activeTaskCount: 2, activeInstanceCount: 3, statusMessage: '存在活动实例',
  }));
  assert.deepEqual(summary, {
    label: 'CodeBuddy',
    statusLabel: '运行正常',
    statusTone: 'success',
    versionLabel: 'v1.2.3 → v1.3.0',
    activityLabel: '2 个任务 · 3 个实例',
    statusMessage: '存在活动实例',
  });
});

test('选择的引擎不存在时回退到快照中的第一个引擎', () => {
  const engines = [engine({ engineId: 'codex' }), engine({ engineId: 'codebuddy', label: 'CodeBuddy' })];
  assert.equal(selectEngineId('codebuddy', engines), 'codebuddy');
  assert.equal(selectEngineId('opencode', engines), 'codex');
  assert.equal(selectEngineId(null, []), null);
});
