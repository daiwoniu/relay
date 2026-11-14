import assert from 'node:assert/strict';
import test from 'node:test';
import { modelDetailRows } from './message-model-info-presentation.ts';

const modelInfo = {
  engineId: 'codex', effective: { id: 'gpt-test', displayName: 'GPT Test', reasoningEffort: 'high' },
  serviceTier: 'priority', rerouted: false,
};

test('本轮详情分别展示模型、推理强度和所选速度', () => {
  assert.deepEqual(modelDetailRows(modelInfo), [
    { label: '模型', value: 'GPT Test' },
    { label: '推理强度', value: '高' },
    { label: '速度', value: '快速' },
  ]);
  assert.deepEqual(modelDetailRows({ ...modelInfo, serviceTier: 'default' })[2], { label: '速度', value: '标准' });
  assert.deepEqual(modelDetailRows({ ...modelInfo, serviceTier: null, resolvedServiceTier: 'fast' })[2], { label: '速度', value: '快速' });
  assert.deepEqual(modelDetailRows({ ...modelInfo, serviceTier: null, resolvedServiceTier: 'default' })[2], { label: '速度', value: '标准' });
  assert.deepEqual(modelDetailRows({ ...modelInfo, serviceTier: null })[2], { label: '速度', value: '未记录' });
  assert.deepEqual(modelDetailRows({ ...modelInfo, serviceTier: null, resolvedServiceTier: null })[2], { label: '速度', value: '未提供' });
});

test('历史消息和不提供速度的引擎不伪造速度或推理强度', () => {
  const { serviceTier: _serviceTier, ...oldInfo } = modelInfo;
  assert.deepEqual(modelDetailRows(oldInfo)[2], { label: '速度', value: '未记录' });
  assert.deepEqual(modelDetailRows({ ...oldInfo, engineId: 'codebuddy', effective: { id: 'other', displayName: 'Other' } }), [
    { label: '模型', value: 'Other' },
    { label: '推理强度', value: '未提供' },
    { label: '速度', value: '未提供' },
  ]);
});
