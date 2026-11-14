import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCodexEndpoint } from './endpoint.js';

test('启动器注入 Codex 地址时直接使用并可派生 readyz', () => {
  assert.deepEqual(resolveCodexEndpoint({
    env: { CODEX_WS_URL: 'ws://127.0.0.1:12345' },
  }), {
    wsUrl: 'ws://127.0.0.1:12345',
    readyUrl: 'http://127.0.0.1:12345/readyz',
  });
});

test('后端独立启动时读取仓库统一配置', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-endpoint-'));
  try {
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config', 'relay.conf'), [
      'CODEX_HOST=127.0.0.1',
      'CODEX_PORT=9281',
      'BACKEND_LISTEN_HOST=0.0.0.0',
      'BACKEND_LISTEN_PORT=9181',
      'FRONTEND_LISTEN_HOST=0.0.0.0',
      'FRONTEND_LISTEN_PORT=9081',
      'PUBLIC_ALLOWED_ADDRESSES=',
    ].join('\n'));
    assert.deepEqual(resolveCodexEndpoint({ root, env: {} }), {
      wsUrl: 'ws://127.0.0.1:9281',
      readyUrl: 'http://127.0.0.1:9281/readyz',
    });
    fs.mkdirSync(path.join(root, '.relay-dev'));
    fs.writeFileSync(path.join(root, '.relay-dev', 'codex-runtime-endpoint.json'), JSON.stringify({
      version: 1, configured: '127.0.0.1:9281', port: 9284,
    }));
    assert.deepEqual(resolveCodexEndpoint({ root, env: {} }), {
      wsUrl: 'ws://127.0.0.1:9284', readyUrl: 'http://127.0.0.1:9284/readyz',
    });
    assert.equal(resolveCodexEndpoint({ root, env: { CODEX_WS_URL: 'ws://127.0.0.1:9381' } }).wsUrl, 'ws://127.0.0.1:9381');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('孤立的 readyz 环境变量会被拒绝', () => {
  assert.throws(
    () => resolveCodexEndpoint({ env: { CODEX_READY_URL: 'http://127.0.0.1:9181/readyz' } }),
    /必须同时配置 CODEX_WS_URL/,
  );
});
