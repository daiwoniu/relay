import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFeishuExecutionLine } from './feishu-execution-details.ts';

test('keeps session compaction zero and a model label containing the separator', () => {
  assert.deepEqual(readFeishuExecutionLine('引擎：Codex · 模型：GPT · 测试版 · 强度：3/4 · 速度：常规 · 压缩次数：0'), {
    engine: 'Codex', model: 'GPT · 测试版', effort: '3/4', speed: '常规', compactions: '0',
  });
});

test('shows only applicable summary fields and leaves unrecognized history to the fallback', () => {
  assert.deepEqual(readFeishuExecutionLine('引擎：OpenAI API · 模型：gpt-5-mini · 强度：未提供 · 速度：未提供 · 压缩次数：不适用'), {
    engine: 'OpenAI API', model: 'gpt-5-mini', effort: null, speed: null, compactions: null,
  });
  assert.equal(readFeishuExecutionLine('旧版保留的执行信息'), null);
  assert.equal(readFeishuExecutionLine(), null);
});
