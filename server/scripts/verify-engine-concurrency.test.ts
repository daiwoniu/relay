import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertIsolatedConcurrencyPaths, runEngineConcurrencyVerification } from './verify-engine-concurrency.js';

test('拒绝把正式项目或临时目录之外的数据库用于并发验收', () => {
  const tempRoot = path.join(os.tmpdir(), 'relay-engine-concurrency-guard');
  assert.doesNotThrow(() => assertIsolatedConcurrencyPaths({
    tempRoot,
    dbPath: path.join(tempRoot, 'relay.db'),
    projectRoot: path.resolve('D:/relay'),
  }));
  assert.throws(() => assertIsolatedConcurrencyPaths({
    tempRoot,
    dbPath: path.resolve('D:/relay'),
    projectRoot: path.resolve('D:/relay'),
  }));
});

test('隔离环境完成 FIFO、资源隔离、冷却、probe 与重启验收', { timeout: 30_000 }, async () => {
  const result = await runEngineConcurrencyVerification();
  assert.equal(result.ok, true);
  assert.deepEqual(result.defaults, { codex: 2, codebuddy: 4 });
  assert.equal(Object.values(result.scenarios).every(Boolean), true);
});
