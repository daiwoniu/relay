import assert from 'node:assert/strict';
import test from 'node:test';
import { codeBuddyInteractionAdapter } from '../codebuddy/adapter.js';
import { codexInteractionAdapter } from '../codex/adapter.js';
import {
  buildInteractionResponse,
  createInteractionItem,
  createScopedInteractionId,
  getPendingApprovalResolution,
  normalizeInteractionOrFallback,
} from './frontend-interactions.js';

test('普通提问回答及取消均生成全局提醒解决事实，不映射授权允许', () => {
  for (const method of ['item/tool/requestUserInput', 'session/request_user_input']) {
    assert.equal(getPendingApprovalResolution(method,'submit'),'submitted');
    assert.equal(getPendingApprovalResolution(method,'cancel'),'cancel');
    assert.equal(getPendingApprovalResolution(method,'accept'),null);
  }
});

test('兼容投影保持现有 interactionKind、详情和稳定 ID', () => {
  const request = { requestId: 'request-1', method: 'item/commandExecution/requestApproval', params: {
    command: 'npm test',
    cwd: 'G:/AI/relay',
    availableDecisions: ['accept', 'decline'],
    token: 'secret',
  } };
  const item = createInteractionItem(codexInteractionAdapter.normalize(request), request.method);
  const details = item.details as Record<string, unknown>;
  assert.equal(item.id, 'interaction:request-1');
  assert.equal(details.interactionKind, 'command_approval');
  assert.equal(details.command, 'npm test');
  assert.equal(details.cwd, 'G:/AI/relay');
  assert.equal(JSON.stringify(item).includes('secret'), false);
});

test('兼容响应把前端 accept 映射为标准 accept_once 后交给对应 Adapter', () => {
  assert.deepEqual(buildInteractionResponse(
    codexInteractionAdapter,
    { requestId: 1, method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['accept', 'decline'] } },
    { type: 'respond_interaction', operationId: '00000000-0000-4000-8000-000000000000', sessionId: '00000000-0000-4000-8000-000000000001', interactionId: 'interaction:1', action: 'accept' },
  ), { decision: 'accept' });
  assert.deepEqual(buildInteractionResponse(
    codeBuddyInteractionAdapter,
    { requestId: 2, method: 'session/request_permission', params: { options: [{ optionId: 'once-id', kind: 'allow_once' }] } },
    { type: 'respond_interaction', operationId: '00000000-0000-4000-8000-000000000000', sessionId: '00000000-0000-4000-8000-000000000001', interactionId: 'interaction:2', action: 'accept' },
  ), { outcome: { outcome: 'selected', optionId: 'once-id' } });
});

test('缺失或异常交互分面安全降级为不可自动处理的 unknown', () => {
  const request = { requestId: 3, method: 'future/request', params: { token: 'secret' } };
  for (const adapter of [undefined, {
    normalize: () => { throw new Error('broken normalize'); },
    buildResponse: () => null,
  }]) {
    const interaction = normalizeInteractionOrFallback(adapter, request);
    assert.equal(interaction.kind, 'unknown');
    assert.equal(interaction.autoApprovable, false);
    assert.deepEqual(interaction.availableActions, []);
    assert.equal(JSON.stringify(interaction.snapshot).includes('secret'), false);
  }
  const malformed = normalizeInteractionOrFallback(undefined, {
    requestId: '',
    method: 'future/request',
    params: {},
  });
  assert.match(malformed.id, /^interaction:invalid-[0-9a-f]+$/);
});

test('交互 id 按引擎连接加作用域，避免 requestId 跨轮次复用撞主键', () => {
  // 引擎 requestId 会在新连接/新轮次从 0 重新计数，只用它拼 id 会让不同轮次的票据撞同一主键。
  assert.equal(createScopedInteractionId('conn-a', 0), 'interaction:conn-a:0');
  assert.equal(createScopedInteractionId('conn-b', 0), 'interaction:conn-b:0');
  assert.notEqual(createScopedInteractionId('conn-a', 0), createScopedInteractionId('conn-b', 0));

  // 同一连接内必须幂等稳定，实时事件按稳定 id 合并。
  assert.equal(createScopedInteractionId('conn-a', 0), createScopedInteractionId('conn-a', 0));
  assert.equal(createScopedInteractionId('conn-a', 'req-1'), 'interaction:conn-a:req-1');

  // 没有连接标识时退化为标准 id，保持既有调用稳定。
  assert.equal(createScopedInteractionId(undefined, 7), 'interaction:7');
  assert.equal(createScopedInteractionId(null, 7), 'interaction:7');

  assert.throws(() => createScopedInteractionId('conn-a', Number.NaN), /请求 ID/);
});

test('作用域 id 作为 item 主键时保留原始 requestId', () => {
  const request = { requestId: 42, method: 'item/commandExecution/requestApproval', params: {
    command: 'npm test', cwd: 'G:/AI/relay', availableDecisions: ['accept', 'decline'],
  } };
  const item = createInteractionItem(codexInteractionAdapter.normalize(request), request.method, 'conn-a');
  assert.equal(item.id, 'interaction:conn-a:42');
  assert.equal((item.details as Record<string, unknown>).requestId, 42);
});
