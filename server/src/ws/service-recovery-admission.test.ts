import assert from 'node:assert/strict';
import test from 'node:test';
import { getEngineMaintenanceSendError, getServiceRecoverySendError } from './frontend.js';

test('服务恢复占用期间拒绝新任务且使用稳定错误码', () => {
  assert.deepEqual(getServiceRecoverySendError(true), {
    code: 'SERVICE_RECOVERY_IN_PROGRESS',
    message: 'Relay 服务正在恢复，请稍后再发送消息',
  });
  assert.equal(getServiceRecoverySendError(false), null);
});

test('引擎维护只阻断目标引擎的新任务', () => {
  assert.deepEqual(getEngineMaintenanceSendError('maintenance', 'codebuddy'), {
    code: 'ENGINE_MAINTENANCE_IN_PROGRESS',
    message: 'CodeBuddy 正在维护，请稍后再发送消息',
  });
  assert.deepEqual(getEngineMaintenanceSendError('unavailable', 'codebuddy'), {
    code: 'ENGINE_UNAVAILABLE_AFTER_MAINTENANCE',
    message: 'CodeBuddy 维护恢复失败，请在终端修复后运行 npm run restart',
  });
  assert.equal(getEngineMaintenanceSendError(null, 'codebuddy'), null);
});
