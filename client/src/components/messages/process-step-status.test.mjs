import assert from 'node:assert/strict';
import test from 'node:test';
import { getProcessStepStatus, getProcessStepStatusCounts, isPendingProcessInteraction } from './process-step-status.ts';

test('步骤状态互斥归类，明确失败退出码优先于旧运行状态', () => {
  assert.deepEqual(getProcessStepStatusCounts([
    { status: 'in_progress', details: { exitCode: 1 } },
    { status: 'incomplete' },
    { status: 'completed', details: { exitCode: '0' } },
    { status: 'completed', details: { exitCode: 2 } },
  ]), {
    completedCount: 1,
    inProgressCount: 0,
    failedCount: 3,
  });
});

test('完成回执纠正旧运行状态，缺失回执或只有零退出码仍保留运行', () => {
  assert.equal(getProcessStepStatus({type:'commandExecution',status:'in_progress',details:{exitCode:0,completedObservedAt:1000}}),'completed');
  assert.equal(getProcessStepStatus({status:'in_progress',details:{exitCode:0}}),'in_progress');
  assert.equal(getProcessStepStatus({status:'in_progress',details:{completedObservedAt:-1}}),'in_progress');
  assert.equal(getProcessStepStatus({status:'in_progress',details:{completedObservedAt:Infinity}}),'in_progress');
  assert.equal(getProcessStepStatus({status:'in_progress',details:{completedObservedAt:1000,errorCode:'FAILED'}}),'incomplete');
  assert.equal(getProcessStepStatus({type:'interaction',status:'in_progress',details:{completedObservedAt:1000}}),'in_progress');
});

test('待处理交互判断排除已授权、拒绝和已回答记录，不因完成时间自动解除', () => {
  const pending={type:'interaction',status:'in_progress',details:{completedObservedAt:1000}};
  assert.equal(isPendingProcessInteraction(pending),true);
  for (const resolvedAction of ['accept','decline','resolved_elsewhere']) {
    assert.equal(isPendingProcessInteraction({...pending,details:{...pending.details,resolvedAction}}),false);
    assert.equal(getProcessStepStatus({...pending,details:{...pending.details,resolvedAction}}),'completed');
  }
  assert.equal(isPendingProcessInteraction(pending,true),false);
  assert.equal(isPendingProcessInteraction({...pending,status:'completed'}),false);
  assert.equal(isPendingProcessInteraction({...pending,type:'commandExecution'}),false);
});
