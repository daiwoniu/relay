import assert from 'node:assert/strict';
import test from 'node:test';
import * as viewModel from './workspace-console-view-model.ts';

test('ledger heading distinguishes no ledger from registered but unmatched links', () => {
  assert.equal(viewModel.localLedgerLabel(0,0),'无本地台账');
  assert.equal(viewModel.localLedgerLabel(0,1),'已登记本地关联，台账尚未匹配');
  assert.equal(viewModel.localLedgerLabel(2,3),'关联本地交付 2 份');
});
const { buildWorkspaceConsoleView, buildWorkspaceSummary, buildTaskEntries, filterTaskEntries, filterTaskLanesByStatus, groupTaskEntriesByLane, selectFocusTasks, selectTaskAction, runsForTask, projectItemsForTask, formatObservedDuration, projectTaskCardDetails } = viewModel;

test('classification notice distinguishes partial classification from complete and legacy snapshots', () => {
  assert.equal(viewModel.responsibilityClassificationNotice(null), null);
  assert.equal(viewModel.responsibilityClassificationNotice({ complete: true, unverifiedCount: 0 }), null);
  assert.match(viewModel.responsibilityClassificationNotice({ complete: false, unverifiedCount: 2 }), /2 个候选待核实/);
  const legacy = viewModel.responsibilityClassificationNotice({ complete: false });
  assert.match(legacy, /当前数据不代表完整责任清单/);
  assert.doesNotMatch(legacy, /0 个|undefined|查询失败|更新失败/);
});

test('unknown role notice distinguishes historical participation from live work without hiding the gap',()=>{
  const notice=viewModel.responsibilityClassificationNotice({complete:false,unverifiedCount:2,workbenchItems:[
    {reasons:['unmapped_role'],flowFinished:true,isArchivedState:false},
    {reasons:['unmapped_role'],flowFinished:false,isArchivedState:false},
  ]});
  assert.match(notice,/2 项参与角色/);assert.match(notice,/1 项流程已结束/);assert.match(notice,/1 项仍在流转/);assert.match(notice,/不是待办数量/);
  assert.match(notice,/尚未取得飞书角色定义/);assert.match(notice,/重试刷新/);
  assert.doesNotMatch(notice,/尚未配置责任含义/);
});


test('primary item sorts verified links without losing other associations or changing grouping and filters', () => {
  const original = { ...task('multi', 'waiting', ['9001000001', '9001000002']), feishuWorkItemUrls: {
    '9001000001': 'https://project.feishu.cn/demo/story/detail/9001000001',
    '9001000002': 'https://project.feishu.cn/demo/issue/detail/9001000002',
  } };
  const primary = { ...original, feishuPrimaryWorkItemId: '9001000002' };
  const before = JSON.stringify(primary);
  assert.deepEqual(viewModel.feishuLinksForTask(primary, null).map(link => link.workItemId), ['9001000002', '9001000001']);
  assert.match(viewModel.feishuLinksForTask(primary, null)[0].title, /^主任务 · /);
  assert.equal(JSON.stringify(primary), before);
  for (const value of [null, 'unknown', '9001000003']) {
    assert.deepEqual(viewModel.feishuLinksForTask({ ...original, feishuPrimaryWorkItemId: value }, null), viewModel.feishuLinksForTask(original, null));
  }
  const entries = entry => viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [entry] }, null)));
  for (const filter of ['all', 'waiting', 'unfinished', 'completed']) {
    assert.deepEqual(filterTaskEntries(entries(primary), filter, '').map(e => [e.key, viewModel.taskEntryLane(e)]),
      filterTaskEntries(entries(original), filter, '').map(e => [e.key, viewModel.taskEntryLane(e)]));
  }
  assert.deepEqual(filterTaskEntries(entries(primary), 'all', '9001000001').map(e => e.key), ['local:multi']);
  const report = workbenchReport([parent('9001000001', 'u'), parent('9001000002', 'u')]);
  const grouped = entry => viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [entry] }, report)));
  assert.deepEqual(grouped(primary).map(e => [e.key, viewModel.taskEntryLane(e)]), grouped(original).map(e => [e.key, viewModel.taskEntryLane(e)]));
  assert(grouped(primary).some(e => e.key === 'local:multi'), 'primary hint must not resolve ambiguous membership into a chosen group');
});


test('each lane status filter is independent and groups synonymous statuses', () => {
  const lanes = groupTaskEntriesByLane([
    { kind: 'local', key: 'todo', task: task('todo', 'todo') },
    { kind: 'local', key: 'waiting', task: task('waiting', 'waiting') },
    { kind: 'local', key: 'review-pending', task: task('review-pending', 'review_pending') },
    { kind: 'local', key: 'review-alias', task: task('review-alias', 'review') },
    { kind: 'project', key: 'feishu', item: responsibility.items[0] },
    { kind: 'local', key: 'doing', task: task('doing', 'in_progress') },
    { kind: 'local', key: 'done', task: task('done', 'done') },
    { kind: 'local', key: 'completed', task: task('completed', 'completed') },
  ]);
  const filtered = filterTaskLanesByStatus(lanes, { unstarted: '等待中', doing: '', completed: '已完成' });
  assert.deepEqual(filtered.unstarted.map((entry) => entry.key), ['waiting']);
  assert.deepEqual(lanes.unstarted.map((entry) => entry.key), ['todo', 'waiting', 'review-pending', 'review-alias', 'feishu']);
  assert.equal(viewModel.taskEntryStatusLabel(lanes.unstarted[2]), '待复核');
  assert.deepEqual(filtered.doing.map((entry) => entry.key), ['doing']);
  assert.deepEqual(filtered.completed.map((entry) => entry.key), ['done', 'completed']);
  assert.deepEqual(filterTaskLanesByStatus(lanes, { unstarted: '当前待处理', doing: '', completed: '' }).unstarted.map((entry) => entry.key), ['feishu']);
});

test('Feishu current responsibility is pending rather than assumed executing', () => {
  assert.equal(viewModel.taskEntryStatusLabel({ kind: 'project', key: 'feishu', item: responsibility.items[0] }), '当前待处理');
});

test('bottom-panel node label shows owners and keeps old cached reports readable', () => {
  assert.equal(viewModel.currentNodeResponsibilityLabel({ currentNodeNames: ['验收'],
    currentNodes: [{ name: '验收', ownerNames: ['张三', '李四'] }] }), '当前节点：验收（节点负责人：张三、李四）');
  assert.equal(viewModel.currentNodeResponsibilityLabel({ currentNodeNames: ['验收'] }), '当前节点：验收（节点负责人：接口未返回）');
  assert.equal(viewModel.currentNodeResponsibilityLabel({ currentNodeNames: [], currentNodes: [] }), '当前节点：接口未返回');
  assert.equal(viewModel.currentNodeResponsibilityLabel({ currentNodeNames: ['验收'],
    currentNodes: [{ name: '验收', ownerNames: [] }] }), '当前节点：验收（节点负责人：未指定）');
  assert.equal(viewModel.currentNodeResponsibilityLabel({ currentNodeNames: ['验收'],
    currentNodes: [{ name: '验收', ownerNames: ['本人', '待核对'] }] }), '当前节点：验收（节点负责人：负责人信息待刷新、负责人信息待刷新）');
  assert.equal(viewModel.currentNodeResponsibilityLabel({ currentNodeNames: ['验收'],
    currentNodes: [{ name: '验收', ownerNames: ['张三', '姓名未知(user-123)'] }] }), '当前节点：验收（节点负责人：张三、姓名未知(user-123)）');
});

test('state-flow contacts retain the reporter or creator identity and unknown user ID', () => {
  assert.equal(viewModel.stateFlowResponsibilityLabel({ statusName: '已修复，待验收',
    fallbackContact: { role: 'reporter', names: ['张三'] } }), '当前状态：已修复，待验收（报告人：张三）');
  assert.equal(viewModel.stateFlowResponsibilityLabel({ statusName: '待验收',
    fallbackContact: { role: 'creator', names: ['姓名未知(u-123)'] } }), '当前状态：待验收（创建人：姓名未知(u-123)）');
  assert.equal(viewModel.stateFlowResponsibilityLabel({ statusName: '待验收' }), '当前状态：待验收（报告人／创建人：接口未返回）');
});

test('finished defects leave the active lanes regardless of acceptance or linked stories', () => {
  const base = { ...responsibility.items[0], typeName: '缺陷', personalSubtasks: [], currentNodes: [] };
  const transferred = { kind: 'project', key: 'project:9001000008', item: { ...base, workItemId: '9001000008', statusName: '转需求', linkedStoryIds: [] } };
  const linked = { kind: 'project', key: 'project:9001000009', item: { ...base, workItemId: '9001000009', statusName: '转需求', linkedStoryIds: ['9001000012'] } };
  const repaired = { kind: 'project', key: 'project:repaired', item: { ...base, statusName: '已修复' } };
  const awaitingAcceptance = { kind: 'project', key: 'project:acceptance', item: { ...base, statusName: '已修复，待验收' } };
  const open = { kind: 'project', key: 'project:open', item: { ...base, statusName: '新建' } };
  const lanes = groupTaskEntriesByLane([transferred, linked, repaired, awaitingAcceptance, open]);
  assert.deepEqual(lanes.completed.map((entry) => entry.key), [transferred.key, linked.key, repaired.key]);
  assert.deepEqual(lanes.unstarted.map((entry) => entry.key), [awaitingAcceptance.key, open.key]);
  assert.deepEqual(filterTaskEntries([transferred, linked, repaired, awaitingAcceptance, open], 'completed', '').map((entry) => entry.key),
    [transferred.key, linked.key, repaired.key]);
  assert.deepEqual(filterTaskEntries([transferred, linked, repaired, awaitingAcceptance, open], 'unfinished', '').map((entry) => entry.key), [awaitingAcceptance.key, open.key]);
  assert.equal(viewModel.taskEntryStatusLabel(transferred), '缺陷已结束 · 转需求');
  assert.equal(viewModel.taskEntryStatusLabel(repaired), '缺陷已结束 · 已修复');
  assert.equal(viewModel.taskDisplayEntryIsNew(transferred, new Set([transferred.key])), false);
  assert.deepEqual(projectTaskCardDetails(transferred.item), { current: '缺陷已结束 · 转需求', next: '无须继续处理此缺陷' });
  assert.equal(viewModel.isFinishedProjectIssue({ ...base, typeName: '需求', statusName: '转需求' }), false);
});

