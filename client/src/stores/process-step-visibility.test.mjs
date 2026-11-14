import assert from 'node:assert/strict';
import test from 'node:test';
import { getReasoningDisplayText, hasVisibleProcessPresentation, hasVisibleProcessStep, getProcessCommand, getProcessText } from './process-step-visibility.ts';

test('列表可见性与流程共用命令提取，优先实际commandAction且安全处理空项', () => {
  assert.equal(getProcessCommand({commandActions:[null,{command:'  cat a.ts  '}],command:'fallback'}),'cat a.ts');
  assert.equal(getProcessCommand({command:'echo ok',content:'ignored'}),'echo ok');
  assert.equal(getProcessCommand({text:'node task.mjs'}),'node task.mjs');
  assert.equal(getProcessText(null),''); assert.equal(getProcessText({a:1}),'{"a":1}');
});

test('只有问题内容而无顶层标题的交互必须可见，空壳仍过滤', () => {
  assert.equal(hasVisibleProcessStep({id:'q',type:'interaction',status:'in_progress',details:{questions:[{title:'选择方案'}]}}),true);
  assert.equal(hasVisibleProcessStep({id:'empty',type:'interaction',status:'in_progress',details:{questions:[]}}),false);
});

test('空壳过程项不结束无内容状态', () => {
  assert.equal(hasVisibleProcessStep({
    id: 'reasoning-1',
    type: 'reasoning',
    status: 'in_progress',
    details: {},
  }), false);
  assert.equal(hasVisibleProcessPresentation('', [{
    id: 'command-1',
    type: 'commandExecution',
    status: 'in_progress',
    details: {},
  }]), false);
});

test('流式阶段即使 reasoning item 已完成也不显示空壳过程', () => {
  const completedReasoning = {
    id: 'reasoning-completed',
    type: 'reasoning',
    status: 'completed',
    details: { content: [], summary: [] },
  };
  assert.equal(hasVisibleProcessStep(completedReasoning), false);
  assert.equal(hasVisibleProcessPresentation('', [completedReasoning]), false);
});

test('整轮结束后没有摘要的 reasoning 仍不展示空壳过程', () => {
  assert.equal(hasVisibleProcessStep({
    id: 'reasoning-completed',
    type: 'reasoning',
    status: 'completed',
    details: { content: [], summary: [] },
  }), false);
  assert.equal(hasVisibleProcessStep({
    id: 'reasoning-incomplete',
    type: 'reasoning',
    status: 'incomplete',
    details: {},
  }), false);
  assert.equal(hasVisibleProcessPresentation('', [{
    id: 'reasoning-completed',
    type: 'reasoning',
    status: 'completed',
    details: {},
  }]), false);
});

test('真实过程文字或可展示步骤结束无内容状态', () => {
  assert.equal(hasVisibleProcessPresentation('正在分析', []), true);
  assert.equal(hasVisibleProcessStep({
    id: 'command-1',
    type: 'commandExecution',
    status: 'in_progress',
    details: { command: 'npm test' },
  }), true);
  assert.equal(hasVisibleProcessStep({
    id: 'reasoning-summary',
    type: 'reasoning',
    status: 'in_progress',
    details: { content: ['正在定位问题'] },
  }), true);
});

test('仅 summary 有内容的 reasoning 仍展示真实摘要', () => {
  const details = { content: [], summary: ['正在核对调用链'] };
  assert.equal(getReasoningDisplayText(details), '正在核对调用链');
  assert.equal(hasVisibleProcessStep({
    id: 'reasoning-summary-only',
    type: 'reasoning',
    status: 'completed',
    details,
  }), true);
  assert.equal(getReasoningDisplayText({
    summary: [{ type: 'summary_text', text: '正在验证边界' }],
  }), '正在验证边界');
});
