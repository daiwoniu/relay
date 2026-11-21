import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import type { CodexHandshakeStageEvent } from './client.js';
import {
  appendAgentMessageItemText,
  buildAgentMessageGapDiagnostic,
  buildCompletedMessageContent,
  buildThreadOpenRequest,
  createCodexConnection,
  extractThreadTokenUsage,
  extractTurnFailure,
  getAgentMessagePhase,
  isArchivedThreadError,
  RELAY_FILE_CHANGE_REPORT_TOOL,
} from './client.js';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待测试条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('宿主送达确认仅来自对应 turn/start 应答，通知不能冒充应答', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const accepted: Array<{ turnId: string; content: string }> = [];
  const methods: string[] = [], errors: string[] = [];
  let request: any;
  let peer: any;
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    methods.push(message.method);
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === 'config/read') {
      socket.send(JSON.stringify({ id: message.id, result: { config: { model: 'test' } } }));
    } else if (message.method === 'thread/start') {
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'host-thread' } } }));
    } else if (message.method === 'turn/start') {
      request = message;
      peer = socket;
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'host-thread', turn: { id: 'old-turn' } } }));
    }
  }));
  const connection = createCodexConnection((event) => { if (event.type === 'error') errors.push(event.message); }, {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    onInputAccepted: (turnId, content) => { accepted.push({ turnId, content }); },
  });
  t.after(() => connection.close());
  connection.send('宿主平台输入');
  await waitFor(() => Boolean(request)).catch(() => { throw new Error(JSON.stringify({ methods, errors })); });
  assert.deepEqual(accepted, []);
  peer.send(JSON.stringify({ id: request.id, result: { turn: { id: 'actual-turn' } } }));
  await waitFor(() => accepted.length === 1);
  assert.deepEqual(accepted, [{ turnId: 'actual-turn', content: '宿主平台输入' }]);
});

test('没有历史 threadId 时创建新 thread 并传入 cwd', () => {
  const request = buildThreadOpenRequest(undefined, 'G:\\AI\\relay');
  assert.equal(request.method, 'thread/start');
  assert.deepEqual(request.params.config, { 'tools.update_plan.enabled': true });
  assert.equal(request.params.cwd, 'G:\\AI\\relay');
  assert.equal(request.params.dynamicTools?.length, 1);
  assert.equal(request.params.dynamicTools?.[0]?.type, 'function');
  assert.equal(request.params.dynamicTools?.[0]?.name, RELAY_FILE_CHANGE_REPORT_TOOL);
  assert.match(request.params.dynamicTools?.[0]?.description || '', /新增、修改、删除或移动文件/);
  assert.equal(request.params.dynamicTools?.[0]?.inputSchema?.type, 'object');
});

test('新 thread 显式选择模型时传 model，自动模式不传', () => {
  assert.equal(buildThreadOpenRequest(undefined, 'G:\\AI\\relay', 'gpt-5.6-terra').params.model, 'gpt-5.6-terra');
  assert.equal('model' in buildThreadOpenRequest(undefined, 'G:\\AI\\relay').params, false);
  assert.equal('model' in buildThreadOpenRequest('thr_existing', 'G:\\AI\\relay', 'gpt-5.6-terra').params, false);
});

test('每轮 turn/start 使用当轮模型和推理强度并允许切换', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const turnParams: any[] = [];
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === 'config/read') {
      socket.send(JSON.stringify({ id: message.id, result: { config: { model: 'gpt-auto', model_provider: 'xs_custom' } } }));
    } else if (message.method === 'thread/start') {
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-model-options' } } }));
    } else if (message.method === 'turn/start') {
      turnParams.push(message.params);
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: `turn-${turnParams.length}` } } }));
      if (turnParams.length === 2) socket.send(JSON.stringify({
        method: 'model/rerouted',
        params: { fromModel: 'gpt-second', toModel: 'gpt-effective', reason: 'capacity' },
      }));
    }
  }));

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    initialTurnOptions: { preferences: { modelId: 'gpt-first', reasoningEffort: 'low' } },
  });
  t.after(() => connection.close());
  await waitFor(() => events.some((event) => event.type === 'model_info'));
  connection.send('第一轮', { preferences: { modelId: 'gpt-first', reasoningEffort: 'low' } });
  await waitFor(() => turnParams.length === 1);
  connection.send('第二轮', { preferences: { modelId: 'gpt-second', reasoningEffort: 'high' } });
  await waitFor(() => turnParams.length === 2);
  connection.send('第三轮', { preferences: { modelId: null, reasoningEffort: null } });
  await waitFor(() => turnParams.length === 3);
  assert.equal(turnParams[0].model, 'gpt-first');
  assert.equal(turnParams[0].effort, 'low');
  assert.equal(turnParams[1].model, 'gpt-second');
  assert.equal(turnParams[1].effort, 'high');
  assert.equal('model' in turnParams[2], false);
  assert.equal('effort' in turnParams[2], false);
  assert.equal(events.some((event) => event.type === 'model_info' && event.model === 'gpt-first' && event.modelProvider === 'xs_custom' && event.reasoningEffort === 'low'), true);
  assert.equal(events.some((event) => event.type === 'model_info' && event.model === 'gpt-second' && event.modelProvider === 'xs_custom' && event.reasoningEffort === 'high'), true);
  await waitFor(() => events.some((event) => event.type === 'model_info' && event.model === 'gpt-effective'));
  assert.equal(events.find((event) => event.type === 'model_info' && event.model === 'gpt-effective')?.reasoningEffort, 'high');
  assert.equal(events.find((event) => event.type === 'model_info' && event.model === 'gpt-effective')?.modelProvider, 'xs_custom');
  assert.equal(events.filter((event) => event.type === 'model_info' && event.model === 'gpt-auto').length, 2);
});

test('Codex 逐轮速度覆盖仅作用于当前会话的请求', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const turnParams: any[] = [];
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: { config: {} } }));
    if (message.method === 'thread/start') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'speed-thread' } } }));
    if (message.method === 'turn/start') {
      turnParams.push(message.params);
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: `speed-${turnParams.length}` } } }));
    }
  }));
  const connection = createCodexConnection(() => undefined, { wsUrl: `ws://127.0.0.1:${address.port}` });
  t.after(() => connection.close());
  connection.send('fast', { preferences: { modelId: 'gpt-fast', reasoningEffort: null, serviceTier: 'priority' } });
  await waitFor(() => turnParams.length === 1);
  connection.send('standard', { preferences: { modelId: 'gpt-fast', reasoningEffort: null, serviceTier: 'default' } });
  await waitFor(() => turnParams.length === 2);
  assert.equal(turnParams[0].serviceTierForTurn, 'priority');
  assert.equal(turnParams[1].serviceTierForTurn, 'default');
  assert.equal('serviceTier' in turnParams[0], false);
});