test('a finished defect is represented by its explicit delivery without completing that delivery or merging its story', () => {
  const storyId = '9001000012';
  const issueId = '9001000009';
  const issue = { ...responsibility.items[0], workItemId: issueId, typeName: '缺陷', statusName: '转需求',
    linkedStoryIds: [storyId], localTaskIds: ['issue-ledger'] };
  const report = { ...workbenchReport([parent(storyId, 'u')]), items: [issue] };
  const entries = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(
    { ...dashboard, tasks: [task('issue-ledger', 'waiting', [issueId])] }, report,
  )));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [`group:${storyId}`, `local:issue-ledger`]);
  assert.deepEqual(groupTaskEntriesByLane(entries).completed, []);
  assert.deepEqual(filterTaskEntries(entries, 'completed', ''), []);
  const linked = entries.find(entry=>entry.key==='local:issue-ledger').linkedFeishu;
  assert.equal(linked.length,1);assert.equal(linked[0].key,`project:${issueId}`);assert.equal(linked[0].pending,false);
  assert.equal(linked[0].finished,true);assert.equal(linked[0].statusLabel,'飞书缺陷状态：转需求');
  assert.deepEqual(filterTaskEntries(entries, 'waiting', '').map((entry) => entry.key), ['local:issue-ledger']);
});


test('attention items prioritize blocked work and recent records within each state', () => {
  const tasks = [
    { ...task('waiting-old', 'waiting'), lastVerifiedAt: '2026-09-20T10:00:00+08:00' },
    { ...task('paused', 'paused'), lastVerifiedAt: '2026-09-29T10:00:00+08:00' },
    { ...task('blocked-old', 'blocked'), lastVerifiedAt: '2026-09-21T10:00:00+08:00' },
    { ...task('waiting-new', 'waiting'), lastVerifiedAt: '2026-09-28T10:00:00+08:00' },
    { ...task('blocked-new', 'blocked'), lastVerifiedAt: '2026-09-27T10:00:00+08:00' },
  ];
  const summary = buildWorkspaceSummary(buildWorkspaceConsoleView({ ...dashboard, tasks }, null), { ...dashboard, tasks, sourceAvailable: { registry: true } }, null, Date.now());
  assert.deepEqual(summary.attentionTasks.map((item) => item.id), ['blocked-new', 'blocked-old', 'waiting-new', 'waiting-old']);
});

test('session activity labels show elapsed time without inventing missing timestamps', () => {
  const now = Date.parse('2026-09-29T12:00:00+08:00');
  assert.equal(viewModel.formatSessionActivity(now - 3 * 60_000, now), '3 分钟前活跃');
  assert.equal(viewModel.formatSessionActivity(now - 2 * 60 * 60_000, now), '2 小时前活跃');
  assert.equal(viewModel.formatSessionActivity(null, now), '活跃时间未记录');
});

test('Feishu-only cards use report facts without inventing a current action or update time', () => {
  assert.deepEqual(projectTaskCardDetails({ actionability: 'current', currentNodes: ['数据核验'], personalSubtasks: [{ name: '核对结果', passed: false }, { name: '旧项', passed: true }] }), {
    current: '数据核验', next: '未完成子任务：核对结果',
  });
  assert.deepEqual(projectTaskCardDetails({ actionability: 'state_responsibility', currentNodes: [], personalSubtasks: [] }), {
    current: '负责流程流转，当前不一定需要操作', next: '飞书报表未提供明确下一步',
  });
  assert.deepEqual(projectTaskCardDetails({ actionability: 'upcoming', currentNodes: [], personalSubtasks: [{ name: '联调', passed: false }] }), {
    current: '等待后续责任节点', next: '后续子任务：联调',
  });
});

test('task lanes keep a global search and sort each lane by the newest recorded task time', () => {
  const tasks = [
    { ...task('old-doing', 'doing'), title: '支付修复', lastVerifiedAt: '2026-09-20T10:00:00+08:00' },
    { ...task('new-doing', 'doing'), title: '支付校验', lastVerifiedAt: '2026-09-25T10:00:00+08:00' },
    { ...task('waiting', 'waiting'), title: '支付等待', lastVerifiedAt: '2026-09-23T10:00:00+08:00' },
    { ...task('paused', 'paused'), title: '支付暂停', lastVerifiedAt: '2026-09-24T10:00:00+08:00' },
    { ...task('done', 'done'), title: '支付完成', lastVerifiedAt: '2026-09-18T10:00:00+08:00', completedAt: '2026-09-26T10:00:00+08:00' },
  ];
  const project = { ...responsibility, items: [{ ...responsibility.items[0], workItemId: '789', title: '支付飞书', localTaskIds: [] }] };
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks }, project));
  const lanes = groupTaskEntriesByLane(filterTaskEntries(entries, 'all', '支付'));
  assert.deepEqual(lanes.unstarted.map((item) => item.key), ['local:paused', 'local:waiting', 'project:789']);
  assert.deepEqual(lanes.doing.map((item) => item.key), ['local:new-doing', 'local:old-doing']);
  assert.deepEqual(lanes.completed.map((item) => item.key), ['local:done']);
  assert.deepEqual(groupTaskEntriesByLane(filterTaskEntries(entries, 'all', 'new-doing')).doing.map((item) => item.key), ['local:new-doing']);
});

test('Feishu work items and grouped matters sort by their own last update time', () => {
  const items = [
    { ...responsibility.items[0], workItemId: '101', title: '较早飞书项', updatedAt: '2026-10-14T10:00:00+08:00' },
    { ...responsibility.items[0], workItemId: '102', title: '较新飞书项', updatedAt: '2026-10-16T10:00:00+08:00' },
  ];
  const report = { ...responsibility, items, sourceUserKey: 'u', workbenchItems: [
    { ...parent('201', 'u'), updatedAt: '2026-10-15T10:00:00+08:00' },
  ] };
  const entries = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [
    { ...task('ledger', 'doing'), lastVerifiedAt: '2026-10-13T10:00:00+08:00' },
  ] }, report)));
  assert.deepEqual(entries.map((entry) => entry.key), ['project:102', 'group:201', 'project:101', 'local:ledger']);
  assert.deepEqual(viewModel.selectFocusEntries(entries).map((entry) => entry.key), ['local:ledger', 'project:102', 'group:201', 'project:101']);
});

test('ended matters use completion time instead of later updates', () => {
  const finishedParent = { ...parent('201', 'u'), flowFinished: true,
    finishedAt: '2026-10-14T10:00:00+08:00', updatedAt: '2026-10-16T10:00:00+08:00' };
  const finishedLocal = { ...task('ledger', 'done'), completedAt: '2026-10-15T10:00:00+08:00',
    lastVerifiedAt: '2026-10-16T11:00:00+08:00' };
  const group = { kind: 'group', key: 'group:201', parent: finishedParent, members: [
    { kind: 'parent', key: 'parent:201', item: finishedParent },
    { kind: 'local', key: 'local:ledger', task: finishedLocal },
  ] };
  assert.equal(viewModel.taskDisplayEntryFinishedAt(group), Date.parse(finishedLocal.completedAt));
  assert.equal(viewModel.taskEntryFinishedAt({ kind: 'parent', key: 'parent:201', item: finishedParent }), Date.parse(finishedParent.finishedAt));
  assert.equal(viewModel.taskEntryFinishedAt({ kind: 'subtask', key: 'subtask:201:301', parent: finishedParent,
    subtask: { ...child('301', true, 'completed'), finishedAt: '2026-10-13T10:00:00+08:00' }, localTasks: [] }), Date.parse('2026-10-13T10:00:00+08:00'));
  assert.equal(viewModel.taskEntryFinishedAt({ kind: 'local', key: 'local:cancelled', task: task('cancelled', 'cancelled') }), 0);
});

test('a refresh marks only newly discovered task IDs and temporarily prioritizes them', () => {
  const entries = [
    { kind: 'local', key: 'local:recent', task: task('recent', 'doing') },
    { kind: 'local', key: 'local:new', task: task('new', 'doing') },
    { kind: 'project', key: 'project:42', item: responsibility.items[0] },
    { kind: 'local', key: 'local:old', task: task('old', 'doing') },
    { kind: 'local', key: 'local:finished', task: task('finished', 'done') },
  ];
  assert.deepEqual(viewModel.newTaskEntryKeys(null, entries), []);
  const discovered = viewModel.newTaskEntryKeys(['local:recent', 'local:old'], entries);
  assert.deepEqual(discovered, ['local:new', 'project:42', 'local:finished']);
  assert.deepEqual(viewModel.prioritizeTaskEntries(entries, new Set(discovered)).map((entry) => entry.key),
    ['local:new', 'project:42', 'local:recent', 'local:old', 'local:finished']);
  assert.equal(viewModel.taskDisplayEntryIsNew(entries[4], new Set(discovered)), false);
  assert.deepEqual(viewModel.newTaskEntryKeys(entries.map((entry) => entry.key), entries), []);
  assert.deepEqual(viewModel.prioritizeTaskEntries(entries, new Set()).map((entry) => entry.key),
    ['local:recent', 'local:new', 'project:42', 'local:old', 'local:finished']);
});

test('new markers retain both split refresh results while known future/shared identities stay known',()=>{
  const report={items:[],localAssociated:[],workbenchItems:[{workItemId:'root',mySubtasks:[{id:'future',phase:'upcoming',owners:['me','other']}]}]};
  const initial=viewModel.snapshotTaskIdentityKeys([],report);
  assert(initial.includes('subtask:root:future'));assert(initial.includes('project:root'));
  assert.equal(viewModel.retainNewTaskKeys(new Set(),null,initial).size,0,'first observation establishes a baseline');
  const localKeys=viewModel.snapshotTaskIdentityKeys([{key:'local:new'}],report);
  const first=viewModel.retainNewTaskKeys(new Set(),initial,localKeys);
  assert.deepEqual([...first],['local:new']);
  const changed={...report,workbenchItems:[{workItemId:'root',mySubtasks:[{id:'future',phase:'current'},{id:'fresh',phase:'current'}]}]};
  const both=viewModel.snapshotTaskIdentityKeys([{key:'local:new'},{key:'subtask:root:future'}],changed);
  const second=viewModel.retainNewTaskKeys(first,localKeys,both);
  assert.deepEqual([...second],['local:new','subtask:root:fresh']);
  assert.deepEqual([...viewModel.retainNewTaskKeys(second,both,both)],[...second],'association-only updates do not erase marks');
  assert.equal(viewModel.retainNewTaskKeys(new Set(),both,both).size,0,'next manual refresh clears prior marks');
});

const task = (id, status, ids = []) => ({ id, title: id, status, completedAt: status === 'done' ? '2026-09-26T10:00:00+08:00' : null, feishuWorkItemIds: ids, runIds: [], sessionIds: [] });
const dashboard = { registryGeneratedAt: '2026-09-26T10:00:00+08:00', tasks: [task('a', 'done', ['123']), task('b', 'active', ['123'])], runs: [{ runId: 'orphan', taskId: 'missing', status: 'unknown' }], unmatchedRuns: [{ runId: 'orphan', taskId: 'missing', status: 'unknown' }], sessions: [{ sessionId: 'alone' }], unlinkedSessions: [{ sessionId: 'alone' }] };
const responsibility = { generatedAt: '2026-09-26T05:00:00+08:00', items: [{ workItemId: '123', title: '责任事项', actionability: 'current', localTaskIds: ['a','b'], url: null }], localAssociated: [{ workItemId: '456', title: '关联事项', localTaskIds: ['b'], url: 'https://project.feishu.cn/demo-space/story/detail/456' }] };

