import assert from 'node:assert/strict';
import test from 'node:test';
import * as taskDetail from './workspace-task-detail.ts';
import { buildWorkspaceConsoleView, isPersonalProjectComplete, projectItemsForTask, projectTaskCardDetails } from './workspace-console-view-model.ts';

const dashboard = (tasks) => ({ sourceAvailable: { registry: true }, tasks, runs: [] });
const report = (items) => ({ stale: false, error: null, items, localAssociated: [] });
const item = (workItemId, localTaskIds = []) => ({ workItemId, localTaskIds, actionability: 'current' });

test('internal navigation keeps the displayed dashboard and responsibility rather than rebuilding from the main list',()=>{
 const shown=dashboard([{id:'new-local'}]),shownReport=report([item('new-project')]);
 const parent=taskDetail.detailSnapshotForSelection({kind:'group',id:'11'},shown,shownReport);
 const next=taskDetail.detailSnapshotForSelection({kind:'project',id:'new-project'},parent.dashboard,parent.responsibility);
 assert.equal(next.dashboard,shown);assert.equal(next.responsibility,shownReport);assert.equal(next.taskId,null);
 assert.equal(taskDetail.detailSnapshotForSelection({kind:'local',id:'new-local'},next.dashboard,next.responsibility).taskId,'new-local');
});

test('local ledger notices distinguish no association, registered but missing, partial matching and source failure',()=>{
 assert.match(taskDetail.localLedgerNotice([],[],true),/未关联/);
 assert.match(taskDetail.localLedgerNotice(['a','a'],[],true),/已登记但未匹配.*1 份/);
 assert.match(taskDetail.localLedgerNotice(['a','b'],[{id:'a'}],true),/已登记但未匹配.*1 份/);
 assert.equal(taskDetail.localLedgerNotice(['a'],[{id:'a'}],true),null);
 assert.match(taskDetail.localLedgerNotice(['a'],[],false),/来源不可用/);
});

test('session association refresh reads the local task without requesting Feishu', async () => {
  const snapshot = await taskDetail.loadTaskDetailSnapshot('a', async () => dashboard([{ id: 'a', title: '已关联会话' }]));
  assert.equal(snapshot.dashboard.tasks[0].title, '已关联会话');
  await assert.rejects(taskDetail.loadTaskDetailSnapshot('a', async () => dashboard([{ id: 'b' }])), /当前任务/);
});

test('local detail refresh reads only local data and retains the existing Feishu snapshot', async () => {
  const task = { id: 'a', title: '新台账标题', status: 'doing', feishuWorkItemIds: [] };
  const cached = report([item('711', ['other'])]);
  const detail = await taskDetail.loadWorkbenchDetailSnapshot(
    { kind: 'local', id: 'a' },
    async () => dashboard([task]),
    async () => assert.fail('local refresh must not request Feishu'),
    cached,
  );
  assert.equal(detail.responsibility, cached);
  assert.equal(detail.taskId, 'a');
  assert.equal(detail.dashboard.tasks[0].title, '新台账标题');
  assert.deepEqual(projectItemsForTask(detail.dashboard.tasks[0], detail.responsibility), []);
});

test('refreshing a linked local detail refreshes its Feishu source and rejects stale results',async()=>{
 const task={id:'a',feishuWorkItemIds:['711']};
 const fresh=report([item('711',['a'])]);
 const snapshot=await taskDetail.loadWorkbenchDetailSnapshot({kind:'local',id:'a'},async()=>dashboard([task]),async(force)=>{assert.equal(force,true);return fresh;});
 assert.equal(snapshot.responsibility,fresh);
 await assert.rejects(taskDetail.loadWorkbenchDetailSnapshot({kind:'local',id:'a'},async()=>dashboard([task]),async()=>({...fresh,stale:true})),/保留上次详情/);
});

test('Feishu detail refresh retains the selected project and all newly associated local tasks', async () => {
  const detail = await taskDetail.loadWorkbenchDetailSnapshot(
    { kind: 'project', id: '711' },
    async () => dashboard([{ id: 'a', status: 'doing', feishuWorkItemIds: [] }, { id: 'b', status: 'done', feishuWorkItemIds: [] }]),
    async (force) => { assert.equal(force, true); return report([item('711', ['a', 'b'])]); },
  );
  assert.equal(detail.taskId, null);
  assert.equal(detail.selection.kind, 'project');
  assert.deepEqual(detail.dashboard.tasks.map((task) => task.id), ['a', 'b']);
});

test('Feishu-only detail stays a Feishu detail when no local task is linked', async () => {
  const detail = await taskDetail.loadWorkbenchDetailSnapshot(
    { kind: 'project', id: '711' },
    async () => dashboard([]),
    async () => report([item('711')]),
  );
  assert.equal(detail.taskId, null);
});

