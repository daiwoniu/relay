import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverScriptTests } from './lib/test-discovery.mjs';

test('根脚本测试递归发现 acceptance 测试', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const tests = discoverScriptTests(root).map((value) => value.replaceAll('\\', '/'));
  assert.ok(tests.includes('scripts/acceptance/auth-session.test.mjs'));
  assert.ok(tests.includes('scripts/acceptance/process-control.test.mjs'));
});

test('测试发现兼容不含 ai 目录的公库，并递归包含存在的 AI 测试', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-discovery-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/product.test.mjs'), '');
    assert.deepEqual(discoverScriptTests(root), [path.join('scripts', 'product.test.mjs')]);
    fs.mkdirSync(path.join(root, 'ai/scripts/nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ai/scripts/nested/policy.test.mjs'), '');
    assert.ok(discoverScriptTests(root).includes(path.join('ai', 'scripts', 'nested', 'policy.test.mjs')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