const parent = (workItemId, ownerUserKey, mySubtasks = [], stateKey = 'doing', isArchivedState = false) => ({
  workItemId, title: `父项 ${workItemId}`, typeName: '需求', url: null, ownerUserKey,
  stateKey, isArchivedState, flowFinished: false, currentNodeNames: ['实施改造'], mySubtasks,
});
const child = (id, passed = false, phase = 'current') => ({ id, title: `子任务 ${id}`, owners: ['u'], passed, nodeId: 'n1', nodeName: '实施改造', phase });
const workbenchReport = (workbenchItems) => ({ ...responsibility, items: [], sourceUserKey: 'u', workbenchItems });

test('personal child totals include children represented by separate deliveries and deduplicate identities',()=>{
 const children=Array.from({length:35},(_,i)=>child(String(i),i!==34));
 const before=JSON.stringify(children);
 assert.deepEqual(viewModel.personalSubtaskSummary({mySubtasks:[...children,children[0]]}),{total:35,completed:34,unfinished:1});
 assert.equal(JSON.stringify(children),before);
});

test('related summaries separate flow completion from personal action and do not mix child or defect totals',()=>{
 const items=[
  {key:'p:11',workItemId:'11',kind:'workItem',typeName:'需求',pending:false,finished:false},
  {key:'i:12',workItemId:'12',kind:'workItem',typeName:'缺陷',pending:false,finished:true},
  {key:'i:13',workItemId:'13',kind:'workItem',typeName:'缺陷',pending:true,finished:false},
  {key:'i:14',workItemId:'14',kind:'workItem',typeName:'缺陷',pending:false,finished:null},
  {key:'c:11',workItemId:'11',kind:'subtask',pending:false,finished:true},
 ];
 const groups=viewModel.deliveryFeishuGroups([...items,items[1]]);
 assert.deepEqual(groups.map(g=>[g.key,g.items.length,g.completed.length,g.unfinished.length,g.unknown]),[
  ['workItems',1,0,1,0],['issues',3,1,2,1],['subtasks',1,1,0,0]]);
});

test('task file previews use known task and run paths, limit entries and preserve cross-task isolation',()=>{
 const local={...task('a','doing'),taskDocumentPath:'D:/tasks/a/README.md'};
 const files=viewModel.taskPrimaryFiles(local,[
  {taskId:'other',detailFilePath:'D:/private/other.json',startedAt:'2026-11-19T20:00:00Z'},
  {taskId:'a',detailFilePath:'D:/tasks/a/latest.json',startedAt:'2026-11-19T10:00:00Z'},
  {taskId:'a',detailFilePath:'D:/tasks/a/latest.json',startedAt:'2026-11-19T09:00:00Z'},
  {taskId:'a',detailFilePath:null,startedAt:'2026-11-19T08:00:00Z'},
  {taskId:'a',detailFilePath:'D:/tasks/a/older.json',startedAt:'2026-11-19T07:00:00Z'},
  {taskId:'a',detailFilePath:'D:/tasks/a/oldest.json',startedAt:'2026-11-19T06:00:00Z'},
 ]);
 assert.deepEqual(files.map(f=>f.path),['D:/tasks/a/README.md','D:/tasks/a/latest.json','D:/tasks/a/older.json']);
});

test('subtask links preserve the verified parent route and add precise node and child identifiers',()=>{
 const url=viewModel.feishuSubtaskUrl({url:'https://project.feishu.cn/demo/story/detail/11?tab=task'}, {nodeId:'node',id:'child'});
 const parsed=new URL(url);assert.equal(parsed.pathname,'/demo/story/detail/11');assert.equal(parsed.searchParams.get('tab'),'task');
 assert.equal(parsed.searchParams.get('activeStateId'),'node');assert.equal(parsed.searchParams.get('subTaskId'),'child');
 assert.equal(viewModel.feishuSubtaskUrl({url:null},{nodeId:'n',id:'c'}),null);
});

test('tracking rows explain completed, shared and future participation separately',()=>{
 assert.equal(viewModel.workbenchSubtaskStatusLabel({...child('shared'),owners:['u','other']}),'共同参与 · 未完成');
 assert.equal(viewModel.workbenchSubtaskStatusLabel({...child('shared',false,'unknown'),owners:['u','other']}),'状态待核对');
 assert.equal(viewModel.trackedParticipationLabel({kind:'parent',item:{...parent('a','u',[child('c',true)]),myNodes:[]}}),'本轮已完成');
 assert.equal(viewModel.trackedParticipationLabel({kind:'parent',item:{...parent('a','u'),myNodes:[{phase:'current',ownerCount:3}]}}),'共同参与');
 assert.equal(viewModel.trackedParticipationLabel({kind:'project',item:{...responsibility.items[0],actionability:'upcoming'}}),'后续参与');
});

test('local display context includes completed history, exact child links and unknown states without reclassifying a delivery',()=>{
 const local={...task('delivery','done',['11','33','unknown']),feishuWorkItemUrls:{unknown:'https://project.feishu.cn/demo/issue/detail/unknown'}};
 const p={...parent('11','u',[{...child('child',true),localTaskIds:['delivery']}]),url:'https://project.feishu.cn/demo/story/detail/11',currentNodes:[{name:'全量上线',ownerNames:['李国祥']}]};
 const closed={...parent('33','u'),typeName:'缺陷',flowFinished:true,url:'https://project.feishu.cn/demo/issue/detail/33'};
 const report={...workbenchReport([p,closed]),items:[],localAssociated:[]};
 const context=viewModel.taskFeishuContext(local,report);
 assert(context.find(i=>i.workItemId==='11').statusLabel.includes('全量上线'));
 assert.deepEqual(context.find(i=>i.workItemId==='11').nodeNames,['全量上线（负责人：李国祥）']);
 assert.equal(context.find(i=>i.workItemId==='11').statusOnlyLabel,null);
 assert.equal(context.find(i=>i.workItemId==='child').nodeLabel,'所属节点');
 assert.equal(context.find(i=>i.workItemId==='child').nodeName,'实施改造');
 assert.equal(context.find(i=>i.workItemId==='child').parent.workItemId,'11');
 assert.deepEqual(context.find(i=>i.workItemId==='child').parent.nodeNames,['全量上线（负责人：李国祥）']);
 assert.equal(context.find(i=>i.workItemId==='33').finished,true);
 assert.equal(context.find(i=>i.workItemId==='unknown').finished,null);
 assert.equal(context.find(i=>i.workItemId==='unknown').url,local.feishuWorkItemUrls.unknown);
 assert.equal(new URL(context.find(i=>i.workItemId==='child').url).searchParams.get('subTaskId'),'child');
 assert.equal(local.status,'done');assert.equal(viewModel.taskEntryLane({kind:'local',key:'delivery',task:local}),'completed');
});

test('current node owners stay paired with their own node and missing owner data remains explicit', () => {
  assert.deepEqual(viewModel.workItemCurrentNodeLines({currentNodeNames:['stale'],currentNodes:[
    {name:'调研、设计',ownerNames:['张三']},{name:'推进验证',ownerNames:['李四','王五']},
  ]}),['调研、设计（负责人：张三）','推进验证（负责人：李四、王五）']);
  assert.deepEqual(viewModel.workItemCurrentNodeLines({currentNodeNames:['审核']}),['审核（负责人：接口未返回）']);
  assert.deepEqual(viewModel.workItemCurrentNodeLines({currentNodes:[{name:'审核',ownerNames:[]}]}),['审核（负责人：未指定）']);
  assert.deepEqual(viewModel.workItemCurrentNodeLines({currentNodes:[{name:'审核',ownerNames:['张三']},{name:'审核',ownerNames:['李四']}]}),['审核（负责人：张三）','审核（负责人：李四）']);
});

test('uncertain associations and ambiguous child parents remain outside confirmed completion counts',()=>{
 const local=task('delivery','done',['33','child']);
 const report={...workbenchReport([
  {...parent('11','u',[{...child('child'),localTaskIds:['delivery']}]),url:'https://project.feishu.cn/demo/story/detail/11'},
  {...parent('22','u',[{...child('child'),localTaskIds:['delivery']}]),url:'https://project.feishu.cn/demo/story/detail/22'},
 ]),items:[{...responsibility.items[0],workItemId:'33',typeName:'缺陷',nativeCompleted:true,localTaskIds:[]}],localAssociated:[{workItemId:'33',localTaskIds:['delivery'],verified:false}]};
 const context=viewModel.taskFeishuContext(local,report);
 assert.equal(context.find(i=>i.workItemId==='child').url,null);
 assert.equal(context.find(i=>i.workItemId==='33').finished,null);
 const groups=viewModel.deliveryFeishuGroups(context);
 assert.equal(groups.find(g=>g.key==='issues'),undefined);
 assert.equal(groups.find(g=>g.key==='uncertain').items.length,2);
});

test('participated panel requires completed personal work and keeps unknown ownership in the main list', () => {
  const mine = { ...parent('11', 'u'), updatedAt: '2026-10-29T10:00:00Z' };
  const formerChild = { ...parent('12', 'other', [child('22', true, 'completed')]), updatedAt: '2026-10-30T10:00:00Z' };
  const pendingChild = parent('13', 'other', [child('23')]);
  const finished = { ...parent('14', 'u'), flowFinished: true };
  const current = parent('15', 'u');
  const archived = parent('16', 'u', [], 'doing', true);
  const upcoming = parent('17', 'u');
  const conflicting = { ...parent('18', 'u', [], 'done'), updatedAt: '2026-10-28T10:00:00Z' };
  const report = { ...workbenchReport([mine, formerChild, pendingChild, finished, current, archived, upcoming, conflicting]),
    items: [{ ...responsibility.items[0], workItemId: '15', actionability: 'current' },
      { ...responsibility.items[0], workItemId: '17', actionability: 'upcoming' }] };
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report).map((entry) => entry.item.workItemId), ['12']);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report))
    .filter((entry) => entry.kind === 'parent').map((entry) => entry.item.workItemId).sort(), ['11', '14', '15', '16', '18']);
  assert.deepEqual(viewModel.futureFeishuItems(report).map((entry) => entry.item.workItemId), ['17']);
});

test('completed personal nodes without children remain in completed history', () => {
  const story = { ...parent('9001000014', 'other'), myNodes: [
    { id: 'n1', name: '研发', phase: 'completed' },
  ] };
  const report = workbenchReport([story]);
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report).map((entry) => entry.item.workItemId), ['9001000014']);
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report));
  assert.deepEqual(entries.map((entry) => entry.key), ['parent:9001000014']);
  assert.equal(viewModel.taskEntryLane(entries[0]), 'completed');
});