test('自动选模复用连接时每轮都在 turn/start 前上报握手确认模型', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const observed: string[] = [];
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === 'config/read') socket.send(JSON.stringify({
      id: message.id, result: { config: { model: 'gpt-auto', model_provider: 'OpenAI', model_reasoning_effort: 'medium' } },
    }));
    else if (message.method === 'thread/start') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-auto' } } }));
    else if (message.method === 'turn/start') {
      observed.push('turn_start');
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: `turn-${observed.length}` } } }));
    }
  }));

  const events: any[] = [];
  const connection = createCodexConnection((event) => {
    if (event.type === 'model_info') observed.push(`model:${event.model}`);
    events.push(event);
  }, { wsUrl: `ws://127.0.0.1:${address.port}` });
  t.after(() => connection.close());
  await waitFor(() => events.some((event) => event.type === 'model_info'));
  connection.send('第一轮', { preferences: { modelId: null, reasoningEffort: null } });
  await waitFor(() => observed.filter((entry) => entry === 'turn_start').length === 1);
  connection.send('第二轮', { preferences: { modelId: null, reasoningEffort: null } });
  await waitFor(() => observed.filter((entry) => entry === 'turn_start').length === 2);
  assert.deepEqual(observed, [
    'model:gpt-auto',
    'model:gpt-auto', 'turn_start',
    'model:gpt-auto', 'turn_start',
  ]);
});

test('存在历史 threadId 时恢复 thread 并保持 cwd', () => {
  assert.deepEqual(buildThreadOpenRequest('thr_existing', 'G:\\AI\\relay'), {
    method: 'thread/resume',
    params: { threadId: 'thr_existing', excludeTurns: true, cwd: 'G:\\AI\\relay', config: { 'tools.update_plan.enabled': true } },
  });
});

test('没有 cwd 时不发送空 cwd 覆盖', () => {
  assert.deepEqual(buildThreadOpenRequest('thr_existing'), {
    method: 'thread/resume',
    params: { threadId: 'thr_existing', excludeTurns: true, config: { 'tools.update_plan.enabled': true } },
  });
});

test('只识别 Codex 明确返回的 thread 已归档错误', () => {
  assert.equal(isArchivedThreadError(new Error(
    'session thr_existing is archived. Run `codex unarchive thr_existing` to unarchive it first.',
  )), true);
  assert.equal(isArchivedThreadError(new Error('thread not found')), false);
});

test('握手优先使用 config/read 并从新版 config 结构提取模型', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  const methods: string[] = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      methods.push(message.method);
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'config/read') {
        assert.deepEqual(message.params, { includeLayers: false });
        socket.send(JSON.stringify({
          id: message.id,
          result: { config: { model: 'gpt-test-current' } },
        }));
      } else if (message.method === 'thread/start') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-current' } } }));
      }
    });
  });

  const events: any[] = [];
  const stages: CodexHandshakeStageEvent[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    onHandshakeStage: (event) => stages.push(event),
  });
  t.after(() => connection.close());

  await waitFor(() => events.some((event) => event.type === 'model_info'));
  assert.equal(events.find((event) => event.type === 'model_info')?.model, 'gpt-test-current');
  assert(methods.includes('config/read'));
  assert(!methods.includes('config/get'));
  assert(stages.some((event) => event.stage === 'config/read' && event.outcome === 'completed'));
});

test('旧版服务明确不支持 config/read 时回退 config/get', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  const methods: string[] = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      methods.push(message.method);
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'config/read') {
        socket.send(JSON.stringify({
          id: message.id,
          error: {
            code: -32600,
            message: 'Invalid request: unknown variant `config/read`, expected `config/get`',
          },
        }));
      } else if (message.method === 'config/get') {
        socket.send(JSON.stringify({ id: message.id, result: { model: 'gpt-test-legacy' } }));
      } else if (message.method === 'thread/start') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-legacy' } } }));
      }
    });
  });

  const events: any[] = [];
  const stages: CodexHandshakeStageEvent[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    onHandshakeStage: (event) => stages.push(event),
  });
  t.after(() => connection.close());

  await waitFor(() => events.some((event) => event.type === 'model_info'));
  assert.equal(events.find((event) => event.type === 'model_info')?.model, 'gpt-test-legacy');
  assert(methods.indexOf('config/read') < methods.indexOf('config/get'));
  assert(stages.some((event) => event.stage === 'config/read' && event.outcome === 'failed'));
  assert(stages.some((event) => event.stage === 'config/get' && event.outcome === 'completed'));
});

test('完成消息将过程回复与最终回答分开', () => {
  const state = {
    buffer: '处理中\n\n中间结论\n\n最终结论',
    commentaryBuffer: '处理中',
    finalAnswerBuffer: '中间结论\n\n最终结论',
    agentMessages: new Map([
      ['commentary-1', { phase: 'commentary' as const, text: '处理中' }],
      ['final-1', { phase: 'final_answer' as const, text: '中间结论' }],
      ['final-2', { phase: 'final_answer' as const, text: '最终结论' }],
    ]),
    agentMessageOrder: ['commentary-1', 'final-1', 'final-2'],
  };
  assert.deepEqual(buildCompletedMessageContent(
    state,
  ), {
    content: '最终结论',
    processContent: '处理中\n\n中间结论',
    finalAnswerItemId: 'final-2',
  });
});

test('没有 phase 信息时保留兼容的完整回答', () => {
  assert.deepEqual(buildCompletedMessageContent({
    buffer: '兼容回答',
    commentaryBuffer: '',
    finalAnswerBuffer: '',
    agentMessages: new Map(),
    agentMessageOrder: [],
  }), {
    content: '兼容回答',
    processContent: undefined,
  });
});

test('从 agent message item 恢复合法 phase', () => {
  assert.equal(getAgentMessagePhase('commentary'), 'commentary');
  assert.equal(getAgentMessagePhase('final_answer'), 'final_answer');
  assert.equal(getAgentMessagePhase('answer'), null);
  assert.equal(getAgentMessagePhase(undefined), null);
});

test('不同 agent message item 之间自动保留段落间隔', () => {
  const first = appendAgentMessageItemText('', '第一段', 'item-1', null);
  const continued = appendAgentMessageItemText(first.text, '继续', 'item-1', first.itemId);
  const second = appendAgentMessageItemText(continued.text, '第二段', 'item-2', continued.itemId);

  assert.equal(first.appended, '第一段');
  assert.equal(continued.appended, '继续');
  assert.equal(second.appended, '\n\n第二段');
  assert.equal(second.text, '第一段继续\n\n第二段');
});

test('长时间 delta 停顿诊断只包含时间与长度元数据', () => {
  assert.equal(buildAgentMessageGapDiagnostic(
    'answer-1', 'final_answer', 1_000, 30_999, 4, 12,
  ), null);
  const diagnostic = buildAgentMessageGapDiagnostic(
    'answer-1', 'final_answer', 1_000, 31_000, 4, 12,
  );
  assert.deepEqual(diagnostic, {
    itemId: 'answer-1',
    phase: 'final_answer',
    gapMs: 30_000,
    deltaLength: 4,
    cumulativeLength: 12,
  });
  assert.equal('content' in (diagnostic || {}), false);
  assert.equal('delta' in (diagnostic || {}), false);
});

