import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectOpenCodeInstallation } from './installation.js';

test('OpenCode npm 全局布局返回版本、官方来源和真实可执行文件', () => {
  const existing = new Set([
    'C:\\npm\\node_modules\\opencode-ai\\package.json',
    'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',
  ]);
  assert.deepEqual(inspectOpenCodeInstallation({
    platform: 'win32', envPath: 'C:\\npm', exists: (candidate) => existing.has(candidate),
    readFile: () => JSON.stringify({ version: '1.18.31' }),
  }), {
    version: '1.18.31', installSource: 'official_npm_global',
    executable: 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',
  });
});
