import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { toRecoveryRequestAction, canIgnoreRecoveryConfirmationError, hasCompletedFrontendRestart } from './service-maintenance-operation.ts';
import { ApiError, parseApiResponse } from '../api/client.ts';
import { pollForRecovery } from './recovery-flow.ts';

test('维护动作只映射固定服务枚举', () => {
  assert.equal(toRecoveryRequestAction('restart_backend'), 'restart_backend');
  assert.equal(toRecoveryRequestAction('restart_frontend'), 'restart_frontend');
  assert.equal(toRecoveryRequestAction('restart_relay'), 'restart_relay');
  assert.equal(toRecoveryRequestAction('reload_browser'), null);
});

test('已完成的前端切换不受后来源码改动影响', async () => {
  let clock = 0;
  const result = await pollForRecovery({
    target: 'frontend', clientProtocolVersion: 35, requireExplicitRestartObserved: true,
    timeoutMs: 20, intervalMs: 5, now: () => clock, wait: async (ms) => { clock += ms; },
    probe: async () => ({
      healthy: true,
      serverProtocolVersion: 35,
      restartObserved: hasCompletedFrontendRestart(clock < 10 ? 'running' : 'completed', true, true),
    }),
  });
  assert.equal(result.status, 'ready');
  assert.equal(clock, 10);
});

test('有操作回执时按回执判定，缺少回执时要求实例已切换且构建匹配源码', () => {
  assert.equal(hasCompletedFrontendRestart('completed', false, true), true);
  assert.equal(hasCompletedFrontendRestart('running', true, false), false);
  assert.equal(hasCompletedFrontendRestart('failed', true, false), false);
  assert.equal(hasCompletedFrontendRestart(null, true, true), false);
  assert.equal(hasCompletedFrontendRestart(null, false, false), false);
  assert.equal(hasCompletedFrontendRestart(null, true, false), true);
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

test('重启确认体读取中断后继续观察实例，旧实例健康不能算成功', async () => {
  let confirmationError;
  try {
    await parseApiResponse(new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('terminated')); },
    }), { status: 202 }));
  } catch (error) { confirmationError = error; }
  assert.equal(canIgnoreRecoveryConfirmationError(confirmationError), true);
  assert.equal(canIgnoreRecoveryConfirmationError(new ApiError(200, null, '服务端返回了无效数据')), true);
  assert.equal(canIgnoreRecoveryConfirmationError(new ApiError(401, null)), false);
  assert.equal(canIgnoreRecoveryConfirmationError(new ApiError(500, null)), false);

  for (const switched of [false, true]) {
    let clock = 0;
    let probes = 0;
    const result = await pollForRecovery({
      target: 'backend', clientProtocolVersion: 35,
      requireExplicitRestartObserved: canIgnoreRecoveryConfirmationError(confirmationError),
      timeoutMs: 20, intervalMs: 5, now: () => clock, wait: async (ms) => { clock += ms; },
      probe: async () => {
        if (++probes === 1) throw new Error('backend restarting');
        return { healthy: true, serverProtocolVersion: 35, restartObserved: switched && probes >= 3 };
      },
    });
    assert.equal(result.status, switched ? 'ready' : 'timeout');
    assert.ok(probes >= 3);
  }
});
