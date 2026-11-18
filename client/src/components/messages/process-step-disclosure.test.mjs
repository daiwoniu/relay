import assert from 'node:assert/strict';
import test from 'node:test';
import { getProcessStepDisclosureState } from './process-step-disclosure.ts';

test('无详情活动可明确禁用展开，不影响其他操作的完整标题', () => {
  assert.equal(getProcessStepDisclosureState({ title: 'food_sample', expandable: false }).canExpand, false);
});

test('只有标题的操作也可以展开查看完整内容', () => {
  assert.deepEqual(getProcessStepDisclosureState({
    title: '已整理较早的会话上下文…',
    fullTitle: '已整理较早的会话上下文，并保留后续处理所需的关键决策和执行结果',
  }), {
    canExpand: true,
    fullTitle: '已整理较早的会话上下文，并保留后续处理所需的关键决策和执行结果',
    hasSupplementalDetails: false,
  });
});

test('没有单独完整标题时使用当前标题作为展开内容', () => {
  assert.deepEqual(getProcessStepDisclosureState({
    title: '3 个步骤',
  }), {
    canExpand: true,
    fullTitle: '3 个步骤',
    hasSupplementalDetails: false,
  });
});

test('保留命令、元数据和输出等原有详情', () => {
  assert.deepEqual(getProcessStepDisclosureState({
    title: '执行命令',
    command: 'npm run test',
    metadata: ['目录：G:\\AI\\relay'],
    output: '3 行输出',
  }), {
    canExpand: true,
    fullTitle: '执行命令',
    hasSupplementalDetails: true,
  });
});