test('a completed local ledger does not complete its refreshed native defect', async () => {
  const defect={...item('9001000038',['inquiry-ledger']),typeName:'缺陷',statusName:'已修复，待验收',actionability:'state_responsibility',
    nativeCompleted:false,currentNodes:[],personalSubtasks:[],linkedStoryIds:['9001000013'],myRoleKeys:['operator'],baseOwnerIsMe:false};
  const local={id:'inquiry-ledger',status:'done',feishuWorkItemIds:[defect.workItemId]};
  const snapshot=await taskDetail.loadWorkbenchDetailSnapshot({kind:'project',id:defect.workItemId},
    async()=>dashboard([local]),async()=>report([defect]));
  assert.equal(snapshot.taskId,null);
  const projected=buildWorkspaceConsoleView(snapshot.dashboard,snapshot.responsibility).responsibility.stateResponsibility[0];
  assert.equal(isPersonalProjectComplete(projected),false);
  assert.deepEqual(projectTaskCardDetails(projected),{current:'负责流程流转，当前不一定需要操作',next:'飞书报表未提供明确下一步'});
  assert.deepEqual(projected.tasks.map((task)=>task.id),[local.id]);
});

test('subtask detail refresh keeps the Feishu card independent of an exact local task', async () => {
  const source = { ...report([]), sourceUserKey: 'u', workbenchItems: [{
    workItemId: '11', ownerUserKey: 'other', mySubtasks: [{ id: '22', passed: false }],
  }] };
  const detail = await taskDetail.loadWorkbenchDetailSnapshot(
    { kind: 'subtask', id: '11:22' },
    async () => dashboard([{ id: 'local', feishuWorkItemIds: ['22'] }]),
    async () => source,
  );
  assert.equal(detail.taskId, null);
  assert.equal(detail.responsibility.workbenchItems[0].mySubtasks[0].id, '22');
  await assert.rejects(taskDetail.loadWorkbenchDetailSnapshot(
    { kind: 'subtask', id: '11:23' }, async () => dashboard([]), async () => source,
  ), /当前子任务/);
});

test('role-only parent detail refresh retains the verified item', async () => {
  const source = { ...report([]), sourceUserKey: 'u', workbenchItems: [{
    workItemId: '9001000037', ownerUserKey: 'creator', roleOwnerUserKeys: ['u'], mySubtasks: [],
  }] };
  const detail = await taskDetail.loadWorkbenchDetailSnapshot(
    { kind: 'parent', id: '9001000037' }, async () => dashboard([]), async () => source,
  );
  assert.equal(detail.taskId, null);
  assert.equal(detail.responsibility.workbenchItems[0].ownerUserKey, 'creator');
  await assert.rejects(taskDetail.loadWorkbenchDetailSnapshot(
    { kind: 'parent', id: '9001000037' }, async () => dashboard([]),
    async () => ({ ...source, workbenchItems: [{ ...source.workbenchItems[0], roleOwnerUserKeys: ['other'] }] }),
  ), /当前父工作项/);
});

test('group detail refresh retains every own child when the parent belongs to someone else', async () => {
  const source = { ...report([]), sourceUserKey: 'u', workbenchItems: [{
    workItemId: '11', ownerUserKey: 'other', mySubtasks: [{ id: '22', passed: true }, { id: '23', passed: false }],
  }] };
  const detail = await taskDetail.loadWorkbenchDetailSnapshot(
    { kind: 'group', id: '11' },
    async () => dashboard([{ id: 'parent-ledger', feishuWorkItemIds: ['11'] }, { id: 'child-ledger', feishuWorkItemIds: ['23'] }]),
    async () => source,
  );
  assert.deepEqual(detail.responsibility.workbenchItems[0].mySubtasks.map((child) => child.id), ['22', '23']);
  assert.equal(detail.taskId, null);
});

test('detail refresh rejects incomplete sources and missing selected records', async () => {
  const native=await taskDetail.loadWorkbenchDetailSnapshot({ kind: 'project', id: '711' }, async () => ({ sourceAvailable: { registry: false }, tasks: [] }), async () => report([item('711')]));
  assert.equal(native.dashboard.sourceAvailable.registry,false);
  assert.equal(native.responsibility.items[0].workItemId,'711');
  assert.equal((await taskDetail.loadWorkbenchDetailSnapshot({ kind: 'local', id: 'a' }, async () => dashboard([{ id: 'a' }]), async () => assert.fail('must not read'))).responsibility, null);
  await assert.rejects(taskDetail.loadWorkbenchDetailSnapshot({ kind: 'local', id: 'a' }, async () => dashboard([{ id: 'b' }]), async () => report([])), /当前任务/);
  await assert.rejects(taskDetail.loadWorkbenchDetailSnapshot({ kind: 'project', id: '711' }, async () => dashboard([]), async () => report([item('712')])), /当前工作项/);
});

test('a Run opened from refreshed task details comes from that task snapshot', () => {
  const detail = { taskId: 'a', dashboard: { runs: [{ runId: 'new', taskId: 'a' }] } };
  assert.deepEqual(taskDetail.runForTaskDetail({ runId: 'new', taskId: 'a',snapshot:detail.dashboard }), { runId: 'new', taskId: 'a' });
  assert.equal(taskDetail.runForTaskDetail({ runId: 'new', taskId: 'b',snapshot:detail.dashboard }), null);
});

test('execution selected in a group uses the exact displayed snapshot without a local detail taskId',()=>{
 const snapshot={runs:[{runId:'new',taskId:'a'}]};
 assert.deepEqual(taskDetail.runForTaskDetail({runId:'new',taskId:'a',snapshot}),snapshot.runs[0]);
 assert.equal(taskDetail.runForTaskDetail({runId:'missing',taskId:'a',snapshot}),null);
});