test('agentMessage 完成项使用权威全文校正重叠 delta', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-root' } } }));
      } else if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-root' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: {
          threadId: 'thread-root', turn: { id: 'turn-root' },
        } }));
        socket.send(JSON.stringify({ method: 'item/started', params: {
          threadId: 'thread-root', turnId: 'turn-root',
          item: { id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: '' },
        } }));
        socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-root', turnId: 'turn-root', itemId: 'answer-1',
          phase: 'final_answer', delta: '这是一个测',
        } }));
        socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-root', turnId: 'turn-root', itemId: 'answer-1',
          phase: 'final_answer', delta: '测试结果',
        } }));
        socket.send(JSON.stringify({ method: 'item/completed', params: {
          threadId: 'thread-root', turnId: 'turn-root',
          item: { id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: '这是一个测试结果' },
        } }));
        socket.send(JSON.stringify({ method: 'turn/completed', params: {
          threadId: 'thread-root', turn: { id: 'turn-root', status: 'completed' },
        } }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-root',
  });
  t.after(() => connection.close());

  connection.send('生成测试结果');
  await waitFor(() => events.some((event) => event.type === 'message_complete'));

  assert.equal(events.find((event) => event.type === 'message_complete')?.content, '这是一个测试结果');
  assert.deepEqual(
    events.filter((event) => event.type === 'delta').map((event) => event.content),
    ['这是一个测', '测试结果'],
  );
});

test('agentMessage 完成项空文本时保留 delta 并补齐最终回答 phase', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-empty-completed' } } }));
      } else if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-empty-completed' } } }));
        socket.send(JSON.stringify({ method: 'item/started', params: {
          threadId: 'thread-empty-completed', turnId: 'turn-empty-completed',
          item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: '' },
        } }));
        socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-empty-completed', turnId: 'turn-empty-completed',
          itemId: 'commentary-1', phase: 'commentary', delta: '处理中',
        } }));
        socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-empty-completed', turnId: 'turn-empty-completed',
          itemId: 'answer-1', delta: '最终结果',
        } }));
        socket.send(JSON.stringify({ method: 'item/completed', params: {
          threadId: 'thread-empty-completed', turnId: 'turn-empty-completed',
          item: { id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: '' },
        } }));
        socket.send(JSON.stringify({ method: 'turn/completed', params: {
          threadId: 'thread-empty-completed',
          turn: { id: 'turn-empty-completed', status: 'completed' },
        } }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-empty-completed',
  });
  t.after(() => connection.close());

  connection.send('生成最终结果');
  await waitFor(() => events.some((event) => event.type === 'message_complete' || event.type === 'error'));

  assert.deepEqual(events.find((event) => event.type === 'message_complete'), {
    type: 'message_complete',
    turnId: 'turn-empty-completed',
    content: '最终结果',
    processContent: '处理中',
    finalAnswerItemId: 'answer-1',
    usage: null,
  });
});

test('turn/start 遇到 app-server -32001 时有限退避后重试成功', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-retry' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
        if (turnAttempts < 3) {
          socket.send(JSON.stringify({ id: message.id, error: {
            code: -32001,
            message: 'Server overloaded; retry later.',
          } }));
          return;
        }
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-retry' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: {
          threadId: 'thread-retry', turn: { id: 'turn-retry' },
        } }));
      }
    });
  });

  const delays: number[] = [];
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-retry',
    retrySleep: async (delayMs) => { delays.push(delayMs); },
    retryRandom: () => 0.5,
  });
  t.after(() => connection.close());

  connection.send('重试任务');
  await waitFor(() => events.some((event) => event.type === 'turn_start'));

  assert.equal(turnAttempts, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(events.filter((event) => event.type === 'error').length, 0);
  assert.equal(events.filter((event) => event.type === 'capacity_observation' && event.observation.type === 'request_retry').length, 2);
});

test('turn/start 退避等待期间停止会取消后续重试', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-cancel-retry' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
        socket.send(JSON.stringify({ id: message.id, error: {
          code: -32001,
          message: 'Server overloaded; retry later.',
        } }));
      }
    });
  });

  let markRetryStarted!: () => void;
  const retryStarted = new Promise<void>((resolve) => { markRetryStarted = resolve; });
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-cancel-retry',
    retrySleep: async () => {
      markRetryStarted();
      await retryGate;
    },
    retryRandom: () => 0.5,
  });
  t.after(() => connection.close());

  connection.send('可取消重试任务');
  await retryStarted;
  const interruptOutcome = await Promise.race([
    connection.interrupt().then(() => 'resolved', () => 'rejected'),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
  ]);
  releaseRetry();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(interruptOutcome, 'resolved');
  assert.equal(turnAttempts, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 0);
});

test('turn/start 退避期间回合已结束时旧等待不会再次发送', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;
  let activeSocket: any = null;

  server.on('connection', (socket) => {
    activeSocket = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-ended-during-retry' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
        socket.send(JSON.stringify({ id: message.id, error: {
          code: -32001,
          message: 'Server overloaded; retry later.',
        } }));
      }
    });
  });

  let markRetryStarted!: () => void;
  const retryStarted = new Promise<void>((resolve) => { markRetryStarted = resolve; });
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const connection = createCodexConnection(() => {}, {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-ended-during-retry',
    retrySleep: async () => {
      markRetryStarted();
      await retryGate;
    },
    retryRandom: () => 0.5,
  });
  t.after(() => connection.close());

  connection.send('结束后不重试');
  await retryStarted;
  activeSocket.send(JSON.stringify({ method: 'turn/started', params: {
    threadId: 'thread-ended-during-retry', turn: { id: 'turn-ended-during-retry' },
  } }));
  activeSocket.send(JSON.stringify({ method: 'turn/completed', params: {
    threadId: 'thread-ended-during-retry',
    turn: { id: 'turn-ended-during-retry', status: 'interrupted' },
  } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseRetry();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(turnAttempts, 1);
});

test('turn/start 请求级短暂 429 尊重 retry-after 后重试', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-rate-limit' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
        if (turnAttempts === 1) {
          socket.send(JSON.stringify({ id: message.id, error: {
            code: 429,
            message: 'Too many requests',
            data: { httpStatusCode: 429, retryAfterMs: 25 },
          } }));
          return;
        }
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-rate-limit' } } }));
      }
    });
  });

  const delays: number[] = [];
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-rate-limit',
    retrySleep: async (delayMs) => { delays.push(delayMs); },
    retryRandom: () => 0.5,
  });
  t.after(() => connection.close());

  connection.send('限流任务');
  await waitFor(() => events.some((event) => event.type === 'turn_start'));

  assert.equal(turnAttempts, 2);
  assert.deepEqual(delays, [25]);
  assert.equal(events.filter((event) => event.type === 'capacity_observation').length, 1);
});

test('turn/start 的 -32001 包装 HTTP 429 时仍按限流边界处理', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-wrapped-rate-limit' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
        socket.send(JSON.stringify({ id: message.id, error: {
          code: -32001,
          message: 'Upstream request failed',
          data: { httpStatusCode: 429, retryAfterMs: 10 },
        } }));
      }
    });
  });

  const delays: number[] = [];
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-wrapped-rate-limit',
    retrySleep: async (delayMs) => { delays.push(delayMs); },
    retryRandom: () => 0.5,
  });
  t.after(() => connection.close());

  connection.send('包装限流任务');
  await waitFor(() => events.some((event) => event.type === 'error'));

  assert.equal(turnAttempts, 3);
  assert.deepEqual(delays, [10, 10]);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.filter((event) => event.type === 'capacity_observation').length, 2);
  assert.deepEqual(events.find((event) => event.type === 'error'), { type: 'error', message: '发送消息失败: Upstream request failed', code: 'CODEX_USAGE_LIMIT_EXCEEDED', retryAfterMs: 10 });
});