test('an unfinished personal node or subtask remains in the main list', () => {
  const ownNode = { ...parent('active-node', 'other'), myNodes: [
    { id: 'n1', name: '研发', phase: 'completed' },
    { id: 'n2', name: '验收', phase: 'current' },
  ] };
  const ownChild = parent('active-child', 'other', [child('22', true, 'completed'), child('23', false, 'current')]);
  const report = workbenchReport([ownNode, ownChild]);
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report), []);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report))
    .map((entry) => entry.key).sort(), ['parent:active-node', 'subtask:active-child:22', 'subtask:active-child:23']);
});


test('a sole unfinished node stays above even when its own child passed', () => {
  const sole = { ...parent('sole-node', 'u', [child('child', true, 'current')]),
    myNodes: [{ id: 'n1', name: '研发', phase: 'current', ownerCount: 1 }] };
  const report = workbenchReport([sole]);
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report), []);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report))
    .map((entry) => entry.key).sort(), ['parent:sole-node', 'subtask:sole-node:child']);
});

test('an unfinished personal child in a completed node stays above for review', () => {
  const story = { ...parent('9001000033', 'other', [child('9001000034', false, 'completed')]),
    myNodes: [{ id: 'n1', name: '数据治理', phase: 'completed', ownerCount: 2 }] };
  const report = { ...workbenchReport([story]), complete: false };
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report), []);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report))
    .map((entry) => entry.key), ['parent:9001000033', 'subtask:9001000033:9001000034']);
});

test('a state-flow issue without completion evidence stays in the main list', () => {
  const issue = { ...responsibility.items[0], workItemId: 'open-issue', typeName: '缺陷',
    actionability: 'state_responsibility', statusName: '待处理', localTaskIds: [], personalSubtasks: [] };
  const report = { ...workbenchReport([]), items: [issue] };
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report), []);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report))
    .map((entry) => entry.key), ['project:open-issue']);
});

test('an acceptance role keeps a repaired issue in the main list', () => {
  const issue = { ...responsibility.items[0], workItemId: 'open-acceptance', typeName: '缺陷',
    actionability: 'state_responsibility', statusName: '已修复，待验收', localTaskIds: [],
    personalSubtasks: [], myRoleKeys: ['operator', 'acceptor'], baseOwnerIsMe: false };
  const report = { ...workbenchReport([]), items: [issue] };
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report), []);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report))
    .map((entry) => entry.key), ['project:open-acceptance']);
});


test('owner parent remains visible without any child', () => {
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, workbenchReport([parent('11', 'u')])));
  assert.deepEqual(entries.map((entry) => entry.key), ['parent:11']);
  assert.equal(viewModel.taskEntryLane(entries[0]), 'unstarted');
});


test('keeps a responsibility item outside a story group when its relation is ambiguous', () => {
  const issue = { ...responsibility.items[0], workItemId: '9001000032', typeName: '缺陷',
    linkedStoryIds: ['9001000029', '9001000030'], localTaskIds: [] };
  const report = { ...workbenchReport([parent('9001000029', 'u')]), items: [issue] };
  const groups = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report)));
  assert.deepEqual(groups.map((entry) => entry.key).sort(), ['group:9001000029', 'project:9001000032']);
});



test('every own child gets a parent-scoped card without claiming another owner parent', () => {
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, workbenchReport([
    parent('11', 'other', [child('22'), child('23', true)]),
    parent('12', null, [child('22')]),
  ])));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), ['subtask:11:22', 'subtask:11:23', 'subtask:12:22']);
  assert.equal(entries.find((entry) => entry.key === 'subtask:11:22').parent.title, '父项 11');
});

test('old parent ledger link cannot hide a newly assigned child or change its NEW key', () => {
  const local = { ...dashboard, tasks: [task('old-parent', 'done', ['11'])] };
  const entries = buildTaskEntries(buildWorkspaceConsoleView(local, workbenchReport([parent('11', 'other', [child('9001000028')])])));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), ['local:old-parent', 'subtask:11:9001000028']);
  assert.deepEqual(filterTaskEntries(entries, 'all', '9001000028').map((entry) => entry.key), ['subtask:11:9001000028']);
  assert.deepEqual(viewModel.newTaskEntryKeys(['local:old-parent'], entries), ['subtask:11:9001000028']);
});


test('a later own child reopens its parent group and keeps its independent NEW identity', () => {
  const oldEntries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, workbenchReport([
    parent('11', 'other', [child('22', true, 'completed')]),
  ])));
  const latestEntries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, workbenchReport([
    parent('11', 'other', [child('22', true, 'completed'), child('23', false, 'current')]),
  ])));
  const latestGroup = viewModel.groupTaskEntries(latestEntries)[0];
  assert.equal(viewModel.taskEntryLane(oldEntries[0]), 'completed');
  assert.equal(viewModel.taskEntryLane(latestGroup), 'unstarted');
  const newKeys = viewModel.newTaskEntryKeys(oldEntries.map((entry) => entry.key), latestEntries);
  assert.deepEqual(newKeys, ['subtask:11:23']);
  assert.equal(viewModel.taskDisplayEntryIsNew(latestGroup, new Set(newKeys)), true);
});



test('an unfinished child of an ended Feishu node stays in the ordinary pending lane', () => {
  const ended = { ...parent('9001000033', 'u', [child('9001000034', false, 'completed')], 'done'), flowFinished: true };
  const group = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(
    { ...dashboard, tasks: [] }, workbenchReport([ended]),
  )))[0];
  assert.equal(viewModel.taskEntryLane(group), 'unstarted');
  assert.equal(viewModel.workbenchSubtaskStatusLabel(ended.mySubtasks[0]), '未完成');
  assert.deepEqual(groupTaskEntriesByLane([group]).unstarted.map((entry) => entry.key), ['group:9001000033']);
});


test('completed workflow leaves active lanes without exposing opaque keys', () => {
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, workbenchReport([
    { ...parent('9001000010', 'u', [], 'can_b6fb_7'), flowFinished: true, currentNodeNames: [] },
    { ...parent('15', 'u', [], 'opaque'), flowFinished: null, currentNodeNames: [] },
  ])));
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  assert.equal(viewModel.taskEntryLane(byKey.get('parent:9001000010')), 'completed');
  assert.equal(viewModel.taskEntryStatusLabel(byKey.get('parent:9001000010')), '飞书流程已结束');
  assert.equal(viewModel.taskEntryLane(byKey.get('parent:15')), 'unstarted');
  assert.equal(viewModel.taskEntryStatusLabel(byKey.get('parent:15')), '状态待核对');
  assert.equal(viewModel.workbenchSubtaskNodeLabel(child('1', false, 'current')), '所属节点：实施改造');
  assert.equal(viewModel.workbenchSubtaskNodeLabel(child('1', true, 'completed')), '所属节点：实施改造');
});

test('an unfinished child in an ended or unknown node stays visible for review', () => {
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, workbenchReport([
    parent('9001000027', 'other', [child('9001000026', false, 'completed'), child('unknown', false, 'unknown')]),
  ])));
  for (const entry of entries) {
    assert.equal(viewModel.taskEntryLane(entry), 'unstarted');
    assert.equal(viewModel.taskEntryStatusLabel(entry), entry.kind === 'subtask' && entry.subtask.phase === 'completed'
      ? '未完成' : '状态待核对');
  }
});

test('refreshing one observation card reads its own dashboard snapshot without changing the other cards', () => {
  const base = { ...dashboard, tasks: [task('old-wait', 'waiting')], runs: [{ runId: 'old-run' }], sessions: [{ sessionId: 'old-session', updatedAt: 1 }], unlinkedSessions: [], sourceAvailable: { registry: true, runs: true, sessions: true } };
  const latest = { ...base, tasks: [task('new-block', 'blocked')], runs: [{ runId: 'new-run' }], sessions: [{ sessionId: 'new-session', updatedAt: 2 }], unlinkedSessions: [{ sessionId: 'new-session' }] };
  const attention = viewModel.buildObservationCards(base, { attention: latest }, 3);
  assert.deepEqual(attention.attention.items.map((item) => item.id), ['new-block']);
  assert.deepEqual(attention.runs.items.map((item) => item.runId), ['old-run']);
  assert.deepEqual(attention.sessions.items.map((item) => item.sessionId), ['old-session']);

  const runs = viewModel.buildObservationCards(base, { runs: latest }, 3);
  assert.deepEqual(runs.attention.items.map((item) => item.id), ['old-wait']);
  assert.deepEqual(runs.runs.items.map((item) => item.runId), ['new-run']);
  assert.deepEqual(runs.sessions.items.map((item) => item.sessionId), ['old-session']);

  const sessions = viewModel.buildObservationCards(base, { sessions: latest }, 3);
  assert.deepEqual(sessions.attention.items.map((item) => item.id), ['old-wait']);
  assert.deepEqual(sessions.runs.items.map((item) => item.runId), ['old-run']);
  assert.deepEqual(sessions.sessions.items.map((item) => item.sessionId), ['new-session']);
  assert.equal(sessions.sessions.unlinkedSessionIds.has('new-session'), true);
});

test('retains distinct local tasks under one responsibility', () => {
  const view = buildWorkspaceConsoleView(dashboard, responsibility);
  assert.equal(view.responsibility.current.length, 1);
  assert.deepEqual(view.responsibility.current[0].tasks.map((item) => item.id), ['a', 'b']);
  assert.equal(view.localAssociated.length, 1);
  assert.deepEqual(view.localAssociated[0].tasks.map((item) => item.id), ['b']);
  assert.deepEqual(view.unmatchedRuns.map((item) => item.runId), ['orphan']);
  assert.deepEqual(view.unlinkedSessions.map((item) => item.sessionId), ['alone']);
});

test('unbound reports do not infer local identity and duplicate projections keep the native responsibility',()=>{
  const unbound={...responsibility,associationMeta:{state:'unbound'},items:responsibility.items.map(item=>({...item,localTaskIds:[]})),localAssociated:[]};
  const view=buildWorkspaceConsoleView(dashboard,unbound);
  assert.deepEqual(view.responsibility.current[0].tasks,[]);
  assert.deepEqual(projectItemsForTask(dashboard.tasks[0],unbound),[]);
  const duplicated={...responsibility,localAssociated:[{...responsibility.localAssociated[0],workItemId:'123',localTaskIds:['a']}]};
  const linked=projectItemsForTask(dashboard.tasks[0],duplicated);
  assert.equal(linked.length,1);assert.equal(linked[0].actionability,'current');
});


