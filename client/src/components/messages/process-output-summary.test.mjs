import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStoredOutputSummary } from './process-output-summary.ts';

test('结构化输出摘要展示总量和首尾行', () => {
  assert.equal(formatStoredOutputSummary({
    lineCount: 20,
    charCount: 1_024,
    firstLine: '第一行',
    lastLine: '最后一行',
    truncated: true,
    source: 'aggregatedOutput',
  }), '20 行输出 · 1024 字符\n首行：第一行\n末行：最后一行');
});

test('单行摘要不重复展示首尾且拒绝损坏结构', () => {
  assert.equal(formatStoredOutputSummary({
    lineCount: 1, charCount: 2, firstLine: '完成', lastLine: '完成', truncated: false,
  }), '1 行输出 · 2 字符 · 完成');
  assert.equal(formatStoredOutputSummary({ lineCount: -1, firstLine: 'x' }), undefined);
});
