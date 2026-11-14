import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getServiceMaintenanceCooldownRefreshDelay,
  getServiceMaintenancePolicy,
} from './service-maintenance-policy.ts';

const capabilities = { serverProtocolVersion: 10, backendStartedAt: 1, managedByLauncher: true, launcherControlVersion: 5, requiredLauncherControlVersion: 5, launcherCompatible: true, canRestartRelay: true, canRestartBackend: true, canRestartFrontend: true, canRepairEnvironment: false, activeTaskCount: 0, operationInProgress: false, backendRetryAfterMs: 0, frontendRetryAfterMs: 0, frontendMode: 'production', activeBuildId: 'abcdef12', activeBuildLabel: null, frontendBuildRequired: false, frontendBuildReason: null, setup: { required: false, blockedByConflicts: false, server: { needed: false, reason: 'ok' }, client: { needed: false, reason: 'ok' } }, setupOperation: null };
const policy = (next = {}) => getServiceMaintenancePolicy({ role: 'admin', mismatch: null, refreshed: false, capabilities: { ...capabilities, ...next }, loading: false, submitting: false });

test('服务维护包含受控环境修复动作但正常状态隐藏', () => {
  const result = policy();
  assert.deepEqual(Object.keys(result.actions), ['reload_browser', 'retry_connection', 'restart_backend', 'restart_frontend', 'restart_relay', 'repair_environment']);
  assert.equal(result.actions.restart_relay.label, '重启全部服务与启动器');
  assert.equal(result.actions.repair_environment.visible, false);
});
test('旧启动器显示版本过旧且不误报为未托管', () => {
  const result = policy({ launcherControlVersion: 3, launcherCompatible: false, canRestartRelay: false, canRestartBackend: false, canRestartFrontend: true });
  assert.match(result.statusReason ?? '', /启动器版本较旧/);
  assert.doesNotMatch(result.statusReason ?? '', /不是由/);
  assert.equal(result.actions.restart_frontend.enabled, true);
  assert.equal(result.actions.restart_backend.enabled, false);
  assert.equal(result.actions.restart_relay.enabled, false);
  assert.equal(result.recommendedAction, null);
});
test('环境异常时推荐页面修复且受权威能力控制', () => {
  const result = policy({ setup: { ...capabilities.setup, required: true }, canRepairEnvironment: true });
  assert.equal(result.recommendedAction, 'repair_environment');
  assert.equal(result.actions.repair_environment.visible, true);
  assert.equal(result.actions.repair_environment.enabled, true);
  assert.equal(result.actions.restart_backend.enabled, false);
});
test('活动任务阻断环境修复并展示原因', () => {
  const result = policy({ setup: { ...capabilities.setup, required: true }, canRepairEnvironment: false, activeTaskCount: 1 });
  assert.equal(result.actions.repair_environment.enabled, false);
  assert.match(result.actions.repair_environment.reason, /AI 任务/);
});
test('活动任务不阻断前端，后端保留危险确认', () => {
  const result = policy({ activeTaskCount: 2 });
  assert.equal(result.actions.restart_frontend.enabled, true);
  assert.equal(result.actions.restart_backend.interruptsActiveTasks, true);
});
test('重启冷却在最近一个倒计时结束时刷新权威能力', () => {
  assert.equal(getServiceMaintenanceCooldownRefreshDelay(null, 0), null);
  assert.equal(getServiceMaintenanceCooldownRefreshDelay(capabilities, 0), null);
  assert.equal(getServiceMaintenanceCooldownRefreshDelay({
    ...capabilities,
    backendRetryAfterMs: 30_000,
    frontendRetryAfterMs: 10_000,
  }, 4_000), 6_000);
  assert.equal(getServiceMaintenanceCooldownRefreshDelay({
    ...capabilities,
    backendRetryAfterMs: 30_000,
    frontendRetryAfterMs: 10_000,
  }, 10_000), 0);
});
