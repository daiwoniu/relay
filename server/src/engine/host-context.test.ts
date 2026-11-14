import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineAdapter, EngineConnectionOptions } from './adapter.js';
import { EngineRegistry } from './registry.js';
import { connectWithHostContext, RELAY_HOST_CONTEXT } from './host-context.js';
import { createEngineEventEmitter } from './events.js';

function harness(engine: EngineAdapter['id'] = 'codex', delivered = false, externalSessionId: string | null = null) {
  const sent: Array<{ content: string; options: unknown }> = [];
  const marks: string[] = [];
  const forwarded: unknown[] = [];
  let connected!: EngineConnectionOptions;
  const original = {
    send: (content: string, options?: unknown) => { sent.push({ content, options }); },
    steer: async (input: unknown) => { forwarded.push(input); return 'accepted' as const; },
    cancel: async () => { forwarded.push('cancel'); },
    close: () => { forwarded.push('close'); },
    respondToInteraction: (id: unknown, result: unknown) => { forwarded.push({ id, result }); },
  };
  const options: EngineConnectionOptions = {
    sessionId: 'relay', externalSessionId, cwd: 'D:/project',
    hostContext: { delivered, onDelivered: (id) => { marks.push(id); } },
    onSessionReady: (id) => { forwarded.push(id); },
    onEvent: (event) => { forwarded.push(event); },
    onClosed: () => undefined,
  };
  const connect = (input: EngineConnectionOptions) => { connected = input; return original; };
  const adapter = { id: engine, availability: { getCurrent: () => ({ available: true }) }, runtime: { connect } } as EngineAdapter;
  const connection = new EngineRegistry([adapter]).connect(engine, options);
  const emit = createEngineEventEmitter({ engineId: engine, emit: (event) => connected.onEvent(event) });
  return { sent, marks, forwarded, options, original, connected, connection, connect, emit };
}

test('异步送达和失效标记失败被观察，事件仍按原顺序转发', async () => {
  const h = harness('codex', false, 'thread');
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    h.options.hostContext!.onDelivered = async () => { throw new Error('private db error'); };
    h.options.hostContext!.onInvalidated = async () => { throw new Error('private db error'); };
    h.connection.send('question'); h.connected.onInputAccepted!('turn', h.sent[0].content);
    h.emit({ type: 'message_complete', turnId: 'turn', content: 'answer' }, { source: 'realtime' });
    h.emit({ type: 'system_notice', noticeType: 'context_compaction', title: 'compacted' }, { source: 'realtime' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 2);
    assert.equal(JSON.stringify(warnings).includes('private db error'), false);
    assert.equal(h.forwarded.length, 2);
  } finally { console.warn = warn; }
});

for (const engine of ['codex', 'codebuddy', 'opencode', 'zcode'] as const) {
  test(`${engine} 新建与旧会话首次发送补充宿主信息，真实回复后不再重复`, () => {
    for (const externalId of [null, 'existing-thread']) {
      const h = harness(engine, false, externalId);
      h.connected.onSessionReady(externalId ?? 'new-thread');
      const userText = '  按项目规则开发\n<user_data>原文</user_data>  ';
      const turnOptions = { preferences: { modelId: 'chosen-model', reasoningEffort: 'high' } };
      h.connection.send(userText, turnOptions);
      assert.equal(h.sent[0].content, `${RELAY_HOST_CONTEXT}\n\n${userText}`);
      assert.equal(h.sent[0].options, turnOptions);
      assert.deepEqual(h.marks, []);
      h.connected.onInputAccepted!('new-turn', h.sent[0].content);
      h.emit({ type: 'message_complete', turnId: 'new-turn', content: '收到' }, { source: 'realtime' });
      assert.deepEqual(h.marks, [externalId ?? 'new-thread']);
      h.connection.send('下一轮');
      assert.equal(h.sent[1].content, '下一轮');
      assert.equal(h.connected.cwd, h.options.cwd);
      assert.equal(h.connected.initialTurnOptions, h.options.initialTurnOptions);
    }
  });
}

test('持久化标记已确认的恢复会话不再附加平台说明', () => {
  const h = harness('codex', true, 'thread');
  h.connection.send('原文');
  assert.equal(h.sent[0].content, '原文');
  assert.deepEqual(h.marks, []);
});