test('turn/start -32001 重试耗尽后只报告一次失败', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-overloaded' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
        socket.send(JSON.stringify({ id: message.id, error: {
          code: -32001,
          message: 'Server overloaded; retry later.',
        } }));
      }
    });
  });

  const delays: number[] = [];
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 1_000,
    threadId: 'thread-overloaded',
    retrySleep: async (delayMs) => { delays.push(delayMs); },
    retryRandom: () => 0.5,
  });
  t.after(() => connection.close());

  connection.send('持续拥塞任务');
  await waitFor(() => events.some((event) => event.type === 'error'), 5_000);

  assert.equal(turnAttempts, 4);
  assert.deepEqual(delays, [500, 1000, 2000]);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.filter((event) => event.type === 'capacity_observation').length, 3);
  assert.equal(events.find((event) => event.type === 'error')?.code, 'CODEX_SERVER_OVERLOADED');
});

test('turn/start 429 等待时间过长时不自动重试', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-long-rate-limit' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
        socket.send(JSON.stringify({ id: message.id, error: {
          code: 429,
          message: 'Too many requests',
          data: { httpStatusCode: 429, retryAfterMs: 30_001 },
        } }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-long-rate-limit',
    retrySleep: async () => assert.fail('长时间限流不应进入自动退避'),
  });
  t.after(() => connection.close());

  connection.send('长时间限流任务');
  await waitFor(() => events.some((event) => event.type === 'error'));

  assert.equal(turnAttempts, 1);
});

test('turn/start 超时不能自动重发不确定请求', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-timeout' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 40,
    threadId: 'thread-timeout',
    retrySleep: async () => assert.fail('超时不应进入退避'),
  });
  t.after(() => connection.close());

  connection.send('不确定任务');
  await waitFor(() => events.some((event) => event.type === 'error'));

  assert.equal(turnAttempts, 1);
});

test('已经收到 turn/started 后即使 RPC 返回可重试错误也不能重发', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let turnAttempts = 0;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-started-first' } } }));
      } else if (message.method === 'turn/start') {
        turnAttempts += 1;
        socket.send(JSON.stringify({ method: 'turn/started', params: {
          threadId: 'thread-started-first', turn: { id: 'turn-started-first' },
        } }));
        socket.send(JSON.stringify({ id: message.id, error: {
          code: -32001,
          message: 'Server overloaded; retry later.',
        } }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-started-first',
    retrySleep: async () => assert.fail('已启动回合不应进入退避'),
  });
  t.after(() => connection.close());

  connection.send('已启动任务');
  await waitFor(() => events.some((event) => event.type === 'turn_start'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(turnAttempts, 1);
  assert.equal(events.filter((event) => event.type === 'turn_start').length, 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 0);
  assert.equal(events.filter((event) => event.type === 'capacity_observation').length, 0);
});

test('提取 Codex 失败回合的真实消息和稳定错误码', () => {
  assert.deepEqual(extractTurnFailure({
    turn: {
      status: 'failed',
      error: {
        message: 'You have hit your usage limit.',
        codexErrorInfo: 'usageLimitExceeded',
      },
    },
  }), {
    message: 'You have hit your usage limit.',
    code: 'CODEX_USAGE_LIMIT_EXCEEDED',
  });
  assert.deepEqual(extractTurnFailure({
    turn: {
      status: 'failed',
      error: {
        message: '',
        additionalDetails: '响应流已断开',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      },
    },
  }), {
    message: '响应流已断开',
    code: 'CODEX_RESPONSE_STREAM_DISCONNECTED',
  });
  assert.equal(extractTurnFailure({ turn: { status: 'completed', error: null } }), null);
});

test('恢复活动回合时先 resume 订阅再分页补取权威快照', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const methods: string[] = [];

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      methods.push(message.method);
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        assert.deepEqual(message.params, { threadId: 'thread-recovery', excludeTurns: true, config: { 'tools.update_plan.enabled': true } });
        socket.send(JSON.stringify({ id: message.id, result: { thread: {
          id: 'thread-recovery', status: { type: 'active', activeFlags: [] },
        } } }));
      } else if (message.method === 'thread/turns/list') {
        assert.deepEqual(message.params, {
          threadId: 'thread-recovery', limit: 100, sortDirection: 'desc', itemsView: 'notLoaded',
        });
        socket.send(JSON.stringify({ id: message.id, result: { data: [
          { id: 'turn-recovery', status: 'inProgress', durationMs: 2500, items: [] },
        ], nextCursor: null } }));
      } else if (message.method === 'thread/items/list') {
        assert.deepEqual(message.params, {
          threadId: 'thread-recovery', turnId: 'turn-recovery', limit: 100, sortDirection: 'asc',
        });
        socket.send(JSON.stringify({ method: 'item/started', params: {
          threadId: 'thread-recovery', turnId: 'turn-recovery',
          item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' },
        } }));
        socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-recovery', turnId: 'turn-recovery', itemId: 'answer',
          phase: 'final_answer', delta: '恢复后的最终结果',
        } }));
        socket.send(JSON.stringify({ id: message.id, result: { data: [{
          turnId: 'turn-recovery',
          item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '已有内容，恢复后的最终结果' },
        }], nextCursor: null } }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    threadId: 'thread-recovery',
    recoverTurnId: 'turn-recovery',
    wsUrl: `ws://127.0.0.1:${address.port}`,
  });
  t.after(() => connection.close());

  await waitFor(() => events.some((event) => event.type === 'recovery_snapshot'));
  assert(methods.indexOf('thread/resume') < methods.indexOf('thread/turns/list'));
  assert(methods.indexOf('thread/turns/list') < methods.indexOf('thread/items/list'));
  assert.equal(methods.includes('thread/read'), false);
  assert.deepEqual(events.find((event) => event.type === 'recovery_snapshot'), {
    type: 'recovery_snapshot',
    turnId: 'turn-recovery',
    status: 'inProgress',
    content: '已有内容，恢复后的最终结果',
    finalAnswerItemId: 'answer',
    processTimeline: [{ type: 'narrative', itemId: 'answer', content: '已有内容，恢复后的最终结果' }],
    items: [],
    waitingOnInteraction: false,
    durationMs: 2500,
    error: null,
  });
  assert.equal(events.some((event) => event.type === 'delta'), false);
});

test('恢复握手期间的中断等待真实 turn id 后再发送', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const methods: string[] = [];
  let completeItems!: () => void;

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      methods.push(message.method);
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: {
          id: 'thread-recovery', status: { type: 'active', activeFlags: [] },
        } } }));
      } else if (message.method === 'thread/turns/list') {
        socket.send(JSON.stringify({ id: message.id, result: { data: [
          { id: 'turn-recovery', status: 'inProgress', items: [] },
        ], nextCursor: null } }));
      } else if (message.method === 'thread/items/list') {
        completeItems = () => socket.send(JSON.stringify({ id: message.id, result: {
          data: [], nextCursor: null,
        } }));
      } else if (message.method === 'turn/interrupt') {
        assert.deepEqual(message.params, { threadId: 'thread-recovery', turnId: 'turn-recovery' });
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      }
    });
  });

  const connection = createCodexConnection(() => undefined, {
    threadId: 'thread-recovery',
    recoverTurnId: 'turn-recovery',
    wsUrl: `ws://127.0.0.1:${address.port}`,
  });
  t.after(() => connection.close());

  const interrupt = connection.interrupt();
  await waitFor(() => methods.includes('thread/items/list'));
  assert.equal(methods.includes('turn/interrupt'), false);
  completeItems();
  await interrupt;
  assert.equal(methods.includes('turn/interrupt'), true);
});

