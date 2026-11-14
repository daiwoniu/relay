import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { toRecoveryRequestAction, canIgnoreRecoveryConfirmationError } from './service-maintenance-operation.ts';
import { ApiError } from '../api/client.ts';
import { pollForRecovery } from './recovery-flow.ts';

test('维护动作只映射固定服务枚举', () => {
  assert.equal(toRecoveryRequestAction('restart_backend'), 'restart_backend');
  assert.equal(toRecoveryRequestAction('restart_frontend'), 'restart_frontend');
  assert.equal(toRecoveryRequestAction('restart_relay'), 'restart_relay');
  assert.equal(toRecoveryRequestAction('reload_browser'), null);
});

test('确认失效属于结果未知，必须观察实例切换，不能把短暂断网当成功', async () => {
  const expired = new ApiError(409, { error: '服务恢复确认已失效', code: 'RECOVERY_CONFIRMATION_EXPIRED' });
  assert.equal(canIgnoreRecoveryConfirmationError(expired), true);
  assert.equal(canIgnoreRecoveryConfirmationError(new ApiError(409, { error: '构建失败', code: 'RECOVERY_RESTART_FAILED' })), false);
  assert.equal(canIgnoreRecoveryConfirmationError(new ApiError(403, { error: '权限不足' })), false);
  let clock = 0; let calls = 0;
  const unchanged = await pollForRecovery({ target: 'relay', clientProtocolVersion: 34, requireExplicitRestartObserved: true,
    timeoutMs: 20, intervalMs: 5, now: () => clock, wait: async (ms) => { clock += ms; },
    probe: async () => { if (++calls === 1) throw new Error('network unavailable');
      return { healthy: true, serverProtocolVersion: 34, restartObserved: false, operationInProgress: false }; } });
  assert.equal(unchanged.status, 'timeout');
  const switched = await pollForRecovery({ target: 'relay', clientProtocolVersion: 34, requireExplicitRestartObserved: true,
    probe: async () => ({ healthy: true, serverProtocolVersion: 34, restartObserved: true, operationInProgress: false }) });
  assert.equal(switched.status, 'ready');
});
test('共享 Hook 保留二阶段确认和有限轮询', async () => {
  const source = await readFile(new URL('../hooks/useServiceMaintenance.ts', import.meta.url), 'utf8');
  assert.match(source, /confirmServiceRecovery/);
  assert.match(source, /pollForRecovery/);
  assert.match(source, /response\.target === 'frontend'[\s\S]*?\? 90_000/);
  assert.doesNotMatch(source, /codex_upgrade|setup_and_restart/);
});
