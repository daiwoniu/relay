import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const source = fs.readFileSync(new URL('./ProcessSteps.tsx', import.meta.url), 'utf8');
const operationGroupSource = source.match(/function ProcessOperationGroup[\s\S]*?(?=function ProcessSubtaskBlock)/)?.[0] || '';
const executionGroupSource = source.match(/function ProcessExecutionGroup[\s\S]*?(?=function ProcessStepRow)/)?.[0] || '';

test('普通操作组右侧状态与过程回复状态统一使用 11px', () => {
  assert.equal(operationGroupSource.match(/text-\[11px\]/g)?.length, 3);
});

test('执行区段只保留透明逻辑容器并直接渲染内部各组', () => {
  assert.match(executionGroupSource, /data-process-execution-group/);
  assert.match(executionGroupSource, /sections\.map/);
  assert.doesNotMatch(executionGroupSource, /<button/);
  assert.doesNotMatch(executionGroupSource, /useState/);
  assert.doesNotMatch(executionGroupSource, /执行过程/);
});

test('授权、子任务和普通操作仍按区段类型分别渲染', () => {
  assert.match(executionGroupSource, /section\.type === 'interaction'/);
  assert.match(executionGroupSource, /<InteractionPanel/);
  assert.match(executionGroupSource, /section\.type === 'subtask'/);
  assert.match(executionGroupSource, /<ProcessSubtaskBlock/);
  assert.match(executionGroupSource, /<ProcessOperationGroup/);
});