test('local-only excludes tasks with a Feishu ID even when the current report omits it', () => {
  const local = { ...dashboard, tasks: [task('registry-link', 'paused', ['901']), task('report-link', 'paused'), task('orphan', 'paused')] };
  const report = { ...responsibility, items: [], localAssociated: [{ ...responsibility.localAssociated[0], localTaskIds: ['report-link'] }] };
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView(local, report), 'local').map((entry) => entry.key).sort(), ['local:orphan']);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView(local, { ...report, complete: false }), 'local')
    .map((entry) => entry.key).sort(), ['local:orphan']);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView(local, null), 'local').map((entry) => entry.key).sort(), ['local:orphan', 'local:report-link']);
});

test('completed tasks retain verified registry Feishu links when absent from current responsibility report', () => {
  const finished = { ...task('finished', 'done', ['9001000007']), feishuWorkItemUrls: { '9001000007': 'https://project.feishu.cn/demo-space/story/detail/9001000007' } };
  assert.deepEqual(viewModel.feishuLinksForTask(finished, null), [{ workItemId: '9001000007', title: '工作项 9001000007', url: finished.feishuWorkItemUrls['9001000007'] }]);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [finished] }, null), 'local'), []);
});

test('a work item ID without a verified URL never invents a task-specific link', () => {
  const finished = task('finished', 'done', ['9000000001']);
  assert.deepEqual(viewModel.registryFeishuLinksForTask(finished), []);
});


test('task links use source data rather than task-specific overrides', () => {
  assert.equal(typeof viewModel.feishuUrlForTask, 'function');
  const parent = { workItemId: '9001000016', url: 'https://project.feishu.cn/demo-space/sub_task/detail/9001000016' };
  const child = { workItemId: '9001000022', url: 'https://project.feishu.cn/demo-space/sub_task/detail/9001000022' };
  const childRoute = 'https://project.feishu.cn/demo-space/demo-type/detail/9001000003?activeStateId=state_3&subTaskId=9001000016';
  assert.equal(viewModel.feishuUrlForTask({ id: 'demo-task' }, parent), parent.url);
  assert.equal(viewModel.feishuUrlForTask({ id: 'demo-task' }, { ...parent, url: null }), null);
  assert.equal(viewModel.feishuUrlForTask({ id: 'other-task' }, parent), parent.url);
  assert.equal(viewModel.feishuUrlForTask({ id: 'demo-task' }, child), child.url);
  assert.equal(viewModel.feishuUrlForTask({ id: 'demo-task' }, { ...child, url: childRoute }), childRoute);
});

test('cached report URLs are preserved without hardcoded route changes', () => {
  const parent = { workItemId: '9001000003', url: 'https://project.feishu.cn/demo-space/b2b_pipeline/detail/9001000003' };
  assert.equal(viewModel.feishuUrlForTask({ id: 'other-task' }, parent), parent.url);
});

test('keeps local data before the Project response and flags newer completed ledger state', () => {
  const pending = buildWorkspaceConsoleView(dashboard, null);
  assert.equal(pending.tasks.length, 2);
  assert.equal(pending.responsibility.current.length, 0);
  const resolved = buildWorkspaceConsoleView(dashboard, responsibility);
  assert.equal(resolved.responsibility.current[0].needsRecheck, true);
  assert.equal(resolved.responsibility.current[0].tasks[0].status, 'done');
});

test('Project responsibility remains visible when registry has failed', () => {
  const failedRegistry = { ...dashboard, tasks: [], registryGeneratedAt: null };
  const view = buildWorkspaceConsoleView(failedRegistry, responsibility);
  assert.equal(view.responsibility.current[0].title, '责任事项');
  assert.deepEqual(view.responsibility.current[0].tasks, []);
});

test('Project-only tasks remain in the list when the local dashboard request fails', () => {
  const view = buildWorkspaceConsoleView(null, responsibility);
  assert.deepEqual(buildTaskEntries(view).map((item) => item.key), ['project:123']);
});

test('a completed local task always shows the responsibility conflict', () => {
  const newerProject = { ...responsibility, generatedAt: '2026-09-27T05:00:00+08:00' };
  const view = buildWorkspaceConsoleView(dashboard, newerProject);
  assert.equal(view.responsibility.current[0].needsRecheck, true);
});

test('same-named Runs stay with their task', () => {
  const runA = { runId: 'run-1', taskId: 'a', status: 'done', startedAt: '2026-09-26T09:00:00+08:00' };
  const runB = { runId: 'run-1', taskId: 'b', status: 'failed', startedAt: '2026-09-26T10:00:00+08:00' };
  const runB2 = { runId: 'run-2', taskId: 'b', status: 'done', startedAt: '2026-09-26T11:00:00+08:00' };
  const next = { ...dashboard, tasks: [{ ...dashboard.tasks[0], runIds: ['run-1'] }, { ...dashboard.tasks[1], runIds: ['run-1', 'run-2'] }], runs: [runA, runB, runB2] };
  assert.deepEqual(runsForTask(next, next.tasks[0]).map((item) => item.taskId), ['a']);
});

test('detail local ledgers put unfinished work first and sort each state by its latest record', () => {
  const rows = [
    { ...task('done-new', 'done'), completedAt: '2026-10-16T11:00:00+08:00' },
    { ...task('open-old', 'doing'), lastVerifiedAt: '2026-10-14T09:00:00+08:00' },
    { ...task('done-old', 'done'), completedAt: '2026-10-15T11:00:00+08:00' },
    { ...task('open-new', 'doing'), lastVerifiedAt: '2026-10-16T09:00:00+08:00' },
  ];
  assert.deepEqual(viewModel.sortDetailLocalTasks(rows).map((row) => row.id),
    ['open-new', 'open-old', 'done-new', 'done-old']);
  assert.equal(rows[0].id, 'done-new');
});

test('detail local ledger folding always exposes unfinished work and fills two slots with recent completed work', () => {
  const rows = [
    { ...task('done-old', 'done'), completedAt: '2026-10-14T11:00:00+08:00' },
    { ...task('open-new', 'doing'), lastVerifiedAt: '2026-10-16T11:00:00+08:00' },
    { ...task('done-new', 'done'), completedAt: '2026-10-16T10:00:00+08:00' },
    { ...task('done-middle', 'done'), completedAt: '2026-10-15T11:00:00+08:00' },
    { ...task('open-old', 'doing'), lastVerifiedAt: '2026-10-14T09:00:00+08:00' },
  ];
  const ids = (items) => items.map((item) => item.id);
  let result = viewModel.splitDetailLocalTasks(rows);
  assert.deepEqual(ids(result.visible), ['open-new', 'open-old']);
  assert.deepEqual(ids(result.hidden), ['done-new', 'done-middle', 'done-old']);
  result = viewModel.splitDetailLocalTasks(rows.filter((item) => item.id !== 'open-old'));
  assert.deepEqual(ids(result.visible), ['open-new', 'done-new']);
  assert.deepEqual(ids(result.hidden), ['done-middle', 'done-old']);
  result = viewModel.splitDetailLocalTasks(rows.filter((item) => item.status === 'done'));
  assert.deepEqual(ids(result.visible), ['done-new', 'done-middle']);
  assert.deepEqual(ids(result.hidden), ['done-old']);
  assert.equal(rows[0].id, 'done-old');
});

test('detail Feishu children put unfinished work first and use their available own or local dates', () => {
  const children = [
    { id: 'done', passed: true, finishedAt: '2026-10-16T12:00:00+08:00' },
    { id: 'open-old', passed: false, localTaskIds: ['local-old'] },
    { id: 'open-new', passed: false, localTaskIds: ['local-new'] },
    { id: 'done-old', passed: true, finishedAt: '2026-10-15T12:00:00+08:00' },
  ];
  const next = parent('123', 'user', children);
  next.updatedAt = '2026-10-14T12:00:00+08:00';
  const locals = [
    { ...task('local-new', 'doing', ['open-new']), lastVerifiedAt: '2026-10-16T09:00:00+08:00' },
    { ...task('local-old', 'doing', ['open-old']), lastVerifiedAt: '2026-10-15T09:00:00+08:00' },
  ];
  assert.deepEqual(viewModel.sortDetailSubtasks(next, locals).map((child) => child.id),
    ['open-new', 'open-old', 'done', 'done-old']);
  assert.equal(viewModel.taskEntryUpdatedAt({ kind: 'subtask', parent: next, subtask: children[1] }), 0);
  assert.deepEqual(viewModel.sortDetailSubtasks(next, []).map((child) => child.id),
    ['open-old', 'open-new', 'done', 'done-old']);
  assert.deepEqual(viewModel.sortDetailSubtasks(next, [], new Map([['open-new', '2026-10-17T09:00:00+08:00']]))
    .map((child) => child.id), ['open-new', 'open-old', 'done', 'done-old']);
  assert.equal(children[0].id, 'done');
});

test('parent detail collects child and direct ledgers once for a separate local list', () => {
  const story = parent('parent-1', 'other', [
    { id: 'child-1', title: '子任务一', passed: true, localTaskIds: ['completed-child'] },
    { id: 'child-2', title: '子任务二', passed: false, localTaskIds: ['active-child'] },
  ]);
  story.localTaskIds=['direct-parent','active-child'];
  const rows = [
    { ...task('completed-child', 'done', ['child-1']), completedAt: '2026-10-16T11:00:00+08:00' },
    { ...task('direct-parent', 'doing', ['parent-1']), lastVerifiedAt: '2026-10-15T09:00:00+08:00' },
    { ...task('active-child', 'doing', ['child-2', 'parent-1']), lastVerifiedAt: '2026-10-16T09:00:00+08:00' },
    task('unrelated', 'doing', ['other-parent']),
  ];
  assert.deepEqual(viewModel.localLedgersForParent(story, rows).map((row) => row.id),
    ['active-child', 'direct-parent', 'completed-child']);
});

test('task detail Runs show newest starts first even when the source order differs', () => {
  const runs = [
    { runId: 'old', taskId: 'a', startedAt: '2026-10-14T09:00:00+08:00' },
    { runId: 'other', taskId: 'b', startedAt: '2026-10-17T09:00:00+08:00' },
    { runId: 'new', taskId: 'a', startedAt: '2026-10-16T09:00:00+08:00' },
    { runId: 'middle', taskId: 'a', startedAt: '2026-10-15T09:00:00+08:00' },
  ];
  assert.deepEqual(runsForTask({ ...dashboard, runs }, dashboard.tasks[0]).map((run) => run.runId),
    ['new', 'middle', 'old']);
});

test('local association rows sharing a Project parent retain their own task', () => {
  const localRows = {
    generatedAt: responsibility.generatedAt,
    items: [],
    localAssociated: [
      { associationKey: '123:0', workItemId: '123', title: '本地事项 A', localTaskIds: ['a'], url: null },
      { associationKey: '123:1', workItemId: '123', title: '本地事项 B', localTaskIds: ['b'], url: null },
    ],
  };
  const view = buildWorkspaceConsoleView(dashboard, localRows);
  assert.deepEqual(view.localAssociated.map((item) => item.tasks.map((linked) => linked.id)), [['a'], ['b']]);
  assert.deepEqual(projectItemsForTask(dashboard.tasks[0], localRows).map((item) => item.title), ['本地事项 A']);
});

