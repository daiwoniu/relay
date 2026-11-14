import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getProcessPlan, getProcessPlanTitle, isStructuredPlan } from './process-plan.ts';
import { upsertProcessStep } from '../../stores/process-steps.ts';
import { buildProcessTimelineSections } from './process-timeline.ts';

const snapshot = (plan) => ({ id: 'plan:turn', type: 'plan', status: 'completed', details: { plan } });
test('计划更新与调整替换原清单，步骤数量不冒充过程记录数', () => {
  const first = snapshot([{ step: '分析', status: 'completed' }]);
  const second = snapshot([{ step: '修改', status: 'inProgress' }, { step: '验证', status: 'pending' }]);
  const steps = upsertProcessStep([first], [], second).processSteps;
  assert.equal(steps.length, 1);
  assert.deepEqual(getProcessPlan(steps), {
    id: 'plan:turn', entries: second.details.plan, completed: 0,
    active: second.details.plan[0], explanation: null,
  });
  assert.deepEqual(buildProcessTimelineSections([{ type: 'operation', itemId: first.id }], steps.filter((s) => !isStructuredPlan(s))), []);
});

test('计划标题只使用原生步骤状态，不推断耗时或失败状态', () => {
  const running = getProcessPlan([snapshot([
    { step: '读取', status: 'completed' },
    { step: '验证修改', status: 'inProgress' },
    { step: '交付', status: 'pending' },
  ])]);
  assert.ok(running);
  assert.equal(getProcessPlanTitle(running, true), '正在执行');
  assert.equal(getProcessPlanTitle(running, false), '执行结束');

  const completed = getProcessPlan([snapshot([{ step: '完成', status: 'completed' }])]);
  assert.ok(completed);
  assert.equal(getProcessPlanTitle(completed, false), '计划完成');
  assert.equal(getProcessPlanTitle(completed, true), '计划完成');
});

test('计划保留非空原生说明', () => {
  const plan = getProcessPlan([{
    ...snapshot([{ step: '检查', status: 'pending' }]),
    details: { plan: [{ step: '检查', status: 'pending' }], explanation: '  根据检查结果调整  ' },
  }]);
  assert.equal(plan?.explanation, '根据检查结果调整');
});

test('后续空说明快照会清除旧计划说明', () => {
  const first = snapshot([{ step: '检查', status: 'inProgress' }]);
  first.details.explanation = '根据初步检查调整';
  const cleared = snapshot([{ step: '检查', status: 'completed' }]);
  cleared.details.explanation = '';
  const steps = upsertProcessStep([first], [], cleared).processSteps;
  assert.equal(getProcessPlan(steps)?.explanation, null);
});

test('空清单移除展示，普通 Plan Mode 文本不转成进度清单', () => {
  assert.equal(getProcessPlan([snapshot([])]), null);
  assert.equal(getProcessPlan([{ id: 'text', type: 'plan', details: { text: '方案正文' } }]), null);
  assert.equal(getProcessPlan([snapshot([null, { step: '错误', status: 'invalid' }])]), null);
});

test('计划位于三种过程视图之后，流程上下文可固定计划但不折叠清单', () => {
  const component = fs.readFileSync(new URL('./ProcessPlan.tsx', import.meta.url), 'utf8');
  const processSteps = fs.readFileSync(new URL('./ProcessSteps.tsx', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('../../styles/message-ui.css', import.meta.url), 'utf8');
  const flowStyles = fs.readFileSync(new URL('../../styles/process-flow.css', import.meta.url), 'utf8');
  const planRenderIndex = processSteps.indexOf('{plan && <div className={flowContext');
  const executionRenderIndex = processSteps.indexOf('{timelineSections ? timelineSections.map');

  assert.ok(executionRenderIndex >= 0);
  assert.ok(planRenderIndex > executionRenderIndex);
  assert.ok(planRenderIndex > processSteps.indexOf('</ErrorBoundary> : ordinaryContent}'));
  assert.match(processSteps, /className=\{flowContext \? 'process-plan-dock' : undefined\}/);
  assert.match(flowStyles, /\.process-plan-dock\s*\{[^}]*position:\s*sticky/);
  assert.doesNotMatch(processSteps, /const hasInProgress/);
  assert.match(component, /plan\.entries\.map/);
  assert.match(component, /role="progressbar"/);
  assert.match(component, /getProcessPlanTitle\(plan, running\)/);
  assert.doesNotMatch(component, /process-plan__explanation/);
  assert.match(component, /process-plan--running/);
  assert.doesNotMatch(component, /collapsed|expanded|查看全部/);
  assert.match(styles, /\.process-plan__progress > span[\s\S]*transition: width 180ms ease/);
  assert.match(styles, /\.process-plan--running \.process-plan__progress::after[\s\S]*animation: process-plan-progress-sweep/);
  assert.match(styles, /\.process-plan__step--active \.process-plan__icon[\s\S]*animation: process-plan-icon-breathe/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.process-plan__progress > span[\s\S]*transition: none/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.process-plan--running \.process-plan__progress::after,[\s\S]*animation: none/);
  assert.doesNotMatch(styles, /\.process-plan[^,{]*\{[^}]*position:\s*sticky/);
});
