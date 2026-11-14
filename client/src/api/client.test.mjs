import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, AUTH_REQUIRED_EVENT, parseApiErrorDto, parseApiResponse, requestJson } from './client.ts';

test('写操作自动携带操作标识并保留原请求头和显式重试标识', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init.headers));
    return Response.json({ ok: true });
  };
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await requestJson('/api/resource', { method, headers: { 'content-type': 'application/json' } });
      assert.match(seen.at(-1).get('x-relay-operation-id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.equal(seen.at(-1).get('content-type'), 'application/json');
    }
    assert.equal(new Set(seen.map(h => h.get('x-relay-operation-id'))).size, 4);
    const key = '33333333-3333-4333-8333-333333333333';
    const options = { method: 'DELETE', headers: [['X-Relay-Operation-Id', key]] };
    await requestJson('/api/resource', options);
    await requestJson('/api/resource', options);
    assert.equal(seen.at(-1).get('x-relay-operation-id'), key);
    assert.equal(seen.at(-2).get('x-relay-operation-id'), key);
    await requestJson(new Request('http://localhost/api/resource', { method: 'DELETE', headers: { 'x-relay-operation-id': key } }));
    assert.equal(seen.at(-1).get('x-relay-operation-id'), key);
    await requestJson('/api/resource');
    assert.equal(seen.at(-1).has('x-relay-operation-id'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('统一 API 响应解析成功 JSON', async () => {
  const result = await parseApiResponse(new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  assert.deepEqual(result, { ok: true });
});

test('统一 API 响应拒绝损坏的成功响应', async () => {
  await assert.rejects(
    () => parseApiResponse(new Response('broken', { status: 200 })),
    (error) => error instanceof ApiError && error.status === 200 && error.message === '服务端返回了无效数据',
  );
});

test('统一 API 响应保留服务端错误状态和内容', async () => {
  await assert.rejects(
    () => parseApiResponse(new Response(JSON.stringify({ error: '会话不存在', code: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })),
    (error) => error instanceof ApiError
      && error.status === 404
      && error.message === '会话不存在'
      && error.data?.code === 'NOT_FOUND',
  );
});

test('统一 API 错误保留 Retry-After 剩余等待秒数', async () => {
  await assert.rejects(
    () => parseApiResponse(new Response(JSON.stringify({ error: '操作过于频繁', code: 'RATE_LIMITED' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '37' },
    })),
    (error) => error instanceof ApiError && error.retryAfterSeconds === 37,
  );
});

test('错误响应只保留 ApiErrorDto 白名单字段并安全降级', () => {
  assert.deepEqual(parseApiErrorDto({
    error: '禁止访问', code: 'FORBIDDEN', canForceAccess: true, stack: '不得保留',
  }), { error: '禁止访问', code: 'FORBIDDEN', canForceAccess: true });
  assert.deepEqual(parseApiErrorDto({
    error: '项目已在回收站', code: 'PROJECT_IN_TRASH',
    projectInTrash: { id: '11111111-1111-4111-8111-111111111111', name: '旧项目', sessionCount: 2, path: '不得保留' },
  }), {
    error: '项目已在回收站', code: 'PROJECT_IN_TRASH',
    projectInTrash: { id: '11111111-1111-4111-8111-111111111111', name: '旧项目', sessionCount: 2 },
  });
  assert.equal(parseApiErrorDto({}), null);
  assert.equal(parseApiErrorDto({ error: '   ' }), null);
  assert.equal(parseApiErrorDto('html'), null);
});

test('无效错误体不伪装成有效 ApiErrorDto', async () => {
  await assert.rejects(
    () => parseApiResponse(new Response('{}', { status: 500 })),
    (error) => error instanceof ApiError && error.data === null && error.message === '请求失败（500）',
  );
});

test('401 默认通知认证失效，登录请求可以关闭通知', async () => {
  const events = [];
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  try {
    await assert.rejects(() => parseApiResponse(new Response('{}', { status: 401 })));
    assert.deepEqual(events, [AUTH_REQUIRED_EVENT]);
    await assert.rejects(() => parseApiResponse(new Response('{}', { status: 401 }), { notifyUnauthorized: false }));
    assert.deepEqual(events, [AUTH_REQUIRED_EVENT]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('统一 API 请求超时后返回可重试错误', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  try {
    await assert.rejects(
      () => requestJson('/slow', { timeoutMs: 5 }),
      (error) => error instanceof ApiError && error.status === 0 && error.message === '请求超时，请重试',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('统一 API 请求保留调用方主动取消', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const controller = new AbortController();
  try {
    const request = requestJson('/cancelled', { signal: controller.signal, timeoutMs: 100 });
    controller.abort();
    await assert.rejects(request, (error) => error?.name === 'AbortError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('统一 API 请求正常完成后清理超时计时器', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    assert.deepEqual(await requestJson('/ok', { timeoutMs: 5 }), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