test('已完成回合恢复后新启动的回合仍可正常中断', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const interruptedTurns: string[] = [];

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: {
          id: 'thread-recovery', status: { type: 'idle' },
        } } }));
      } else if (message.method === 'thread/turns/list') {
        socket.send(JSON.stringify({ id: message.id, result: { data: [
          { id: 'turn-completed', status: 'completed', items: [] },
        ], nextCursor: null } }));
      } else if (message.method === 'thread/items/list') {
        socket.send(JSON.stringify({ id: message.id, result: { data: [{
          turnId: 'turn-completed',
          item: { id: 'answer-completed', type: 'agentMessage', phase: 'final_answer', text: '已完成' },
        }], nextCursor: null } }));
      } else if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-new' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: {
          threadId: 'thread-recovery', turn: { id: 'turn-new' },
        } }));
      } else if (message.method === 'turn/interrupt') {
        interruptedTurns.push(message.params.turnId);
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    threadId: 'thread-recovery',
    recoverTurnId: 'turn-completed',
    wsUrl: `ws://127.0.0.1:${address.port}`,
  });
  t.after(() => connection.close());

  await waitFor(() => events.some((event) => event.type === 'recovery_snapshot'));
  connection.send('开始新任务');
  await waitFor(() => events.some((event) => event.type === 'turn_start' && event.turnId === 'turn-new'));
  await connection.interrupt();
  assert.deepEqual(interruptedTurns, ['turn-new']);
});

test('子线程完成事件不会生成主线程回复或清空主线程状态', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-root' } } }));
      } else if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-root' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-root', turn: { id: 'turn-root' } } }));

        socket.send(JSON.stringify({
          method: 'item/started',
          params: {
            threadId: 'thread-child',
            turnId: 'turn-child',
            item: { id: 'child-answer', type: 'agentMessage', text: '', phase: 'final_answer' },
          },
        }));
        socket.send(JSON.stringify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-child', turnId: 'turn-child', itemId: 'child-answer', delta: '子任务回执' },
        }));
        socket.send(JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'thread-child', turn: { id: 'turn-child' } },
        }));

        socket.send(JSON.stringify({
          method: 'item/started',
          params: {
            threadId: 'thread-root',
            turnId: 'turn-root',
            item: { id: 'root-answer', type: 'agentMessage', text: '', phase: 'final_answer' },
          },
        }));
        socket.send(JSON.stringify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-root', turnId: 'turn-root', itemId: 'root-answer', delta: '主任务最终回答' },
        }));
        socket.send(JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'thread-root', turn: { id: 'turn-root' } },
        }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-root',
  });
  t.after(() => connection.close());

  connection.send('并行处理任务');
  await waitFor(() => events.some((event) => event.type === 'message_complete' && event.content === '主任务最终回答'));

  assert.deepEqual(events.filter((event) => event.type === 'delta').map((event) => event.content), ['主任务最终回答']);
  assert.equal(events.filter((event) => event.type === 'item_start').length, 1);
  assert.deepEqual(events.filter((event) => event.type === 'message_complete').map((event) => event.content), ['主任务最终回答']);
});

for (const interrupted of [false, true]) test(`旧回合迟到事件不污染下一回合（${interrupted ? '中断' : '完成'}）且保留异步问题`, async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let peer: any;
  let turns = 0;
  const send = (method: string, params: any) => peer.send(JSON.stringify({ method, params: { threadId: 'root', ...params } }));
  const delta = (turnId: string, delta: string) => send('item/agentMessage/delta', { turnId, itemId: turnId, phase: 'final_answer', delta });
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === 'initialized') return;
      const result = request.method === 'thread/start' ? { thread: { id: 'root' } }
        : request.method === 'turn/start' ? { turn: { id: `turn-${++turns}` } } : {};
      socket.send(JSON.stringify({ id: request.id, result }));
      if (request.method === 'turn/start') send('turn/started', { turn: { id: `turn-${turns}` } });
    });
  });
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), { wsUrl: `ws://127.0.0.1:${address.port}` });
  t.after(() => connection.close());
  connection.send('first');
  await waitFor(() => events.some((event) => event.type === 'turn_start' && event.turnId === 'turn-1'));
  if (interrupted) await connection.interrupt();
  else {
    delta('turn-1', 'FIRST');
    send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await waitFor(() => events.some((event) => event.type === 'message_complete'));
  }
  // Old started/delta/completed events also arrive while the next RPC has not
  // yet established its turn id, and must not revive the retired turn.
  send('turn/started', { turn: { id: 'turn-1' } });
  delta('turn-1', 'STALE-IDLE');
  send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  connection.send('second');
  await waitFor(() => events.some((event) => event.type === 'turn_start' && event.turnId === 'turn-2'));
  delta('turn-2', 'SECOND-BEGIN');
  await waitFor(() => events.some((event) => event.type === 'delta' && event.content === 'SECOND-BEGIN'));
  send('turn/started', { turn: { id: 'turn-1' } });
  delta('turn-1', 'STALE');
  send('item/completed', { turnId: 'turn-1', item: { id: 'old', type: 'agentMessage', phase: 'final_answer', text: 'STALE-COMPLETE' } });
  send('turn/completed', { turn: { id: 'turn-1', status: interrupted ? 'interrupted' : 'completed' } });
  send('item/completed', { turnId: 'turn-1', item: { id: 'question', type: 'agentMessage', delivery: 'async', text: 'QUESTION-TEXT', questions: [{ title: 'Continue?' }] } });
  send('serverRequest/resolved', { threadId: 'child', requestId: 42 });
  delta('turn-2', '-END');
  send('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
  await waitFor(() => events.some((event) => event.type === 'message_complete' && event.turnId === 'turn-2'));
  assert.equal(events.find((event) => event.type === 'message_complete' && event.turnId === 'turn-2').content, 'SECOND-BEGIN-END');
  assert.deepEqual(events.filter((event) => event.type === 'delta').map((event) => event.content), interrupted ? ['SECOND-BEGIN', '-END'] : ['FIRST', 'SECOND-BEGIN', '-END']);
  assert.equal(events.filter((event) => event.type === 'turn_start').length, 2);
  assert.equal(events.filter((event) => event.type === 'turn_complete').length, interrupted ? 1 : 2);
  assert(events.some((event) => event.type === 'item_complete' && event.item.id === 'question'));
  assert(events.some((event) => event.type === 'server_request_resolved' && event.requestId === 42));
  assert(!events.some((event) => event.type === 'error'));
});