test('focus cards include every unfinished status and put immediate work first within each status', () => {
  const tasks = [
    { ...task('normal', 'doing'), horizon: 'normal' },
    { ...task('done', 'done'), horizon: 'immediate' },
    { ...task('urgent', 'doing'), horizon: 'immediate' },
    { ...task('waiting', 'waiting'), horizon: 'immediate' },
    { ...task('paused', 'paused'), horizon: 'near' },
    { ...task('cancelled', 'cancelled'), horizon: 'immediate' },
  ];
  assert.deepEqual(selectFocusTasks(tasks).map((item) => item.id), ['urgent', 'normal', 'waiting', 'paused']);
});

test('focus selection keeps an odd final task instead of silently dropping it', () => {
  for (const [total, visible] of [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 6]]) {
    const tasks = Array.from({ length: total }, (_, index) => task(`doing-${index}`, 'doing'));
    assert.deepEqual(selectFocusTasks(tasks).map((item) => item.id), tasks.slice(0, visible).map((item) => item.id));
  }
});


test('focus order follows a waiting local ledger before a current Feishu child without a ledger', () => {
  const waiting = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(
    { ...dashboard, tasks: [task('ledger', 'waiting', ['22'])] },
    workbenchReport([parent('11', 'other', [child('22', false, 'current')])]),
  )))[0];
  const feishuOnly = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(
    { ...dashboard, tasks: [] },
    workbenchReport([parent('33', 'other', [child('44', false, 'current')])]),
  )))[0];
  assert.deepEqual(viewModel.selectFocusEntries([feishuOnly, waiting]).map((entry) => entry.key), ['group:33', 'group:11']);
});

test('a passed Feishu child stays actionable while its linked local ledger is still doing', () => {
  assert.equal(viewModel.workbenchChildNeedsAttention(child('22', true, 'completed'), [task('local', 'doing', ['22'])]), true);
  assert.equal(viewModel.workbenchChildNeedsAttention(child('22', true, 'completed'), [task('local', 'done', ['22'])]), false);
});


test('a local task linked to a child opens the exact Feishu subtask with its title and ID', () => {
  const linked = task('etl', 'doing', ['9001000024']);
  const report = workbenchReport([{
    ...parent('9001000005', 'other', [{...child('9001000024', false, 'current'),localTaskIds:['etl']}]),
    url: 'https://project.feishu.cn/demo-space/detail/9001000005',
  }]);
  const links = viewModel.feishuLinksForTask(linked, report);
  assert.equal(links[0].workItemId, '9001000024');
  assert.equal(links[0].title, '子任务 9001000024');
  assert.equal(links[0].url, 'https://project.feishu.cn/demo-space/detail/9001000005?activeStateId=n1&subTaskId=9001000024');
});

test('linked Feishu references name their actual parent or child relationship', () => {
  const report = workbenchReport([parent('11', 'u', [child('22')])]);
  assert.equal(viewModel.feishuRelationshipLabel('11', report), '飞书需求父项');
  assert.equal(viewModel.feishuRelationshipLabel('22', report), '飞书子任务');
  assert.equal(viewModel.feishuRelationshipLabel('9001000025', report, 'https://project.feishu.cn/demo-space/b2b_support/detail/9001000025'), '飞书B端售后支持');
  assert.equal(viewModel.feishuRelationshipLabel('9001000011', report, 'https://project.feishu.cn/demo-space/issue/detail/9001000011'), '飞书缺陷');
  assert.equal(viewModel.feishuRelationshipLabel('42', { ...report, items: [{ ...report.items[0], workItemId: '42', typeName: '申请' }] }), '飞书申请');
  assert.equal(viewModel.feishuRelationshipLabel('unknown', report), '飞书任务');
  assert.equal(viewModel.feishuRelationshipLabel('22', null), '飞书任务');
});

test('focus cards fill the first row then stack in the shortest column', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.equal(viewModel.focusColumnCount(600, entries.length), 1);
  assert.equal(viewModel.focusColumnCount(900, entries.length), 2);
  assert.equal(viewModel.focusColumnCount(1300, entries.length), 3);
  assert.equal(viewModel.focusColumnCount(1600, 3), 3);
  assert.deepEqual(viewModel.distributeFocusEntries(entries, 3), [['a', 'd'], ['b', 'e'], ['c', 'f']]);
  const heights = { a: 480, b: 340, c: 230, d: 160, e: 180, f: 200 };
  assert.deepEqual(viewModel.distributeFocusEntries(entries, 3, (entry) => heights[entry]), [['a'], ['b', 'e'], ['c', 'd', 'f']]);
});

test('recent run observation does not displace newer runs to favor distinct tasks', () => {
  const runs = [
    { runId: 'c1', taskId: 'c', startedAt: '2026-11-19 09:00:00' },
    { runId: 'a3', taskId: 'a', startedAt: '2026-11-20 10:00:00' }, { runId: 'a2', taskId: 'a', startedAt: '2026-11-20 09:00:00' },
    { runId: 'b1', taskId: 'b', startedAt: '2026-11-20 08:00:00' }, { runId: 'a1', taskId: 'a', startedAt: '2026-11-20 07:00:00' },
  ];
  assert.deepEqual(viewModel.selectRecentRuns(runs, 4).map((item) => item.runId), ['a3', 'a2', 'b1', 'a1']);
  assert.equal(runs[0].runId, 'c1');
});

test('latest execution file uses the same order as the run list when start time is absent', () => {
  const item = { ...task('a', 'doing'), taskDocumentPath: null };
  const runs = [
    { taskId: 'a', runId: 'dated', detailFilePath: 'older.json', startedAt: '2026-11-19 09:00:00' },
    { taskId: 'a', runId: '20261120-090000-new', detailFilePath: 'newer.json', startedAt: null },
  ];
  assert.equal(viewModel.taskPrimaryFiles(item, runs)[0].path, 'newer.json');
});

test('focus current removes only a leading timestamp and keeps dates in the description', () => {
  assert.equal(viewModel.formatFocusCurrent('2026-09-29 10:30：完成联调；等待验收'), '完成联调；等待验收');
  assert.equal(viewModel.formatFocusCurrent('[2026-09-29T10:30:00+08:00] 完成联调'), '完成联调');
  assert.equal(viewModel.formatFocusCurrent('2026-09-28用户确认已部署'), '用户确认已部署');
  assert.equal(viewModel.formatFocusCurrent('计划于 2026-09-30 验收'), '计划于 2026-09-30 验收');
});

test('focus card text starts a new line after sentence-ending punctuation', () => {
  assert.equal(viewModel.breakFocusSentences('先联调；再验收。最后归档'), '先联调；\n再验收。\n最后归档');
  assert.equal(viewModel.breakFocusSentences('检查 A; 检查 B'), '检查 A;\n检查 B');
});

test('summary keeps unavailable ledger metrics unknown and separates Run status from task status', () => {
  const view = buildWorkspaceConsoleView({ ...dashboard, tasks: [task('a', 'waiting'), task('b', 'done')], runs: [{ runId: 'r', taskId: 'a', status: 'done' }] }, null);
  const summary = buildWorkspaceSummary(view, { ...dashboard, sourceAvailable: { registry: false, runs: true, sessions: true, links: true, activity: true } }, null, Date.now());
  assert.equal(summary.metrics.unfinished.value, null);
  assert.deepEqual(summary.attentionTasks.map((item) => item.id), ['a']);
  assert.equal(summary.recentRuns[0].status, 'done');
  assert.equal(view.tasks[0].status, 'waiting');
});

test('completed task remains history after deleting its session while a shared session can continue two tasks', () => {
  const shared = { sessionId: 'shared', updatedAt: 5 };
  assert.equal(selectTaskAction({ ...task('closed', 'done'), sessionIds: [] }, []), 'history');
  assert.equal(selectTaskAction({ ...task('a', 'doing'), sessionIds: ['shared'] }, [shared]), 'continue');
  assert.equal(selectTaskAction({ ...task('b', 'waiting'), sessionIds: ['shared'] }, [shared]), 'continue');
  assert.equal(selectTaskAction({ ...task('a', 'doing'), sessionIds: ['deleted'] }, [shared]), 'start');
});

test('recent completion metric filters only tasks completed in the last seven days', () => {
  const now = Date.parse('2026-09-28T12:00:00+08:00');
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [
    { ...task('recent', 'done'), completedAt: '2026-09-27T12:00:00+08:00' },
    { ...task('old', 'done'), completedAt: '2026-09-01T12:00:00+08:00' },
  ] }, null));
  assert.deepEqual(filterTaskEntries(entries, 'recent', '', now).map((item) => item.key), ['local:recent']);
});

test('observed activity time distinguishes missing records from recorded minutes', () => {
  assert.equal(formatObservedDuration(null), '未记录');
  assert.equal(formatObservedDuration(0), '0 分钟');
  assert.equal(formatObservedDuration(3661), '1 小时 1 分钟');
});




test('9001000013 ended story stays completed and its new linked defect remains separate and pending', () => {
  const p={...parent('9001000013','u',[child('9001000035',true,'completed')]),flowFinished:true};
  const issue={...responsibility.items[0],workItemId:'9001000038',title:'关联询价评估缺陷',typeName:'缺陷',statusName:'新建',actionability:'state_responsibility',linkedStoryIds:[p.workItemId],personalSubtasks:[]};
  const entries=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(
    {...dashboard,tasks:[task('finished','done',[p.workItemId])]}, {...workbenchReport([p]),items:[issue]})));
  const story=entries.find(e=>e.key===`group:${p.workItemId}`), defect=entries.find(e=>e.key===`project:${issue.workItemId}`);
  assert.equal(viewModel.taskEntryLane(story),'completed');
  assert.equal(viewModel.taskEntryLane(defect),'unstarted');
  assert.equal(viewModel.taskEntryStatusLabel(defect),'待确认');
  assert.equal(story.members.some(e=>e.kind==='project'),false);
});

test('future-only personal responsibility is background, not a current pending or completed task', () => {
  const p={...parent('future','u'),myNodes:[{id:'next',name:'衔接应用',phase:'upcoming'}]};
  const report=workbenchReport([p]);
  assert.equal(viewModel.workbenchPersonalState(p),'future');
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[]},report)),[]);
  assert.deepEqual(viewModel.futureFeishuItems(report).map(e=>e.item.workItemId),['future']);
  const history={...dashboard,tasks:[task('old','done',[p.workItemId])]};
  const group=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(history,report)))[0];
  assert.equal(viewModel.taskEntryLane(group),'completed');
  const cancelled={...dashboard,tasks:[task('cancelled','cancelled',[p.workItemId])]};
  assert.equal(viewModel.futureFeishuItems(report,cancelled.tasks).length,1);
  assert.equal(buildTaskEntries(buildWorkspaceConsoleView(cancelled,report)).some(e=>e.kind==='parent'),false);
});


