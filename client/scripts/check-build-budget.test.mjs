import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BUILD_BUDGET, evaluateBuildBudget } from './check-build-budget.mjs';

const budget = {
  maxChunkBytes: 500,
  maxTotalBytes: 1300,
  maxGzipTotalBytes: 400,
  maxOfflineScriptBytes: 4,
};

test('默认预算按单 chunk、应用原始总量、gzip 总量和离线脚本分层', () => {
  assert.deepEqual(DEFAULT_BUILD_BUDGET, {
    maxChunkBytes: 500 * 1024,
    maxTotalBytes: 1.74 * 1024 * 1024,
    maxGzipTotalBytes: 544 * 1024,
    maxOfflineScriptBytes: 4 * 1024,
  });
});

test('所有 chunk 与总量在预算内时通过', () => {
  const result = evaluateBuildBudget([
    { name: 'a.js', bytes: 400, gzipBytes: 120 },
    { name: 'b.js', bytes: 300, gzipBytes: 90 },
  ], 3, budget);
  assert.equal(result.ok, true);
  assert.equal(result.totalBytes, 700);
  assert.equal(result.gzipTotalBytes, 210);
  assert.equal(result.offlineScriptBytes, 3);
});

test('单个 chunk 超限时失败并返回超限文件', () => {
  const result = evaluateBuildBudget([{ name: 'large.js', bytes: 501, gzipBytes: 100 }], 3, budget);
  assert.equal(result.ok, false);
  assert.deepEqual(result.oversizedChunks.map((chunk) => chunk.name), ['large.js']);
});

test('所有 chunk 单独合格但总量超限时失败', () => {
  const result = evaluateBuildBudget([
    { name: 'a.js', bytes: 500, gzipBytes: 100 },
    { name: 'b.js', bytes: 500, gzipBytes: 100 },
    { name: 'c.js', bytes: 301, gzipBytes: 100 },
  ], 3, budget);
  assert.equal(result.ok, false);
  assert.equal(result.totalExceeded, true);
});

test('gzip 总量超限时独立失败', () => {
  const result = evaluateBuildBudget([
    { name: 'a.js', bytes: 400, gzipBytes: 201 },
    { name: 'b.js', bytes: 400, gzipBytes: 200 },
  ], 3, budget);
  assert.equal(result.ok, false);
  assert.equal(result.gzipTotalExceeded, true);
  assert.equal(result.totalExceeded, false);
});

test('离线脚本超限时独立失败', () => {
  const result = evaluateBuildBudget([{ name: 'a.js', bytes: 400, gzipBytes: 100 }], 5, budget);
  assert.equal(result.ok, false);
  assert.equal(result.offlineScriptExceeded, true);
});

test('恰好等于各项预算时通过', () => {
  const result = evaluateBuildBudget([{ name: 'a.js', bytes: 500, gzipBytes: 400 }], 4, budget);
  assert.equal(result.ok, true);
});