test('计划通知只接收当前根回合并使用稳定 ID 更新，结束后忽略迟到通知', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.method === 'initialized') return;
    if (request.method === 'initialize' || request.method === 'config/read') {
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    } else if (request.method === 'thread/resume') {
      socket.send(JSON.stringify({ id: request.id, result: { thread: { id: 'root' } } }));
    } else if (request.method === 'turn/start') {
      const send = (method: string, params: unknown) => socket.send(JSON.stringify({ method, params }));
      const plan = (turnId: string, status: string, threadId?: string) => send('turn/plan/updated', {
        turnId, threadId, plan: [{ step: '验证', status }],
      });
      socket.send(JSON.stringify({ id: request.id, result: { turn: { id: 'turn' } } }));
      send('turn/started', { threadId: 'root', turn: { id: 'turn' } });
      plan('turn', 'inProgress', 'child');
      plan('old-turn', 'inProgress', 'root');
      plan('turn', 'inProgress', 'root');
      plan('turn', 'completed');
      send('item/agentMessage/delta', { threadId: 'root', turnId: 'turn', itemId: 'answer', phase: 'final_answer', delta: '完成' });
      send('turn/completed', { threadId: 'root', turn: { id: 'turn' } });
      plan('turn', 'pending', 'root');
    }
  }));
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`, rpcTimeoutMs: 200, threadId: 'root',
  });
  t.after(() => connection.close());
  connection.send('验证计划');
  await waitFor(() => events.some((event) => event.type === 'message_complete'));
  const plans = events.filter((event) => event.item?.type === 'plan');
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((event) => event.item.id), ['relay-plan:turn', 'relay-plan:turn']);
  assert.deepEqual(plans.map((event) => event.item.plan[0].status), ['inProgress', 'completed']);
});

test('主线程没有最终回复时不能生成成功完成事件', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-root' } } }));
      } else if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-root' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-root', turn: { id: 'turn-root' } } }));
        socket.send(JSON.stringify({
          method: 'item/started',
          params: {
            threadId: 'thread-root',
            turnId: 'turn-root',
            item: { id: 'root-commentary', type: 'agentMessage', text: '', phase: 'commentary' },
          },
        }));
        socket.send(JSON.stringify({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-root', turnId: 'turn-root', itemId: 'root-commentary', delta: '仍在处理中' },
        }));
        socket.send(JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'thread-root', turn: { id: 'turn-root' } },
        }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-root',
  });
  t.after(() => connection.close());

  connection.send('只生成过程内容');
  await waitFor(() => events.some((event) => event.type === 'error' && event.code === 'FINAL_ANSWER_MISSING'));

  assert.equal(events.some((event) => event.type === 'message_complete'), false);
  assert.deepEqual(events.find((event) => event.code === 'FINAL_ANSWER_MISSING'), {
    type: 'error',
    message: '未生成最终回复',
    code: 'FINAL_ANSWER_MISSING',
  });
});

test('无执行痕迹的完成阶段过载按 2 秒和 5 秒退避后自动重试成功', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let turnStartCount = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-root' } } }));
      else if (message.method === 'turn/start') {
        turnStartCount += 1;
        const turnId = `turn-overload-${turnStartCount}`;
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-root', turn: { id: turnId } } }));
        if (turnStartCount < 3) {
          socket.send(JSON.stringify({
            method: 'turn/completed',
            params: {
              threadId: 'thread-root',
              turn: {
                id: turnId,
                status: 'failed',
                error: { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded' },
              },
            },
          }));
          return;
        }
        socket.send(JSON.stringify({
          method: 'item/completed',
          params: {
            threadId: 'thread-root',
            turnId,
            item: { id: 'answer-final', type: 'agentMessage', phase: 'final_answer', text: '重试成功' },
          },
        }));
        socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-root', turn: { id: turnId, status: 'completed' } } }));
      }
    });
  });

  const delays: number[] = [];
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-root',
    retryRandom: () => 0.5,
    retrySleep: async (delayMs) => { delays.push(delayMs); },
  });
  t.after(() => connection.close());

  connection.send('继续');
  await waitFor(() => events.some((event) => event.type === 'message_complete'));

  assert.equal(turnStartCount, 3);
  assert.deepEqual(delays, [2_000, 5_000]);
  assert.equal(events.filter((event) => event.type === 'error').length, 0);
  assert.equal(events.find((event) => event.type === 'message_complete')?.content, '重试成功');
  assert.equal(events.filter((event) => event.type === 'capacity_observation' && event.observation.type === 'completion_retry').length, 2);
});

test('单纯 reasoning item started 不阻止完成阶段安全重试', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let turnStartCount = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-root' } } }));
      else if (message.method === 'turn/start') {
        turnStartCount += 1;
        const turnId = `turn-reasoning-${turnStartCount}`;
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-root', turn: { id: turnId } } }));
        socket.send(JSON.stringify({ method: 'item/started', params: {
          threadId: 'thread-root', turnId, item: { id: `reasoning-${turnStartCount}`, type: 'reasoning', status: 'in_progress' },
        } }));
        if (turnStartCount === 1) {
          socket.send(JSON.stringify({ method: 'turn/completed', params: {
            threadId: 'thread-root', turn: { id: turnId, status: 'failed', error: { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded' } },
          } }));
        } else {
          socket.send(JSON.stringify({ method: 'item/completed', params: {
            threadId: 'thread-root', turnId, item: { id: 'answer-final', type: 'agentMessage', phase: 'final_answer', text: '重试成功' },
          } }));
          socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-root', turn: { id: turnId, status: 'completed' } } }));
        }
      }
    });
  });

  const delays: number[] = [];
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-root',
    retryRandom: () => 0.5,
    retrySleep: async (delayMs) => { delays.push(delayMs); },
  });
  t.after(() => connection.close());

  connection.send('继续');
  await waitFor(() => events.some((event) => event.type === 'message_complete'));

  assert.equal(turnStartCount, 2);
  assert.deepEqual(delays, [2_000]);
});

test('完成阶段过载重试耗尽后只保留一次原始异常', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let turnStartCount = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-root' } } }));
      else if (message.method === 'turn/start') {
        turnStartCount += 1;
        const turnId = `turn-overload-${turnStartCount}`;
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-root', turn: { id: turnId } } }));
        socket.send(JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-root',
            turn: {
              id: turnId,
              status: 'failed',
              error: { message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded' },
            },
          },
        }));
      }
    });
  });

  const delays: number[] = [];
  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-root',
    retryRandom: () => 0.5,
    retrySleep: async (delayMs) => { delays.push(delayMs); },
  });
  t.after(() => connection.close());

  connection.send('继续');
  await waitFor(() => events.some((event) => event.type === 'error'));

  assert.equal(turnStartCount, 4);
  assert.deepEqual(delays, [2_000, 5_000, 10_000]);
  assert.deepEqual(events.filter((event) => event.type === 'error'), [{
    type: 'error',
    message: 'Selected model is at capacity. Please try a different model.',
    code: 'CODEX_SERVER_OVERLOADED',
  }]);
  assert.equal(events.filter((event) => event.type === 'capacity_observation' && event.observation.type === 'completion_retry').length, 3);
});

test('完成阶段过载退避期间停止不会发送下一次回合', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let turnStartCount = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-root' } } }));
      else if (message.method === 'turn/start') {
        turnStartCount += 1;
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-overload' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-root', turn: { id: 'turn-overload' } } }));
        socket.send(JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-root',
            turn: {
              id: 'turn-overload',
              status: 'failed',
              error: { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded' },
            },
          },
        }));
      }
    });
  });

  let releaseRetry = () => {};
  const retryWaiting = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const delays: number[] = [];
  const connection = createCodexConnection(() => {}, {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-root',
    retryRandom: () => 0.5,
    retrySleep: async (delayMs) => {
      delays.push(delayMs);
      await retryWaiting;
    },
  });
  t.after(() => connection.close());

  connection.send('继续');
  await waitFor(() => delays.length === 1);
  await connection.interrupt();
  releaseRetry();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(delays, [2_000]);
  assert.equal(turnStartCount, 1);
});

test('主线程明确失败时保留 Codex 真实错误而不是误报缺少最终回复', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-root' } } }));
      } else if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-root' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-root', turn: { id: 'turn-root' } } }));
        socket.send(JSON.stringify({
          method: 'item/started',
          params: { threadId: 'thread-root', turnId: 'turn-root', item: { id: 'tool-1', type: 'commandExecution' } },
        }));
        socket.send(JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-root',
            turn: {
              id: 'turn-root',
              status: 'failed',
              error: {
                message: 'Selected model is at capacity. Please try a different model.',
                codexErrorInfo: 'serverOverloaded',
                additionalDetails: null,
              },
            },
          },
        }));
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-root',
  });
  t.after(() => connection.close());

  connection.send('继续');
  await waitFor(() => events.some((event) => event.type === 'error'));

  assert.deepEqual(events.find((event) => event.type === 'error'), {
    type: 'error',
    message: 'Selected model is at capacity. Please try a different model.',
    code: 'CODEX_SERVER_OVERLOADED',
  });
  assert.equal(events.some((event) => event.code === 'FINAL_ANSWER_MISSING'), false);
  assert.equal(events.some((event) => event.type === 'message_complete'), false);
});

test('提取 Codex thread token usage 的最新上下文占用', () => {
  assert.deepEqual(extractThreadTokenUsage({
    tokenUsage: {
      last: {
        inputTokens: 1200,
        cachedInputTokens: 800,
        outputTokens: 160,
        reasoningOutputTokens: 40,
        totalTokens: 1360,
      },
      total: { inputTokens: 3000, outputTokens: 500, totalTokens: 3500 },
      modelContextWindow: 200000,
    },
  }), {
    inputTokens: 1200,
    cachedInputTokens: 800,
    outputTokens: 160,
    reasoningOutputTokens: 40,
    totalTokens: 1360,
    modelContextWindow: 200000,
  });
  assert.equal(extractThreadTokenUsage({ tokenUsage: { last: { inputTokens: 1 } } }), null);
});

test('停止已启动任务时使用 Codex 返回的真实 turn ID 调用 turn/interrupt', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let interruptParams: Record<string, unknown> | null = null;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: { serverInfo: { model: 'test' } } }));
      } else if (message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: { model: 'test' } }));
      } else if (message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-real' } } }));
      } else if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-real' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-real', turn: { id: 'turn-real' } } }));
      } else if (message.method === 'turn/interrupt') {
        interruptParams = message.params;
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      }
    });
  });

  const events: Array<{ type: string; turnId?: string }> = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
    threadId: 'thread-real',
  });
  t.after(() => connection.close());

  connection.send('继续处理');
  await waitFor(() => events.some((event) => event.type === 'turn_start'));
  await connection.interrupt();

  assert.deepEqual(interruptParams, { threadId: 'thread-real', turnId: 'turn-real' });
  assert.equal(events.find((event) => event.type === 'turn_start')?.turnId, 'turn-real');
});

test('取消请求被拒绝时仍保留竞态到达的真实完成或失败终态', async (t) => {
  for (const status of ['completed', 'failed'] as const) {
    await t.test(status, async (t) => {
      const server = new WebSocketServer({ port: 0 });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      t.after(() => server.close());
      const address = server.address();
      assert(address && typeof address === 'object');
      let interruptCalls = 0;
      server.on('connection', (socket) => socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.method === 'initialized') return;
        if (message.method === 'initialize' || message.method === 'config/read') {
          socket.send(JSON.stringify({ id: message.id, result: {} }));
        } else if (message.method === 'thread/resume') {
          socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-race' } } }));
        } else if (message.method === 'turn/start') {
          socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-race' } } }));
          socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-race', turn: { id: 'turn-race' } } }));
        } else if (message.method === 'turn/interrupt') {
          interruptCalls++;
          socket.send(JSON.stringify({ method: 'item/completed', params: {
            threadId: 'thread-race', turnId: 'turn-race',
            item: { id: 'answer-race', type: 'agentMessage', phase: 'final_answer', text: '原始最终回复' },
          } }));
          socket.send(JSON.stringify({ method: 'turn/completed', params: {
            threadId: 'thread-race', turn: { id: 'turn-race', status,
              ...(status === 'failed' ? { error: { message: '真实执行失败' } } : {}),
            },
          } }));
          socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'Invalid request' } }));
        }
      }));
      const events: Array<{ type: string; content?: string; code?: string; message?: string }> = [];
      const connection = createCodexConnection((event) => events.push(event), {
        wsUrl: `ws://127.0.0.1:${address.port}`, rpcTimeoutMs: 200, threadId: 'thread-race',
      });
      t.after(() => connection.close());
      connection.send('开始');
      await waitFor(() => events.some((event) => event.type === 'turn_start'));
      await assert.rejects(connection.interrupt(), (error: unknown) =>
        error instanceof Error && 'rpcCode' in error && error.rpcCode === -32600);
      assert.equal(interruptCalls, 1);
      assert.equal(events.filter((event) => event.type === 'turn_complete').length, 1);
      if (status === 'completed') {
        assert.equal(events.find((event) => event.type === 'message_complete')?.content, '原始最终回复');
      } else {
        assert.equal(events.find((event) => event.type === 'error')?.message, '真实执行失败');
        assert.equal(events.some((event) => event.type === 'message_complete'), false);
      }
    });
  }
});