test('paused-only work leaves focus while unknown or unfinished ended-node work remains pending review', () => {
  const paused={kind:'local',key:'paused',task:task('paused','paused')};
  const p={...parent('unknown','u'),myNodes:[{id:'x',phase:'unknown'}]};
  const unknown={kind:'parent',key:'parent:unknown',item:p};
  assert.equal(viewModel.taskEntryLane(unknown),'unstarted');
  assert.equal(viewModel.taskEntryStatusLabel(unknown),'状态待核对');
  assert.deepEqual(viewModel.selectFocusEntries([paused,unknown]).map(e=>e.key),['parent:unknown']);
});


test('flow tracking combines completed personal work and future participation without changing main lanes or duplicating report parents', () => {
  const finished={...parent('finished','u',[child('c',true,'completed')]),myNodes:[{id:'n1',phase:'completed'}]};
  const future={...parent('future','u'),myNodes:[{id:'n2',phase:'upcoming'}]};
  const current={...parent('current','u'),myNodes:[{id:'n3',phase:'current'}]};
  const ended={...finished,workItemId:'ended',flowFinished:true};
  const report={...workbenchReport([finished,future,current,ended]),items:[
    {...responsibility.items[0],workItemId:'future',actionability:'upcoming'},
    {...responsibility.items[0],workItemId:'project-next',actionability:'upcoming'},
  ]};
  const local={...dashboard,tasks:[]};
  const before=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,report))).map(e=>[e.key,viewModel.taskEntryLane(e)]);
  assert.deepEqual(viewModel.trackedOpenFeishuItems(report).map(e=>e.item.workItemId).sort(),['finished','future','project-next']);
  assert.deepEqual(viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,report))).map(e=>[e.key,viewModel.taskEntryLane(e)]),before);
  assert.deepEqual(viewModel.trackedOpenFeishuItems(report,[task('running','doing',['finished'])]).map(e=>e.item.workItemId).sort(),['finished','future','project-next']);
});




test('the grouping index keeps ambiguous shared children and numeric local IDs independent', () => {
  const report=workbenchReport([parent('11','other',[child('shared')]),parent('12','other',[child('shared')])]);
  const local={...dashboard,tasks:[task('ambiguous','doing',['shared']),task('11','todo')]};
  const groups=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,report)));
  assert.deepEqual(groups.map(e=>e.key).sort(),['group:11','group:12','local:11','local:ambiguous']);
  assert.ok(groups.filter(e=>e.kind==='group').every(e=>e.members.every(m=>m.kind!=='local')));
});


test('a directory-only inferred association never hides a completed local ledger', () => {
  const issue = { ...responsibility.items[0], workItemId: '9001000038', typeName: '缺陷', statusName: '已修复',
    localTaskIds: [], linkedStoryIds: ['ended-story'], personalSubtasks: [] };
  const local = task('feishu-9001000038-inferred', 'done');
  const view = buildWorkspaceConsoleView({ ...dashboard, tasks: [local] },
    { ...responsibility, items: [issue], workbenchItems: [], localAssociated: [] });
  const cards = viewModel.groupTaskEntries(buildTaskEntries(view));
  assert.deepEqual(cards.map((entry) => entry.key).sort(), [`local:${local.id}`, 'project:9001000038']);
});


test('native facts and multiple local deliveries remain independent cards and states',()=>{
 const p={...parent('11','u',[child('22')]),myNodes:[{id:'n1',phase:'current'}]};
 const locals=[task('done','done',['11','22']),task('active','doing',['22']),task('waiting','waiting',['11'])];
 const entries=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:locals},workbenchReport([p]))));
 assert.deepEqual(entries.map(e=>e.key).sort(),['group:11','local:active','local:done','local:waiting']);
 const group=entries.find(e=>e.kind==='group');
 assert.deepEqual(group.members.map(e=>e.kind),['parent','subtask']);
 assert.equal(viewModel.taskEntryLane(group),'unstarted');
 assert.equal(viewModel.taskEntryLane(entries.find(e=>e.key==='local:active')),'doing');
 assert.equal(viewModel.taskEntryLane(entries.find(e=>e.key==='local:done')),'completed');
 assert.equal(filterTaskEntries(entries,'waiting','').some(e=>e.key==='local:waiting'),true);
 const counts=viewModel.taskRecordCounts(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:locals},workbenchReport([p]))));
 assert.deepEqual(counts,{deliveries:3,workItems:1,children:1,nodes:1,cards:4});
});

test('explicit related issues use their local delivery card while the unassociated parent stays independent',()=>{
 const p=parent('11','u');
 const issue={...responsibility.items[0],workItemId:'33',typeName:'缺陷',statusName:'处理中',actionability:'state_responsibility',nativeCompleted:false,linkedStoryIds:['11'],localTaskIds:['a']};
 const report={...workbenchReport([p]),items:[issue]};
 const entries=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[task('a','doing',['33'])]},report)));
 assert.deepEqual(entries.map(e=>e.key).sort(),['group:11','local:a']);
 assert.deepEqual(filterTaskEntries(entries,'all','33').map(e=>e.key).sort(),['local:a']);
 assert.deepEqual(projectItemsForTask(task('a','doing',['33']),report).map(e=>e.workItemId),['33']);
});

test('native completion does not complete or suppress any linked local delivery',()=>{
 const issue={...responsibility.items[0],workItemId:'33',nativeCompleted:true,localTaskIds:['a','b']};
 const report={...responsibility,items:[issue],workbenchItems:[],localAssociated:[]};
 const entries=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[task('a','doing',['33']),task('b','done',['33'])]},report)));
 assert.deepEqual(entries.map(e=>e.key).sort(),['local:a','local:b']);
 assert.equal(viewModel.taskEntryLane(entries.find(e=>e.key==='local:a')),'doing');
 assert.equal(viewModel.taskEntryLane(entries.find(e=>e.key==='local:b')),'completed');
 assert.equal(report.items[0].nativeCompleted,true);
 assert.deepEqual(viewModel.participatedOpenFeishuItems(report,[task('a','doing',['33'])]).map(e=>e.item.workItemId),['33']);
});

test('local completion and role names never prove native responsibility complete',()=>{
 const issue={...responsibility.items[0],nativeCompleted:false,typeName:'缺陷',statusName:'已修复',myRoleKeys:['operator'],localTaskIds:['a']};
 assert.equal(viewModel.isFinishedProjectIssue(issue),false);
 assert.equal(viewModel.personalIssueCompletionNotice(issue,[task('a','done',['123'])]),null);
 const entries=buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[task('a','done',['123'])]},{...responsibility,items:[issue],workbenchItems:[]}));
 assert.equal(viewModel.taskEntryLane(entries.find(e=>e.kind==='project')),'unstarted');
 assert.equal(viewModel.isFinishedProjectIssue({...issue,nativeCompleted:null}),false);
});

test('exact completed delivery may finish personal responsibility after handoff without closing the Feishu defect',()=>{
 const issue={...responsibility.items[0],workItemId:'33',typeKey:'issue',typeName:'缺陷',nativeCompleted:false,statusName:'已修复，待验收',actionability:'state_responsibility',updatedAt:'2026-11-20T11:13:24Z',currentNodes:[],personalSubtasks:[],reasons:[]};
 const delivered={...task('delivery','done',['33']),completedAt:'2026-11-20T11:13:30Z'};
 assert.equal(viewModel.personalIssueCompleted(issue,[delivered]),true);
 assert.equal(viewModel.isFinishedProjectIssue(issue),false,'the native defect remains open for acceptance');
 assert.match(viewModel.personalIssueCompletionNotice(issue,[delivered]),/本人本轮交付已完成/);
 for(const changed of [{statusName:'重新打开'},{statusName:'新建'},{updatedAt:'2026-11-20T11:14:00Z'},{updatedAt:null},{actionability:'current'},{currentNodes:['本人当前节点']},{personalSubtasks:[{passed:false}]}])assert.equal(viewModel.personalIssueCompleted({...issue,...changed},[delivered]),false);
 assert.equal(viewModel.personalIssueCompleted(issue,[{...delivered,completedAt:null}]),false);
 assert.equal(viewModel.personalIssueCompleted(issue,[{...delivered,status:'waiting'}]),false);
 assert.equal(viewModel.personalIssueCompleted(issue,[{...delivered,feishuWorkItemIds:['parent','33'],feishuPrimaryWorkItemId:'parent'}]),false);
 const view=buildWorkspaceConsoleView({...dashboard,tasks:[delivered]},{...responsibility,items:[issue],workbenchItems:[]});
 assert.equal(view.responsibility.stateResponsibility[0].personalCompleted,true);
});

test('transferred defects are completed despite an open native flow, without completing local work or linked requirements',()=>{
 const issue={...responsibility.items[0],workItemId:'33',typeName:'缺陷',statusName:'转需求',actionability:'state_responsibility',nativeCompleted:false,localTaskIds:[],linkedStoryIds:['11']};
 const report={...responsibility,items:[issue],workbenchItems:[],localAssociated:[]};
 const cardsFor=locals=>viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:locals},report)));
 const cards=cardsFor([]);
 assert.equal(viewModel.taskEntryLane(cards[0]),'completed');
 assert.equal(viewModel.taskEntryStatusLabel(cards[0]),'缺陷已结束 · 转需求');
 assert.equal(viewModel.trackedOpenFeishuItems(report).length,0);
 assert.equal(viewModel.isFinishedProjectIssue({...issue,nativeCompleted:null}),true);
 assert.equal(viewModel.isFinishedProjectIssue({...issue,typeName:'需求'}),false);
 assert.equal(viewModel.isFinishedProjectIssue({...issue,statusName:'已修复，待验收'}),false);
 issue.localTaskIds=['delivery'];
 const done=cardsFor([task('delivery','done',['33'])]);
 assert.equal(done.length,1);assert.equal(viewModel.taskEntryLane(done[0]),'completed');
 assert.equal(viewModel.localEntryNeedsRecheck(done[0]),false);
 const unfinished=cardsFor([task('delivery','doing',['33'])]);
 assert.equal(unfinished.length,1);assert.equal(viewModel.taskEntryLane(unfinished[0]),'doing');
 assert.equal(unfinished[0].task.status,'doing');
 assert.equal(issue.nativeCompleted,false);
});

test('explicit delivery is the only card across lanes while all native records remain available',()=>{
 const p={...parent('11','u'),myNodes:[{id:'n',phase:'current',ownerCount:1}],localTaskIds:['delivery']};
 const local={...task('delivery','waiting',['11']),startedAt:'2026-09-26T10:00:00+08:00'};
 const raw=buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[local]},workbenchReport([p])));
 const before=JSON.stringify(raw),cards=viewModel.groupTaskEntries(raw),lanes=groupTaskEntriesByLane(cards);
 assert.deepEqual(cards.map(card=>card.key),['local:delivery']);assert.equal(lanes.doing.length,0);assert.equal(lanes.unstarted.length,1);
 assert.equal(cards[0].linkedFeishu[0].key,'parent:11');assert.equal(JSON.stringify(raw),before);assert.equal(p.myNodes[0].phase,'current');
});

