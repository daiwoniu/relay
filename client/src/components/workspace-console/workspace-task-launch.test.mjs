import assert from 'node:assert/strict';
import test from 'node:test';
import * as taskLaunch from './workspace-task-launch.ts';
import { workbenchActionCompleted } from './workspace-console-view-model.ts';
const { buildWorkspaceTaskDraft, clearWorkspaceTaskLaunch, prepareWorkspaceTaskLaunch, readWorkspaceTaskLaunch } = taskLaunch;

test('task draft uses only an explicitly registered primary item as a positioning hint', () => {
  const task = { id: 'local-task', title: '任务', statusBasis: null, nextAction: null, taskDocumentPath: null,
    feishuWorkItemIds: ['9001000001', '9001000002'], feishuPrimaryWorkItemId: '9001000002' };
  const draft = buildWorkspaceTaskDraft(task);
  assert.match(draft, /台账登记的主飞书工作项：9001000002/);
  assert.match(draft, /请核对实际责任及其他关联项/);
  for (const primary of [undefined, null, 'unknown', '9001000003']) {
    assert.doesNotMatch(buildWorkspaceTaskDraft({ ...task, feishuPrimaryWorkItemId: primary }), /主飞书工作项/);
  }
});

test('flow tracking continues an existing session even when personal work is completed but the whole workflow remains open', () => {
  const item={workItemId:'9001000037',flowFinished:false,stateKey:'doing',isArchivedState:false,myNodes:[{id:'n',phase:'completed'}],mySubtasks:[],currentNodeNames:['生产验收']};
  const entry={kind:'parent',key:'parent:9001000037',item};
  const dashboard={tasks:[],sessions:[{sessionId:'existing',updatedAt:100,feishuWorkItemIds:[item.workItemId]}]};
  assert.equal(workbenchActionCompleted(entry),true);
  const action=taskLaunch.resolveFeishuWorkItemPrimaryAction(item.workItemId,dashboard,workbenchActionCompleted(entry,true));
  assert.deepEqual(action,{kind:'continue',sessionId:'existing'});
  item.flowFinished=true;
  assert.equal(workbenchActionCompleted(entry,true),true);
});

test('association refresh preserves a newer ledger, refresh status and newly registered tasks',()=>{
  const current={tasks:[{id:'same',title:'New title',status:'completed',sessionIds:['old']},{id:'new',sessionIds:['new-session']}],
    sessions:[],unlinkedSessions:[],counts:{tasks:2,sessions:0},errors:['current source issue'],sourceMeta:{state:'live',lastSuccessAt:200}};
  const incoming={tasks:[{id:'same',title:'Old title',status:'active',sessionIds:['linked']}],sessions:[{sessionId:'linked'}],unlinkedSessions:[],
    counts:{tasks:1,sessions:1},errors:[],sourceMeta:{state:'snapshot',lastSuccessAt:100}};
  const merged=taskLaunch.mergeWorkspaceSessionAssociations(current,incoming);
  assert.deepEqual(merged.tasks,[{...current.tasks[0],sessionIds:['linked']},current.tasks[1]]);
  assert.equal(merged.sourceMeta,current.sourceMeta);assert.equal(merged.errors,current.errors);
  assert.deepEqual(merged.counts,{tasks:2,sessions:1});assert.equal(merged.sessions,incoming.sessions);
  assert.equal(taskLaunch.mergeWorkspaceSessionAssociations(null,incoming),incoming);
});

test('Feishu launch retains a durable task reference through draft restoration and first send',()=>{
  const current=storage(),launch=taskLaunch.buildFeishuWorkItemLaunch({workItemId:'9001000015',title:'Source item',url:null,current:'',next:''},'project-one',1000);
  prepareWorkspaceTaskLaunch(current,launch);
  assert.equal(readWorkspaceTaskLaunch(current,'project-one',1001).taskId,'feishu:9001000015');
});

test('Feishu action uses current explicit links, selects the latest session and preserves completed-task restart',()=>{
  const dashboard={tasks:[{feishuWorkItemIds:['9001000015'],sessionIds:['local-linked']}],sessions:[
    {sessionId:'local-linked',updatedAt:1},
    {sessionId:'direct-linked',updatedAt:2,feishuWorkItemIds:['9001000015']},
    {sessionId:'unrelated',updatedAt:3,feishuWorkItemIds:['999']},
  ]};
  assert.deepEqual(taskLaunch.resolveFeishuWorkItemPrimaryAction('9001000015',dashboard),{kind:'continue',sessionId:'direct-linked'});
  assert.deepEqual(taskLaunch.resolveFeishuWorkItemPrimaryAction('9001000015',{...dashboard,sessions:dashboard.sessions.slice(0,1)}),{kind:'continue',sessionId:'local-linked'});
  assert.deepEqual(taskLaunch.resolveFeishuWorkItemPrimaryAction('9001000015',{...dashboard,sessions:[]}),{kind:'start',newTab:true});
  assert.deepEqual(taskLaunch.resolveFeishuWorkItemPrimaryAction('9001000015',dashboard,true),{kind:'restart',newTab:false});
  assert.deepEqual(taskLaunch.resolveFeishuWorkItemPrimaryAction('missing',dashboard),{kind:'start',newTab:true});
});

