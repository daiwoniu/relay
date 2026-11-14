import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadFrontendGatewayToken } from './frontend-gateway-token.js';

test('正式网关只读取已有令牌且缺失时失败', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gateway-token-'));
  const tokenFile = path.join(directory, 'access-token');
  try {
    assert.equal(loadFrontendGatewayToken({ configuredToken: ' configured ' }), 'configured');
    assert.throws(() => loadFrontendGatewayToken(), /缺少内部访问令牌/);
    assert.throws(() => loadFrontendGatewayToken({ tokenFile }), /不存在/);
    fs.writeFileSync(tokenFile, ' file-token \n');
    assert.equal(loadFrontendGatewayToken({ tokenFile }), 'file-token');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
