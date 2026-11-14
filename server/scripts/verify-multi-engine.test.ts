import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertIsolatedVerificationPaths, runMultiEngineVerification } from './verify-multi-engine.js';

test('拒绝把正式项目或临时根目录之外的路径用于多引擎验收', () => {
  const tempRoot = path.join(os.tmpdir(), 'relay-multi-engine-guard');
  assert.doesNotThrow(() => assertIsolatedVerificationPaths({
    tempRoot,
    dbPath: path.join(tempRoot, 'data', 'relay.db'),
    workspacePath: path.join(tempRoot, 'workspace'),
    projectRoot: path.resolve('D:/relay'),
  }));
  assert.throws(() => assertIsolatedVerificationPaths({
    tempRoot,
    dbPath: path.resolve('D:/relay'),
    workspacePath: path.join(tempRoot, 'workspace'),
    projectRoot: path.resolve('D:/relay'),
  }));
});

test('隔离环境完成 Codex 与 CodeBuddy 共存、降级、分享和重启验收', { timeout: 90_000 }, async () => {
  const result = await runMultiEngineVerification();
  assert.equal(result.ok, true);
  assert.deepEqual(result.engines, ['codex', 'codebuddy']);
  assert.equal(result.concurrentCompletion, true);
  assert.equal(result.perTurnModelSnapshots, true);
  assert.equal(result.offlineShareReadable, true);
  assert.equal(result.restartInterruptedCodeBuddy, true);
});