test('one completed delivery represents its pending story and defect once as recheck without reopening it',()=>{
 const p={...parent('11','u'),myNodes:[{id:'n',phase:'current',ownerCount:1}],localTaskIds:['delivery']};
 const issue={...responsibility.items[0],workItemId:'33',title:'new issue title',actionability:'state_responsibility',nativeCompleted:false,localTaskIds:['delivery']};
 const local=task('delivery','done',['11','33']);
 const cards=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[local]},{...workbenchReport([p]),items:[issue]})));
 assert.deepEqual(cards.map(card=>card.key),['local:delivery']);assert.equal(cards[0].linkedFeishu.length,2);
 assert.equal(viewModel.taskEntryLane(cards[0]),'unstarted');assert.equal(viewModel.taskEntryStatusLabel(cards[0]),'待核对');
 assert.equal(cards[0].task.status,'done');assert.deepEqual(viewModel.taskEntryFilterStatuses(cards[0]),['待核对']);
 assert.deepEqual(filterTaskEntries(cards,'completed',''),[]);assert.equal(filterTaskEntries(cards,'unfinished','new issue title').length,1);
});

test('a completed delivery covers older Feishu flow evidence, while newer or undated responsibilities still need review',()=>{
 const p={...parent('11','u'),myNodes:[{id:'n',phase:'current',ownerCount:1}],currentNodes:[{name:'全量上线',ownerNames:['本人姓名']}],localTaskIds:['delivery'],updatedAt:'2026-09-26T09:00:00+08:00'};
 const issue={...responsibility.items[0],workItemId:'33',typeName:'缺陷',statusName:'已修复，待验收',actionability:'state_responsibility',nativeCompleted:false,localTaskIds:['delivery'],updatedAt:'2026-09-26T01:30:00Z'};
 const local=task('delivery','done',['11','33']);
 const cardsFor=()=>viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[local]},{...workbenchReport([p]),items:[issue]})));
 const cards=cardsFor();
 assert.equal(cards.length,1);assert.equal(viewModel.taskEntryLane(cards[0]),'completed');
 assert.equal(viewModel.taskEntryStatusLabel(cards[0]),'已完成');
 assert(cards[0].linkedFeishu.some(x=>x.statusLabel.includes('全量上线')&&x.statusLabel.includes('本人姓名')));
 assert(cards[0].linkedFeishu.some(x=>x.statusLabel==='飞书缺陷状态：已修复，待验收'));
 assert.equal(issue.nativeCompleted,false);assert.equal(local.status,'done');
 issue.updatedAt='2026-09-26T02:01:00Z';assert.equal(viewModel.taskEntryLane(cardsFor()[0]),'unstarted');
 issue.updatedAt=null;assert.equal(viewModel.taskEntryLane(cardsFor()[0]),'unstarted');
});

test('multiple verified deliveries sharing a work item stay independent and cancelled deliveries never auto-reactivate',()=>{
 const issue={...responsibility.items[0],workItemId:'33',nativeCompleted:false,localTaskIds:['a','b','cancelled']};
 const source={...responsibility,items:[issue],workbenchItems:[],localAssociated:[]};
 const cards=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[task('a','doing',['33']),task('b','todo',['33']),task('cancelled','cancelled',['33'])]},source)));
 assert.deepEqual(cards.map(card=>card.key).sort(),['local:a','local:b','local:cancelled']);
 assert.equal(viewModel.taskEntryLane(cards.find(card=>card.key==='local:cancelled')),'completed');
 const onlyCancelled=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[task('cancelled','cancelled',['33'])]},source)));
 assert(onlyCancelled.some(card=>card.key==='project:33'));assert.equal(onlyCancelled.find(card=>card.key==='local:cancelled').task.status,'cancelled');
});

test('an unbound matching numeric reference is not used to suppress a native card',()=>{
 const issue={...responsibility.items[0],workItemId:'33',localTaskIds:[]};
 const cards=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[task('delivery','doing',['33'])]},{...responsibility,items:[issue],workbenchItems:[],localAssociated:[]})));
 assert.deepEqual(cards.map(card=>card.key).sort(),['local:delivery','project:33']);
});

test('shared nodes are background, and an unrelated current child never reopens historical parent-linked deliveries',()=>{
 const p={...parent('11','u',[{...child('22',true),localTaskIds:['history']},child('23')]),
   myNodes:[{id:'n',phase:'current',ownerCount:5}],localTaskIds:['history']};
 const history=task('history','done',['11','22']);
 const cards=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[history]},workbenchReport([p]))));
 assert.equal(viewModel.taskEntryLane(cards.find(card=>card.key==='local:history')),'completed');
 const pending=cards.find(card=>card.key==='group:11');assert.deepEqual(pending.members.map(member=>member.key),['subtask:11:23']);
 assert.equal(viewModel.taskEntryLane(pending),'unstarted');
 const sharedOnly={...parent('44','u'),myNodes:[{id:'n',phase:'current',ownerCount:3}]};
 const report=workbenchReport([sharedOnly]);
 assert.equal(viewModel.workbenchPersonalState(sharedOnly),'shared');
 assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[]},report)),[]);
 assert.deepEqual(viewModel.trackedOpenFeishuItems(report).map(item=>item.item.workItemId),['44']);
 const childOnly={...parent('55','u',[child('66')]),myNodes:[],localTaskIds:['history']};
 const separate=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[history]},workbenchReport([childOnly]))));
 assert.equal(viewModel.taskEntryLane(separate.find(card=>card.key==='local:history')),'completed');
 assert.deepEqual(separate.find(card=>card.key==='group:55').members.map(member=>member.key),['subtask:55:66']);
});

test('unfinished local work stays active when native work ended, belongs to others, is shared or is only future participation',()=>{
 const cases=[
  {...parent('11','other'),flowFinished:true,myNodes:[],localTaskIds:['delivery']},
  {...parent('11','other'),myNodes:[],localTaskIds:['delivery']},
  {...parent('11','u'),myNodes:[{id:'n',phase:'current',ownerCount:4}],localTaskIds:['delivery']},
  {...parent('11','u'),myNodes:[{id:'n',phase:'upcoming',ownerCount:1}],localTaskIds:['delivery']},
 ];
 for(const native of cases){
  const local=task('delivery','doing',['11']);
  const cards=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[local]},workbenchReport([native]))));
  const delivery=cards.find(card=>card.key==='local:delivery');
  assert(delivery);assert.equal(viewModel.taskEntryLane(delivery),'doing');assert.equal(delivery.task.status,'doing');
 }
});

test('base and role ownership alone establish participation without claiming completion',()=>{
 const p={...parent('11','creator'),roleOwnerUserKeys:['u'],myNodes:[]};
 assert.equal(viewModel.workbenchParticipationLabel(p,'u'),'本人参与');
 assert.equal(viewModel.workbenchPersonalState(p),'unknown');
 assert.equal(viewModel.workbenchPersonalState(p,'state_responsibility'),'current');
 assert.deepEqual(viewModel.participatedOpenFeishuItems(workbenchReport([p])),[]);
});

test('personal completed, future, current and inconsistent child evidence use native phases',()=>{
 const p={...parent('11','u'),myNodes:[{id:'old',phase:'completed'}]};
 assert.equal(viewModel.workbenchPersonalState(p),'completed');
 assert.equal(viewModel.workbenchPersonalState({...p,myNodes:[...p.myNodes,{id:'next',phase:'upcoming'}]}),'future');
 assert.equal(viewModel.workbenchPersonalState({...p,myNodes:[...p.myNodes,{id:'now',phase:'current'}]},undefined,[task('done','done',['11'])]),'current');
 assert.equal(viewModel.workbenchPersonalState({...p,mySubtasks:[child('22',false,'completed')]}),'unknown');
 assert.equal(viewModel.workbenchPersonalState({...p,mySubtasks:[child('22',true,'completed')]}),'completed');
});

test('only native archive and finished flags close the whole workflow',()=>{
 const p=parent('11','u',[],'done');
 assert.equal(viewModel.workbenchFlowEnded(p),false);
 assert.equal(viewModel.workbenchParentStatusLabel(p),'流程进行中');
 assert.equal(viewModel.workbenchFlowEnded({...p,flowFinished:true}),true);
 assert.equal(viewModel.workbenchParentStatusLabel({...p,isArchivedState:true}),'已归档');
});

test('directory numbers never create task associations or responsibility membership',()=>{
 const local={...task('local','doing'),taskDirectory:'D:/tasks/9001000011',taskDocumentPath:'D:/tasks/9001000011/task.md'};
 const issue={...responsibility.items[0],workItemId:'9001000011',localTaskIds:[]};
 const report={...responsibility,items:[issue],localAssociated:[],workbenchItems:[]};
 const view=buildWorkspaceConsoleView({...dashboard,tasks:[local]},report);
 assert.deepEqual(projectItemsForTask(local,report),[]);
 assert.deepEqual(buildTaskEntries(view,'local').map(e=>e.key),['local:local']);
 assert.deepEqual(buildTaskEntries(view,'uncertain'),[]);
 assert.deepEqual(buildTaskEntries(view,'feishu').map(e=>e.key),['project:9001000011']);
});

test('failed explicit verification remains visible in uncertain deliveries',()=>{
 const report={...responsibility,items:[],workbenchItems:[],localAssociated:[{workItemId:'33',localTaskIds:['a'],verified:false,error:'unresolved'}]};
 const view=buildWorkspaceConsoleView({...dashboard,tasks:[task('a','waiting',['33'])]},report);
 assert.deepEqual(buildTaskEntries(view,'uncertain').map(e=>e.key),['local:a']);
});

test('supplemental details do not invent personal participation',()=>{
 const report=workbenchReport([{...parent('11','u'),participated:false}]);
 const view=buildWorkspaceConsoleView({...dashboard,tasks:[task('a','doing',['11'])]},report);
 assert.deepEqual(buildTaskEntries(view).map(e=>e.key),['local:a']);
 assert.deepEqual(viewModel.trackedOpenFeishuItems(report),[]);
});

test('completed personal native work stays visible despite an active or paused local round',()=>{
 const p={...parent('11','u',[child('22',true,'completed')]),myNodes:[{id:'n1',phase:'completed'}]};
 for(const status of ['doing','paused','waiting','done']){
  const locals=[task('local',status,['11','22'])];
  assert.equal(viewModel.workbenchPersonalState(p,undefined,locals),'completed');
  assert.deepEqual(viewModel.participatedOpenFeishuItems(workbenchReport([p]),locals).map(e=>e.item.workItemId),['11']);
 }
});