test('恢复重放、本地受理、其他会话事件及发送前回复不产生送达标记', () => {
  const h = harness('codebuddy', false, 'thread');
  h.emit({ type: 'delta', itemId: 'old', content: '旧回复' }, { source: 'realtime' });
  h.connection.send('问题');
  for (const source of ['local', 'history', 'recovery'] as const) {
    h.emit({ type: 'message_complete', turnId: 'old', content: '旧回复' }, { source });
  }
  h.emit({ type: 'delta', itemId: 'other', content: '其他回复' }, { source: 'realtime', externalSessionId: 'other-thread' });
  h.emit({ type: 'turn_start', turnId: 'turn' }, { source: 'realtime' });
  assert.deepEqual(h.marks, []);
  h.connection.send('重试');
  assert.equal(h.sent[1].content, `${RELAY_HOST_CONTEXT}\n\n重试`);
  h.connected.onInputAccepted!('new', h.sent[1].content);
  h.emit({ type: 'message_complete', turnId: 'new', content: '最终回复' }, { source: 'request_response' });
  assert.deepEqual(h.marks, ['thread']);
});

test('送达标记保存失败不阻断原始事件处理或重复注入当前连接', () => {
  const h = harness('opencode', false, 'thread');
  h.options.hostContext!.onDelivered = () => { throw new Error('storage unavailable'); };
  h.connection.send('问题');
  h.connected.onInputAccepted!('turn', h.sent[0].content);
  h.emit({ type: 'message_complete', turnId: 'turn', content: '回复' }, { source: 'realtime' });
  assert.ok(h.forwarded.some((entry: any) => entry?.payload?.content === '回复'));
  h.connection.send('下一轮');
  assert.equal(h.sent[1].content, '下一轮');
});

test('授权、取消、关闭和回合引导原样委托，不扩大权限', async () => {
  const h = harness();
  const input = { content: '调整目标', messageId: 'message', expectedTurnId: 'turn' };
  assert.equal(await h.connection.steer!(input), 'accepted');
  await h.connection.cancel();
  h.connection.respondToInteraction('approval', { decision: 'decline' });
  h.connection.close();
  assert.deepEqual(h.forwarded, [input, 'cancel', { id: 'approval', result: { decision: 'decline' } }, 'close']);
});

test('未配置宿主状态的调用不改变原连接或协议能力', () => {
  const h = harness();
  const { hostContext: _, ...options } = h.options;
  assert.equal(connectWithHostContext(h.connect, options), h.original);
});

test('同会话旧回合迟到的流式与终态回复不能冒充本次发送成功', () => {
  const h = harness('codex', false, 'thread');
  h.connection.send('问题');
  h.emit({ type: 'delta', itemId: 'old', content: '迟到文字' }, { source: 'realtime' });
  h.emit({ type: 'message_complete', turnId: 'old-turn', content: '迟到终态' }, { source: 'realtime' });
  assert.deepEqual(h.marks, []);
  h.connected.onInputAccepted!('old-turn', '其他请求内容');
  assert.deepEqual(h.marks, []);
  h.connected.onInputAccepted!('new-turn', h.sent[0].content);
  assert.deepEqual(h.marks, []);
  h.emit({ type: 'message_complete', turnId: 'new-turn', content: '本轮回复' }, { source: 'realtime' });
  assert.deepEqual(h.marks, ['thread']);
});

test('同请求最终回复先于协议应答时仍可准确确认一次', () => {
  const h = harness('zcode', false, 'thread');
  h.connection.send('问题');
  h.emit({ type: 'message_complete', turnId: 'turn', content: '回复' }, { source: 'request_response' });
  assert.deepEqual(h.marks, []);
  h.connected.onInputAccepted!('turn', h.sent[0].content);
  h.connected.onInputAccepted!('turn', h.sent[0].content);
  assert.deepEqual(h.marks, ['thread']);
});

test('真实压缩使平台说明失效，下一轮补发；历史压缩事件不触发失效', () => {
  const h = harness('codex', true, 'thread');
  const invalidations: string[] = [];
  h.options.hostContext!.onInvalidated = (id) => { invalidations.push(id); };
  const notice = { type: 'system_notice', noticeType: 'context_compaction', title: '整理完成' } as const;
  h.emit(notice, { source: 'history' });
  h.connection.send('压缩前');
  assert.equal(h.sent[0].content, '压缩前');
  h.emit(notice, { source: 'realtime' });
  h.connection.send('压缩后');
  assert.equal(h.sent[1].content, `${RELAY_HOST_CONTEXT}\n\n压缩后`);
  // 压缩发生在本轮执行中时，该轮旧说明的应答不能再次标为有效。
  h.emit(notice, { source: 'realtime' });
  h.connected.onInputAccepted!('turn', h.sent[1].content);
  h.emit({ type: 'message_complete', turnId: 'turn', content: '回复' }, { source: 'realtime' });
  assert.deepEqual(h.marks, []);
  assert.deepEqual(invalidations, ['thread', 'thread']);
});
