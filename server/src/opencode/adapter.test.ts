import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeAdapter, openCodeInteractionAdapter } from './adapter.js';
import { EngineRegistry } from '../engine/registry.js';
import { RELAY_HOST_CONTEXT } from '../engine/host-context.js';

test('宿主说明通过实际 ACP 消息发送，协议应答与最终回复共同确认后不重复', async () => {
  const listeners = new Set<(message: any) => void>();
  const prompts: string[] = [];
  const marks: string[] = [];
  const transport = {
    state: 'open',
    onOpen: () => () => {}, onError: () => () => {}, onClose: () => () => {},
    onMessage(listener: (message: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {}, terminate() {}, async closeAndWait() {}, diagnostic: () => '',
    send(message: any) {
      if (!message.method) return;
      queueMicrotask(() => {
        let result: unknown = {};
        if (message.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
        if (message.method === 'session/new') result = { sessionId: 'oc-host-session' };
        if (message.method === 'session/prompt') {
          prompts.push(message.params.prompt[0].text);
          for (const listener of listeners) listener({ method: 'session/update', params: {
            sessionId: 'oc-host-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回复' } },
          } });
          assert.deepEqual(marks, prompts.length === 1 ? [] : ['oc-host-session']);
          result = { stopReason: 'end_turn' };
        }
        for (const listener of listeners) listener({ id: message.id, result });
      });
    },
  };
  const adapter = new OpenCodeAdapter({
    getAvailability: () => ({ available: true, code: 'AVAILABLE' }),
    manager: { getOrCreate: () => transport, setBusy() {}, touch() {}, async release() {} } as never,
  });
  const connection = new EngineRegistry([adapter]).connect('opencode', {
    sessionId: 'relay', externalSessionId: null, cwd: 'D:/ws',
    hostContext: { delivered: false, onDelivered: (id) => { marks.push(id); } },
    onSessionReady() {}, onEvent() {}, onClosed() {},
  });
  try {
    connection.send('用户原文');
    for (let index = 0; index < 30 && marks.length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marks, ['oc-host-session']);
    assert.equal(prompts[0], `${RELAY_HOST_CONTEXT}\n\n用户原文`);
    connection.send('第二轮');
    for (let index = 0; index < 30 && prompts.length < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(prompts[1], '第二轮');
  } finally { connection.close(); }
});

test('OpenCode interactions 分面按 kind 与 rawInput 标准化权限请求', () => {
  const interactions = new OpenCodeAdapter().interactions;
  const normalized = interactions.normalize({
    requestId: 1,
    method: 'session/request_permission',
    params: {
      toolCall: {
        toolCallId: 'tool-1',
        title: 'bash',
        kind: 'execute',
        rawInput: { command: 'npm test', description: '运行测试' },
      },
      options: [
        { kind: 'allow_once', optionId: 'once-id', name: 'Allow' },
        { kind: 'allow_always', optionId: 'always-id', name: 'Always Allow' },
        { kind: 'reject_once', optionId: 'reject-id', name: 'Reject' },
      ],
    },
  });

  assert.equal(normalized.kind, 'command');
  assert.equal(normalized.autoApprovable, true);
  assert.deepEqual(normalized.availableActions, ['accept_once', 'accept_for_session', 'decline', 'cancel']);
  assert.deepEqual(normalized.snapshot.rawInput, { command: 'npm test', description: '运行测试' });
  assert.doesNotMatch(JSON.stringify(normalized.snapshot), /password|accessToken|secret|tool-1|once-id|always-id|reject-id/);
});

test('OpenCode interactions 分面分类文件、一般权限、用户输入和 unknown', () => {
  const normalizePermission = (toolCall: Record<string, unknown>) => openCodeInteractionAdapter.normalize({
    requestId: 1,
    method: 'session/request_permission',
    params: { toolCall, options: [] },
  });

  assert.equal(normalizePermission({ kind: 'edit', rawInput: { filePath: 'a.ts' } }).kind, 'file');
  assert.equal(normalizePermission({ kind: 'edit', rawInput: { path: 'a.ts' } }).kind, 'file');
  assert.equal(normalizePermission({ kind: 'execute', rawInput: { command: 'ls' } }).kind, 'command');
  assert.equal(normalizePermission({ kind: 'other', rawInput: {} }).kind, 'permissions');
  assert.equal(normalizePermission({ kind: 'other', title: 'webfetch' }).kind, 'permissions');

  const userInput = openCodeInteractionAdapter.normalize({ requestId: 2, method: 'session/request_user_input', params: { message: '请选择' } });
  const unknown = openCodeInteractionAdapter.normalize({ requestId: 3, method: 'future/request', params: {} });
  assert.equal(userInput.kind, 'user_input');
  assert.deepEqual(userInput.availableActions, ['submit', 'cancel']);
  assert.equal(unknown.kind, 'unknown');
  assert.deepEqual(unknown.availableActions, []);
});

test('OpenCode interactions 分面按 ACP optionId 构造响应且拒绝不支持动作', () => {
  const permission = {
    requestId: 1,
    method: 'session/request_permission' as const,
    params: {
      toolCall: { kind: 'execute', rawInput: { command: 'npm test' } },
      options: [
        { kind: 'allow_once', optionId: 'once-id', name: 'Allow' },
        { kind: 'allow_always', optionId: 'always-id', name: 'Always Allow' },
        { kind: 'reject_once', optionId: 'reject-id', name: 'Reject' },
      ],
    },
  };

  assert.deepEqual(openCodeInteractionAdapter.buildResponse(permission as never, { action: 'accept_once' } as never), { outcome: { outcome: 'selected', optionId: 'once-id' } });
  assert.deepEqual(openCodeInteractionAdapter.buildResponse(permission as never, { action: 'accept_for_session' } as never), { outcome: { outcome: 'selected', optionId: 'always-id' } });
  assert.deepEqual(openCodeInteractionAdapter.buildResponse(permission as never, { action: 'decline' } as never), { outcome: { outcome: 'selected', optionId: 'reject-id' } });
  assert.deepEqual(openCodeInteractionAdapter.buildResponse(permission as never, { action: 'cancel' } as never), { outcome: { outcome: 'cancelled' } });
  assert.throws(() => openCodeInteractionAdapter.buildResponse({ ...permission, params: { toolCall: {}, options: [] } } as never, { action: 'accept_once' } as never), /不可用/);

  const userInput = { requestId: 2, method: 'session/request_user_input' as const, params: { message: '请选择' } };
  assert.deepEqual(openCodeInteractionAdapter.buildResponse(userInput as never, { action: 'submit', answers: { q1: ['yes'] } } as never), { answers: { q1: ['yes'] } });
  assert.deepEqual(openCodeInteractionAdapter.buildResponse(userInput as never, { action: 'cancel' } as never), { outcome: { outcome: 'cancelled' } });
  assert.throws(() => openCodeInteractionAdapter.buildResponse({ requestId: 3, method: 'future/request', params: {} } as never, { action: 'cancel' } as never), /暂不支持/);
});
