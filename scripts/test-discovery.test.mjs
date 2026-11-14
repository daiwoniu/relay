import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { discoverScriptTests } from './lib/test-discovery.mjs';

test('根脚本测试递归发现 acceptance 测试', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const tests = discoverScriptTests(root).map((value) => value.replaceAll('\\', '/'));
  assert.ok(tests.includes('scripts/acceptance/auth-session.test.mjs'));
  assert.ok(tests.includes('scripts/acceptance/process-control.test.mjs'));
  assert.ok(tests.includes('ai/scripts/validate-ai-docs.test.mjs'));
});