test('运行中引导使用真实回合 ID 和幂等消息 ID，失配时不发送', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const steerParams: Record<string, unknown>[] = [];
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-steer' } } }));
    else if (message.method === 'turn/start') {
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-steer' } } }));
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-steer', turn: { id: 'turn-steer' } } }));
    } else if (message.method === 'turn/steer') {
      steerParams.push(message.params);
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-steer' } } }));
    }
  }));
  const events: Array<{ type: string }> = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`, rpcTimeoutMs: 200, threadId: 'thread-steer',
  });
  t.after(() => connection.close());
  connection.send('开始');
  await waitFor(() => events.some((event) => event.type === 'turn_start'));
  assert.equal(await connection.steer({ content: '补充', messageId: 'message-1', expectedTurnId: 'turn-steer' }), 'accepted');
  assert.deepEqual(steerParams, [{ threadId: 'thread-steer', expectedTurnId: 'turn-steer', clientUserMessageId: 'message-1', input: [{ type: 'text', text: '补充' }] }]);
  assert.equal(await connection.steer({ content: '错误回合', messageId: 'message-2', expectedTurnId: 'old' }), 'turn_changed');
  assert.equal(steerParams.length, 1);
});

test('引导只对明确不支持回退；超时保持结果不确定', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let steerCalls = 0;
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize' || message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-steer-errors' } } }));
    else if (message.method === 'turn/start') {
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-steer-errors' } } }));
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-steer-errors', turn: { id: 'turn-steer-errors' } } }));
    } else if (message.method === 'turn/steer') {
      steerCalls++;
      if (steerCalls === 1) socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Method not found' } }));
      if (steerCalls === 3) socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'expected active turn id `turn-steer-errors` but found `turn-new`' } }));
      if (steerCalls === 4) socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'no active turn to steer' } }));
    }
  }));
  const events: Array<{ type: string }> = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`, rpcTimeoutMs: 50, threadId: 'thread-steer-errors',
  });
  t.after(() => connection.close());
  connection.send('开始');
  await waitFor(() => events.some((event) => event.type === 'turn_start'));
  const input = { content: '补充', messageId: 'message-1', expectedTurnId: 'turn-steer-errors' };
  assert.equal(await connection.steer(input), 'unsupported');
  await assert.rejects(connection.steer({ ...input, messageId: 'message-2' }), /超时/);
  assert.equal(await connection.steer({ ...input, messageId: 'message-3' }), 'turn_changed');
  assert.equal(await connection.steer({ ...input, messageId: 'message-4' }), 'turn_changed');
  assert.equal(steerCalls, 4);
});