test('Feishu-only launch draft points to the source without copying report state into a long prompt', () => {
  const text = taskLaunch.buildFeishuWorkItemDraft({
    workItemId: '9001000015', title: '示例数据表', url: 'https://project.feishu.cn/demo-space/story/detail/9001000015',
    current: '实施改造', next: '未完成子任务：完成切换改造',
  });
  assert.match(text, /飞书工作项「示例数据表」/);
  assert.match(text, /9001000015/);
  assert.match(text, /https:\/\/project\.feishu\.cn\/demo-space\/story\/detail\/9001000015/);
  assert.match(text, /先核查飞书工作项/);
  assert.doesNotMatch(text, /实施改造|完成切换改造/);
});

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('a task launch survives retries only for its selected project and 30 minute window', () => {
  const current = storage();
  prepareWorkspaceTaskLaunch(current, { taskId: 'task-a', projectId: 'project-a', title: '任务 A', text: '任务背景', createdAt: 1_000 });
  assert.deepEqual(readWorkspaceTaskLaunch(current, 'project-a', 1_001), { taskId: 'task-a', title: '任务 A', text: '任务背景' });
  assert.equal(readWorkspaceTaskLaunch(current, 'project-b', 1_001), null);
  assert.equal(readWorkspaceTaskLaunch(current, 'project-a', 1_801_000), null);
  clearWorkspaceTaskLaunch(current);
  assert.equal(readWorkspaceTaskLaunch(current, 'project-a', 1_002), null);
});

test('task title is suitable for a fixed session title', () => {
  assert.equal(taskLaunch.workspaceTaskSessionTitle({ id: 'task-a', title: '  修复导入流程  ' }), '修复导入流程');
  assert.equal(taskLaunch.workspaceTaskSessionTitle({ id: 'task-a', title: '  ' }), 'task-a');
  assert.equal(taskLaunch.workspaceTaskSessionTitle({ id: 'task-a', title: '长'.repeat(201) }).length, 200);
});

test('Feishu work item launch has a fixed title without a local task association', () => {
  const current = storage();
  prepareWorkspaceTaskLaunch(current, { projectId: 'project-a', title: '飞书子任务', text: '请核查飞书工作项', createdAt: 1_000 });
  assert.deepEqual(readWorkspaceTaskLaunch(current, 'project-a', 1_001), { taskId: undefined, title: '飞书子任务', text: '请核查飞书工作项' });
});

test('a handoff launch without a fixed title keeps normal session naming', () => {
  const current = storage();
  prepareWorkspaceTaskLaunch(current, { taskId: 'task-a', projectId: 'project-a', text: '接力处理', createdAt: 1_000 });
  assert.deepEqual(readWorkspaceTaskLaunch(current, 'project-a', 1_001), { taskId: 'task-a', title: undefined, text: '接力处理' });
});

test('new conversation draft points to the authoritative ledger without copying stale status text', () => {
  const text = buildWorkspaceTaskDraft({ id: 'task-a', title: '修复任务 A', description: '为客户修复导入流程', statusBasis: '已定位', nextAction: '完成验证', taskDocumentPath: 'D:/tasks/a/README.md' }, '先前会话已改接口');
  assert.match(text, /task-a/);
  assert.match(text, /D:\/tasks\/a\/README.md/);
  assert.match(text, /先前会话已改接口/);
  assert.doesNotMatch(text, /为客户修复导入流程|已定位|完成验证/);
});

test('one primary task action chooses the newest linked session or starts a fresh tab', () => {
  assert.equal(typeof taskLaunch.resolveWorkspaceTaskPrimaryAction, 'function');
  const { resolveWorkspaceTaskPrimaryAction } = taskLaunch;
  const sessions = [{ sessionId: 'older', updatedAt: 10 }, { sessionId: 'newer', updatedAt: 20 }];
  assert.deepEqual(resolveWorkspaceTaskPrimaryAction({ status: 'doing', sessionIds: ['older', 'newer'] }, sessions), { kind: 'continue', sessionId: 'newer' });
  assert.deepEqual(resolveWorkspaceTaskPrimaryAction({ status: 'doing', sessionIds: [] }, sessions), { kind: 'start', newTab: true });
  assert.deepEqual(resolveWorkspaceTaskPrimaryAction({ status: 'done', sessionIds: ['older'] }, sessions), { kind: 'restart', newTab: false });
});
