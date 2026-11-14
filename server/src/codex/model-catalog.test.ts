import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { listCodexModels } from './model-catalog.js';

test('Codex model/list 完整分页并映射统一目录', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const requests: any[] = [];

  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    requests.push(message);
    if (message.method === 'initialize') {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === 'config/read') {
      socket.send(JSON.stringify({ id: message.id, result: { config: { model_reasoning_effort: 'medium', service_tier: 'fast' } } }));
    } else if (message.method === 'model/list' && !message.params.cursor) {
      socket.send(JSON.stringify({ id: message.id, result: { data: [{
        id: 'gpt-visible', model: 'gpt-visible', displayName: 'GPT Visible', hidden: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'medium', description: 'Balanced' },
        ],
        serviceTiers: [{ id: 'priority', name: 'Priority' }, { id: 'fast', name: 'Fast' }],
        defaultServiceTier: 'default',
        isDefault: true,
      }, {
        id: 'gpt-hidden', displayName: 'Hidden', hidden: true, isDefault: false,
      }], nextCursor: 'page-2' } }));
    } else if (message.method === 'model/list') {
      socket.send(JSON.stringify({ id: message.id, result: { data: [{
        id: 'gpt-image', displayName: 'GPT Image', hidden: false,
        inputModalities: ['text', 'image'], supportedReasoningEfforts: [], isDefault: false,
      }], nextCursor: null } }));
    }
  }));

  const catalog = await listCodexModels({ wsUrl: `ws://127.0.0.1:${address.port}`, now: () => 123 });
  assert.equal(catalog.engineId, 'codex');
  assert.equal(catalog.fetchedAt, 123);
  assert.deepEqual(catalog.models.map((model) => model.id), ['gpt-visible', 'gpt-image']);
  assert.deepEqual(catalog.models[0]?.inputModalities, ['text', 'image']);
  assert.equal(catalog.models[0]?.reasoning.defaultOptionId, 'medium');
  assert.deepEqual(catalog.models[0]?.reasoning.options.map((option) => option.id), ['low', 'medium']);
  assert.deepEqual(catalog.models[0]?.serviceTiers, [{ id: 'priority', label: 'Priority' }, { id: 'fast', label: 'Fast' }]);
  assert.equal(catalog.models[0]?.defaultServiceTier, 'fast');
  assert.equal(catalog.models[1]?.serviceTiers?.length ?? 0, 0);
  assert.equal(catalog.models[1]?.reasoning.supported, false);
  assert.deepEqual(requests.filter((request) => request.method === 'model/list').map((request) => request.params), [
    { limit: 100, includeHidden: false },
    { limit: 100, includeHidden: false, cursor: 'page-2' },
  ]);
  assert(requests.some((request) => request.method === 'config/read'));
});

test('config/read 当前模型覆盖目录 isDefault', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === 'config/read') {
      socket.send(JSON.stringify({ id: message.id, result: { config: { model: 'grok-4.6', model_reasoning_effort: 'medium' } } }));
    } else if (message.method === 'model/list') {
      socket.send(JSON.stringify({ id: message.id, result: { data: [{
        id: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [],
      }, {
        id: 'grok-4.6', displayName: 'Grok 4.6', hidden: false, isDefault: false, supportedReasoningEfforts: [],
      }], nextCursor: null } }));
    }
  }));

  const catalog = await listCodexModels({ wsUrl: `ws://127.0.0.1:${address.port}`, now: () => 123 });
  assert.deepEqual(catalog.models.map((model) => [model.id, model.isDefault]), [['gpt-5.6-sol', false], ['grok-4.6', true]]);
});

test('config/read 模型不在目录中时保留 model/list 默认标记', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');

  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === 'config/read') {
      socket.send(JSON.stringify({ id: message.id, result: { config: { modelInfo: { name: 'missing-model' } } } }));
    } else if (message.method === 'model/list') {
      socket.send(JSON.stringify({ id: message.id, result: { data: [{
        id: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [],
      }, {
        id: 'grok-4.6', displayName: 'Grok 4.6', hidden: false, isDefault: false, supportedReasoningEfforts: [],
      }], nextCursor: null } }));
    }
  }));

  const catalog = await listCodexModels({ wsUrl: `ws://127.0.0.1:${address.port}` });
  assert.deepEqual(catalog.models.map((model) => [model.id, model.isDefault]), [['gpt-5.6-sol', true], ['grok-4.6', false]]);
  assert.equal(catalog.configuredDefaults?.modelId, 'missing-model');
  assert.equal(catalog.configurationRead, true);
});

test('config/read 失败时目录明确标记默认配置未确认', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'Unavailable' } }));
    else if (message.method === 'model/list') socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: 'recommended', isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null } }));
  }));
  const catalog = await listCodexModels({ wsUrl: `ws://127.0.0.1:${address.port}` });
  assert.equal(catalog.configurationRead, false);
});

test('旧版 app-server 不支持 config/read 时回退 config/get 读取本轮默认值', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const methods: string[] = [];
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    methods.push(message.method);
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Method not found' } }));
    else if (message.method === 'config/get') socket.send(JSON.stringify({ id: message.id, result: { config: { model: 'custom-model', model_reasoning_effort: 'high', service_tier: 'fast' } } }));
    else if (message.method === 'model/list') socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: 'custom-model', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'fast', name: 'Fast' }] }], nextCursor: null } }));
  }));
  const catalog = await listCodexModels({ wsUrl: `ws://127.0.0.1:${address.port}` });
  assert.deepEqual(methods, ['initialize', 'config/read', 'config/get', 'model/list']);
  assert.equal(catalog.configurationRead, true);
  assert.deepEqual(catalog.configuredDefaults, { modelId: 'custom-model', reasoningEffort: 'high', serviceTier: 'fast' });
  assert.equal(catalog.models[0]?.isDefault, true);
});
