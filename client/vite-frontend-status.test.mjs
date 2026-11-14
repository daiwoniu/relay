import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendStatusPlugin } from './vite.config.ts';

test('Vite 前端状态端点返回进程启动时间且禁止缓存', () => {
  let middleware;
  const plugin = createFrontendStatusPlugin(1_754_500_000_000);
  plugin.configureServer({
    middlewares: {
      use(handler) { middleware = handler; },
    },
  });

  const headers = new Map();
  let body = '';
  let nextCalled = false;
  const response = {
    statusCode: 0,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    end(value) { body = value; },
  };
  middleware({ method: 'GET', url: '/__relay/frontend-status?now=1' }, response, () => { nextCalled = true; });

  assert.equal(response.statusCode, 200);
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(body), { startedAt: 1_754_500_000_000, mode: 'development', buildId: null, buildLabel: null });
  assert.equal(nextCalled, false);
});

test('Vite 前端状态插件不拦截其他请求', () => {
  let middleware;
  const plugin = createFrontendStatusPlugin(1);
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  let nextCalled = false;
  middleware({ method: 'GET', url: '/' }, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('Vite build 分支不加载或创建访问令牌且开发默认仅监听本机', () => {
  const source = fs.readFileSync(new URL('vite.config.ts', import.meta.url), 'utf8');
  assert.match(source, /const serve = command === 'serve'/);
  assert.match(source, /serve \? loadOrCreateAccessToken/);
  assert.match(source, /RELAY_DEV_LAN === '1' \? '0\.0\.0\.0' : '127\.0\.0\.1'/);
});

test('production build 使用多轮 Terser 压缩真实降低 JavaScript 体积', () => {
  const source = fs.readFileSync(new URL('vite.config.ts', import.meta.url), 'utf8');
  assert.match(source, /minify: 'terser'/);
  assert.match(source, /compress: \{ passes: 3 \}/);
  assert.match(source, /format: \{ comments: false \}/);
});