test('子代理主动授权请求不会被线程过滤，并可回传决定', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let approvalResponse: any = null;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'thread/start') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-approval' } } }));
      else if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-approval' } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-approval' } } }));
        socket.send(JSON.stringify({
          id: 1,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thread-child', turnId: 'turn-child', itemId: 'item-1', startedAtMs: Date.now(), command: 'npm test' },
        }));
      } else if (message.id === 1 && message.result) {
        approvalResponse = message.result;
      }
    });
  });

  const events: any[] = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
  });
  t.after(() => connection.close());

  connection.send('执行需要授权的任务');
  await waitFor(() => events.some((event) => event.type === 'server_request'));
  const request = events.find((event) => event.type === 'server_request');
  assert.equal(request.method, 'item/commandExecution/requestApproval');
  connection.respondToServerRequest(request.requestId, { decision: 'accept' });
  await waitFor(() => approvalResponse !== null);
  assert.deepEqual(approvalResponse, { decision: 'accept' });
});

test('新建 thread 注册 Relay 文件报告工具并只处理精确工具调用', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let threadStartParams: Record<string, any> | null = null;
  const toolResponses = new Map<string, any>();
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') {
        assert.equal(message.params.capabilities.experimentalApi, true);
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/start') {
        threadStartParams = message.params;
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-report' } } }));
        socket.send(JSON.stringify({
          id: 'report-valid',
          method: 'item/tool/call',
          params: {
            threadId: 'thread-report',
            turnId: 'turn-report',
            callId: 'call-report',
            namespace: null,
            tool: RELAY_FILE_CHANGE_REPORT_TOOL,
            arguments: {
              version: 1,
              reportedFileChanges: [{ path: 'output/report.pdf', changeType: 'added' }],
            },
          },
        }));
        socket.send(JSON.stringify({
          id: 'report-unknown',
          method: 'item/tool/call',
          params: {
            threadId: 'thread-report',
            turnId: 'turn-report',
            callId: 'call-unknown',
            namespace: null,
            tool: 'unknown_tool',
            arguments: {},
          },
        }));
        socket.send(JSON.stringify({
          id: 'report-wrong-namespace',
          method: 'item/tool/call',
          params: {
            threadId: 'thread-report',
            turnId: 'turn-report',
            callId: 'call-wrong-namespace',
            namespace: 'other',
            tool: RELAY_FILE_CHANGE_REPORT_TOOL,
            arguments: {
              version: 1,
              reportedFileChanges: [{ path: 'output/report.pdf', changeType: 'added' }],
            },
          },
        }));
      } else if (typeof message.id === 'string') {
        toolResponses.set(message.id, message.result);
      }
    });
  });

  const connection = createCodexConnection(() => {}, {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
  });
  t.after(() => connection.close());

  await waitFor(() => toolResponses.size === 3);
  assert.equal((threadStartParams as Record<string, any> | null)?.dynamicTools?.[0]?.name, RELAY_FILE_CHANGE_REPORT_TOOL);
  assert.equal(toolResponses.get('report-valid')?.success, true);
  assert.match(toolResponses.get('report-valid')?.contentItems?.[0]?.text || '', /已登记 1 个文件变更/);
  assert.deepEqual(toolResponses.get('report-unknown'), { contentItems: [], success: false });
  assert.deepEqual(toolResponses.get('report-wrong-namespace'), { contentItems: [], success: false });
});

test('Relay 文件报告工具拒绝缺少版本或无效条目的参数', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let toolResponse: any = null;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'thread/start') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-report-invalid' } } }));
        socket.send(JSON.stringify({
          id: 'report-invalid',
          method: 'item/tool/call',
          params: {
            namespace: null,
            tool: RELAY_FILE_CHANGE_REPORT_TOOL,
            arguments: {
              reportedFileChanges: [{ path: 'output/report.pdf', changeType: 'written' }],
            },
          },
        }));
      } else if (message.id === 'report-invalid') {
        toolResponse = message.result;
      }
    });
  });

  const connection = createCodexConnection(() => {}, {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
  });
  t.after(() => connection.close());

  await waitFor(() => toolResponse !== null);
  assert.equal(toolResponse.success, false);
  assert.match(toolResponse.contentItems?.[0]?.text || '', /格式无效/);
});

test('Codex JSON-RPC 无响应时在限定时间内返回初始化失败', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  const events: Array<{ type: string; message?: string; code?: string }> = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 30,
  });
  t.after(() => connection.close());

  await waitFor(() => events.some((event) => event.type === 'error'));
  const error = events.find((event) => event.type === 'error');
  assert.equal(error?.code, 'CODEX_INIT_FAILED');
  assert.match(error?.message || '', /initialize.*超时/);
});

test('thread/start 使用独立超时并记录握手各阶段耗时', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });

  const stages: Array<{ stage: string; outcome: string; durationMs: number; timeoutMs?: number; error?: string }> = [];
  const events: Array<{ type: string; message?: string; code?: string }> = [];
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 20,
    threadStartTimeoutMs: 70,
    onHandshakeStage: (event) => stages.push(event),
  });
  t.after(() => connection.close());

  await waitFor(() => events.some((event) => event.type === 'error'));
  const error = events.find((event) => event.type === 'error');
  assert.equal(error?.code, 'CODEX_INIT_FAILED');
  assert.match(error?.message || '', /thread\/start 请求超时（70ms）/);
  assert.deepEqual(stages.map((event) => [event.stage, event.outcome]), [
    ['connection', 'completed'],
    ['initialize', 'completed'],
    ['config/read', 'completed'],
    ['thread/start', 'failed'],
  ]);
  assert.equal(stages.at(-1)?.timeoutMs, 70);
  assert.match(stages.at(-1)?.error || '', /thread\/start 请求超时/);
  assert(stages.every((event) => Number.isInteger(event.durationMs) && event.durationMs >= 0));
});

test('turn 尚在握手队列时停止会移除待发送消息', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  let turnStartCount = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize') {
        setTimeout(() => socket.send(JSON.stringify({ id: message.id, result: {} })), 30);
      } else if (message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/start') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-new' } } }));
      } else if (message.method === 'turn/start') {
        turnStartCount += 1;
      }
    });
  });

  const connection = createCodexConnection(() => {}, {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 200,
  });
  t.after(() => connection.close());

  connection.send('不应启动');
  await connection.interrupt();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(turnStartCount, 0);
});
