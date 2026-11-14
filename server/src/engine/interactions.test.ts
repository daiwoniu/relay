import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineInteractionAdapter } from './facets.js';
import {
  createInteractionId,
  createInteractionSnapshot,
  defineNormalizedInteraction,
  type EngineInteractionRequest,
  type InteractionResponseCommand,
} from './interactions.js';

test('标准 interaction ID 对字符串和数字请求保持稳定', () => {
  assert.equal(createInteractionId('request-1'), 'interaction:request-1');
  assert.equal(createInteractionId(42), 'interaction:42');
  assert.throws(() => createInteractionId(''), /请求 ID/);
  assert.throws(() => createInteractionId(Number.NaN), /请求 ID/);
});

test('只有普通授权且支持 accept_once 时可进入信任候选', () => {
  for (const kind of ['command', 'file', 'permissions'] as const) {
    const interaction = defineNormalizedInteraction({
      requestId: kind,
      kind,
      snapshot: { title: kind },
      availableActions: ['accept_once', 'decline'],
    });
    assert.equal(interaction.autoApprovable, true);
  }

  for (const kind of ['user_input', 'mcp_elicitation', 'unknown'] as const) {
    const interaction = defineNormalizedInteraction({
      requestId: kind,
      kind,
      snapshot: { title: kind },
      availableActions: ['accept_once'],
    });
    assert.equal(interaction.autoApprovable, false);
  }

  assert.equal(defineNormalizedInteraction({
    requestId: 'no-accept-once',
    kind: 'command',
    snapshot: { title: '命令' },
    availableActions: ['decline'],
  }).autoApprovable, false);
});

test('标准交互拒绝未知种类、动作和重复动作', () => {
  const base = {
    requestId: 'request-1',
    snapshot: { title: '请求' },
  };
  assert.throws(
    () => defineNormalizedInteraction({ ...base, kind: 'network' as never, availableActions: [] }),
    /交互类型/,
  );
  assert.throws(
    () => defineNormalizedInteraction({ ...base, kind: 'unknown', availableActions: ['approve' as never] }),
    /交互动作/,
  );
  assert.throws(
    () => defineNormalizedInteraction({ ...base, kind: 'unknown', availableActions: ['cancel', 'cancel'] }),
    /重复/,
  );
});

test('脱敏快照只投影展示白名单并递归移除凭据', () => {
  const snapshot = createInteractionSnapshot({
    title: '需要授权执行命令',
    command: 'npm test',
    reason: '运行测试',
    permissions: {
      network: true,
      authorization: 'Bearer secret',
      sessionToken: 'session-secret',
      nested: {
        apiKey: 'sk-secret',
        safe: '保留',
      },
    },
    rawInput: {
      path: 'G:/AI/relay',
      password: 'do-not-copy',
    },
    cookie: 'relay_session=secret',
    providerConfig: { endpoint: 'https://private.example' },
    arbitraryProtocolObject: { shouldNotLeak: true },
  });

  assert.deepEqual(snapshot, {
    title: '需要授权执行命令',
    reason: '运行测试',
    command: 'npm test',
    permissions: {
      network: true,
      nested: { safe: '保留' },
    },
    rawInput: { path: 'G:/AI/relay' },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|cookie|authorization|providerConfig/i);
});

test('脱敏快照限制深度、数组长度和展示字符串长度', () => {
  const snapshot = createInteractionSnapshot({
    title: 'x'.repeat(20_000),
    fileChanges: Array.from({ length: 150 }, (_, index) => ({ path: `file-${index}` })),
    permissions: { a: { b: { c: { d: { e: 'too deep' } } } } },
  });

  assert.equal(String(snapshot.title).length, 16_384);
  assert.equal((snapshot.fileChanges as unknown[]).length, 100);
  assert.deepEqual(snapshot.permissions, { a: { b: { c: null } } });
});

test('脱敏快照清理展示字符串中内嵌的凭据', () => {
  const snapshot = createInteractionSnapshot({
    title: '需要授权',
    command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://example.test?api_key=topsecret',
    reason: 'cookie=relay_session_value password=hunter2',
    message: '-----BEGIN PRIVATE KEY-----\nvery-secret-key\n-----END PRIVATE KEY-----',
  });

  assert.match(String(snapshot.command), /Authorization=\[REDACTED\]/);
  assert.match(String(snapshot.command), /api_key=\[REDACTED\]/);
  assert.match(String(snapshot.reason), /cookie=\[REDACTED\]/);
  assert.match(String(snapshot.reason), /password=\[REDACTED\]/);
  assert.equal(snapshot.message, '[REDACTED PRIVATE KEY]');
  assert.doesNotMatch(JSON.stringify(snapshot), /abcdefghijklmnop|topsecret|relay_session_value|hunter2|very-secret-key/);
});

test('interactions 分面契约把原始请求限制在 Adapter 翻译边界', () => {
  const request: EngineInteractionRequest = {
    requestId: 'request-1',
    method: 'example/request',
    params: { privateProtocolField: true },
  };
  const response: InteractionResponseCommand = { action: 'accept_once' };
  const adapter: EngineInteractionAdapter = {
    normalize: (input) => defineNormalizedInteraction({
      requestId: input.requestId,
      kind: 'unknown',
      snapshot: { title: '未知请求' },
      availableActions: [],
    }),
    buildResponse: (input, command) => ({ method: input.method, action: command.action }),
  };

  assert.equal(adapter.normalize(request).kind, 'unknown');
  assert.deepEqual(adapter.buildResponse(request, response), {
    method: 'example/request',
    action: 'accept_once',
  });
});
