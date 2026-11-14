import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractionResponseManager } from './interaction-response.ts';

const base = {
  type: 'interaction_response_result',
  operationId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  interactionId: 'interaction:1',
};

test('accepted 和 skipped 完成对应 operation，重复结果只处理一次', async () => {
  const manager = createInteractionResponseManager({ timeoutMs: 1000 });
  const acceptedPromise = manager.wait(base.operationId);
  assert.equal(manager.handle({ ...base, outcome: 'accepted' }), true);
  assert.equal(manager.handle({ ...base, outcome: 'accepted' }), false);
  assert.equal((await acceptedPromise).outcome, 'accepted');

  const skippedId = '33333333-3333-4333-8333-333333333333';
  const skippedPromise = manager.wait(skippedId);
  manager.handle({ ...base, operationId: skippedId, outcome: 'skipped', message: '已处理' });
  assert.equal((await skippedPromise).message, '已处理');
});

test('failed、连接关闭和超时拒绝并清理 Promise', async () => {
  const manager = createInteractionResponseManager({ timeoutMs: 20 });
  const failedId = '44444444-4444-4444-8444-444444444444';
  const failedPromise = manager.wait(failedId);
  manager.handle({ ...base, operationId: failedId, outcome: 'failed', message: '决定不可用' });
  await assert.rejects(failedPromise, /决定不可用/);

  const closedId = '55555555-5555-4555-8555-555555555555';
  const closedPromise = manager.wait(closedId);
  manager.rejectAll('连接已断开');
  await assert.rejects(closedPromise, /连接已断开/);

  const timeoutId = '66666666-6666-4666-8666-666666666666';
  await assert.rejects(manager.wait(timeoutId), /响应确认超时/);
  assert.equal(manager.pendingCount(), 0);
});
