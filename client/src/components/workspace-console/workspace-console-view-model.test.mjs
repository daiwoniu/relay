import assert from 'node:assert/strict';
import test from 'node:test';
import * as viewModel from './workspace-console-view-model.ts';
const { buildWorkspaceConsoleView, buildWorkspaceSummary, buildTaskEntries, filterTaskEntries, filterTaskLanesByStatus, groupTaskEntriesByLane, selectFocusTasks, selectTaskAction, runsForTask, projectItemsForTask, formatObservedDuration, projectTaskCardDetails } = viewModel;

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

test('completion notices distinguish role inference, old snapshots, ledger records, child results and role conflicts without moving lanes', () => {
  const inferred = { ...responsibility.items[0], workItemId: '9001000001', typeName: '缺陷',
    actionability: 'state_responsibility', statusName: '已修复，待验收', personalSubtasks: [], localTaskIds: [],
    myRoleKeys: ['operator'], baseOwnerIsMe: false };
  const notice = (item, tasks = []) => viewModel.personalIssueCompletionNotice(item, tasks);
  assert.match(notice(inferred), /推断/);
  const { myRoleKeys, baseOwnerIsMe, ...legacy } = inferred;
  assert.match(notice(legacy), /旧报表缺少本人责任/);
  const ledger = task('local-completed', 'done', [inferred.workItemId]);
  assert.match(notice(inferred, [ledger]), /台账登记/);
  assert.match(notice({ ...inferred, personalSubtasks: [{ id: 'child', name: '修复', passed: true }] }), /子任务已完成/);
  assert.match(notice({ ...inferred, myRoleKeys: ['operator', 'acceptor'] }, [ledger]), /请核对本轮责任范围/);
  assert.equal(notice({ ...inferred, myRoleKeys: ['operator', 'acceptor'] }), null);
  assert.equal(notice(inferred, [{ ...ledger, status: 'waiting' }]), null);
  const snapshot = { ...responsibility, items: [inferred], workbenchItems: [], localAssociated: [] };
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, snapshot));
  assert.equal(viewModel.taskEntryLane(entries[0]), 'completed');
  assert.deepEqual(filterTaskEntries(entries, 'completed', '').map(e => e.key), ['project:9001000001']);
  assert.deepEqual(viewModel.trackedOpenFeishuItems(snapshot).map(e => e.item.workItemId), [inferred.workItemId]);
  const fresh = { ...snapshot, items: [{ ...inferred, myRoleKeys: ['operator', 'acceptor'] }] };
  const afterRefresh = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, fresh));
  assert.equal(viewModel.taskEntryLane(afterRefresh[0]), 'unstarted');
  assert.equal(notice(fresh.items[0]), null);
  assert.deepEqual(viewModel.trackedOpenFeishuItems(fresh), []);
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

test('a finished defect stays separate from its linked active story and local ledger', () => {
  const storyId = '9001000012';
  const issueId = '9001000009';
  const issue = { ...responsibility.items[0], workItemId: issueId, typeName: '缺陷', statusName: '转需求',
    linkedStoryIds: [storyId], localTaskIds: ['issue-ledger'] };
  const report = { ...workbenchReport([parent(storyId, 'u')]), items: [issue] };
  const entries = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(
    { ...dashboard, tasks: [task('issue-ledger', 'waiting', [issueId])] }, report,
  )));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [`group:${storyId}`, `local:issue-ledger`, `project:${issueId}`]);
  assert.deepEqual(groupTaskEntriesByLane(entries).completed.map((entry) => entry.key), [`project:${issueId}`]);
  assert.deepEqual(filterTaskEntries(entries, 'completed', '').map((entry) => entry.key), [`project:${issueId}`]);
  assert.deepEqual(filterTaskEntries(entries, 'waiting', '').map((entry) => entry.key), ['local:issue-ledger']);
});

test('an unfinished defect with an active linked ledger has one pending card', () => {
  const issueId = '9001000020';
  const issue = { ...responsibility.items[0], workItemId: issueId, title: '【法院公告】案由优化',
    typeName: '缺陷', statusName: '处理中', actionability: 'state_responsibility', localTaskIds: ['notice-ledger'] };
  const report = { ...responsibility, items: [issue], localAssociated: [] };
  const local = { ...dashboard, tasks: [{ ...task('notice-ledger', 'waiting', [issueId]), title: '送达公告案由优化' }] };
  const view = buildWorkspaceConsoleView(local, report);
  const entries = buildTaskEntries(view);
  assert.deepEqual(entries.map((entry) => entry.key), ['local:notice-ledger']);
  assert.deepEqual(groupTaskEntriesByLane(entries).unstarted.map((entry) => entry.key), ['local:notice-ledger']);
  assert.deepEqual(projectItemsForTask(local.tasks[0], report).map((item) => item.workItemId), [issueId]);
  assert.deepEqual(buildTaskEntries(view, 'feishu').map((entry) => entry.key), ['local:notice-ledger']);
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

const task = (id, status, ids = []) => ({ id, title: id, status, completedAt: status === 'done' ? '2026-09-26T10:00:00+08:00' : null, feishuWorkItemIds: ids, runIds: [], sessionIds: [] });
const dashboard = { registryGeneratedAt: '2026-09-26T10:00:00+08:00', tasks: [task('a', 'done', ['123']), task('b', 'active', ['123'])], runs: [{ runId: 'orphan', taskId: 'missing', status: 'unknown' }], unmatchedRuns: [{ runId: 'orphan', taskId: 'missing', status: 'unknown' }], sessions: [{ sessionId: 'alone' }], unlinkedSessions: [{ sessionId: 'alone' }] };
const responsibility = { generatedAt: '2026-09-26T05:00:00+08:00', items: [{ workItemId: '123', title: '责任事项', actionability: 'current', localTaskIds: [], url: null }], localAssociated: [{ workItemId: '456', title: '关联事项', localTaskIds: ['b'], url: 'https://project.feishu.cn/demo-space/story/detail/456' }] };

const parent = (workItemId, ownerUserKey, mySubtasks = [], stateKey = 'doing', isArchivedState = false) => ({
  workItemId, title: `父项 ${workItemId}`, typeName: '需求', url: null, ownerUserKey,
  stateKey, isArchivedState, flowFinished: false, currentNodeNames: ['实施改造'], mySubtasks,
});
const child = (id, passed = false, phase = 'current') => ({ id, title: `子任务 ${id}`, owners: ['u'], passed, nodeId: 'n1', nodeName: '实施改造', phase });
const workbenchReport = (workbenchItems) => ({ ...responsibility, items: [], sourceUserKey: 'u', workbenchItems });

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

test('base owner without remaining assigned work stays completed until current responsibility arrives', () => {
  const owned = { ...parent('owner-only', 'u'), myNodes: [] };
  const report = workbenchReport([owned]);
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report).map((entry) => entry.item.workItemId), ['owner-only']);
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report));
  assert.equal(viewModel.taskEntryLane(entries[0]), 'completed');
  const pending = { ...report, items: [{ ...responsibility.items[0], workItemId: 'owner-only', actionability: 'current' }] };
  assert.deepEqual(viewModel.participatedOpenFeishuItems(pending), []);
  assert.deepEqual(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, pending))
    .map((entry) => entry.key), ['parent:owner-only']);
});

test('role and base owners without pending personal work appear once in participated items', () => {
  const role = { ...parent('9001000037', 'creator'), roleOwnerUserKeys: ['u', 'other'], myNodes: [] };
  const base = { ...parent('base-owner', 'u'), roleOwnerUserKeys: [], myNodes: [] };
  const report = workbenchReport([role, base]);
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report).map((entry) => entry.item.workItemId).sort(),
    ['9001000037', 'base-owner']);
  assert.ok(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report)).every((entry) => viewModel.taskEntryLane(entry) === 'completed'));
  for (const pending of [
    { ...role, myNodes: [{ id: 'n1', name: '研发', phase: 'current' }] },
    { ...role, mySubtasks: [child('pending')] },
  ]) {
    const active = workbenchReport([pending]);
    assert.deepEqual(viewModel.participatedOpenFeishuItems(active), []);
    assert.ok(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, active))
      .some((entry) => entry.key === 'parent:9001000037'));
  }
  assert.deepEqual(viewModel.participatedOpenFeishuItems(workbenchReport([{ ...role, flowFinished: true }])), []);
  const local = { ...dashboard, tasks: [task('pending-local', 'doing', ['9001000037'])] };
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report, local.tasks).map((entry) => entry.item.workItemId), ['base-owner']);
  assert.ok(buildTaskEntries(buildWorkspaceConsoleView(local, report)).some((entry) => entry.key === 'parent:9001000037'));
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

test('completed personal work and repaired issues remain in completed history without duplicate report parents', () => {
  const issue = { ...responsibility.items[0], workItemId: '9001000019', typeName: '缺陷',
    actionability: 'state_responsibility', statusName: '已修复，待验收', localTaskIds: [],
    myRoleKeys: ['operator'], baseOwnerIsMe: false };
  const pipeline = { ...parent('9001000003', 'other', [child('9001000028', true, 'current')]),
    myNodes: [{ id: 'n1', name: '实施改造', phase: 'current', ownerCount: 5 }] };
  const report = { ...workbenchReport([pipeline]), items: [issue,
    { ...responsibility.items[0], workItemId: pipeline.workItemId, actionability: 'current' }] };
  const local = { ...dashboard, tasks: [task('finished-issue', 'done', [issue.workItemId])] };
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report).map((entry) => `${entry.kind}:${entry.item.workItemId}`).sort(),
    ['parent:9001000003', 'project:9001000019']);
  const entries = buildTaskEntries(buildWorkspaceConsoleView(local, report));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), ['local:finished-issue', 'parent:9001000003', 'project:9001000019', 'subtask:9001000003:9001000028']);
  assert.ok(entries.every((entry) => viewModel.taskEntryLane(entry) === 'completed'));
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

test('an older cached issue keeps its existing bottom placement until the next report refresh', () => {
  const issue = { ...responsibility.items[0], workItemId: 'cached-issue', typeName: '缺陷',
    actionability: 'state_responsibility', statusName: '已修复，待验收', localTaskIds: [], personalSubtasks: [] };
  assert.deepEqual(viewModel.participatedOpenFeishuItems({ ...workbenchReport([]), items: [issue] })
    .map((entry) => entry.item.workItemId), ['cached-issue']);
});

test('owner parent remains visible without any child', () => {
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, workbenchReport([parent('11', 'u')])));
  assert.deepEqual(entries.map((entry) => entry.key), ['parent:11']);
  assert.equal(viewModel.taskEntryLane(entries[0]), 'unstarted');
});

test('groups an operator-owned issue under its verified story without losing the issue status or search ID', () => {
  const storyId = '9001000029';
  const issueId = '9001000032';
  const issue = { ...responsibility.items[0], workItemId: issueId, title: '账款评估入口缺陷', typeName: '缺陷',
    actionability: 'state_responsibility', linkedStoryIds: [storyId], localTaskIds: [],
    url: `https://project.feishu.cn/demo-space/issue/detail/${issueId}` };
  const report = { ...workbenchReport([parent(storyId, 'other', [child('9001000031', true, 'completed')])]), items: [issue] };
  const local = { ...dashboard, tasks: [task('story-ledger', 'waiting', [storyId])] };
  assert.deepEqual(viewModel.participatedOpenFeishuItems(report, local.tasks), []);
  const entries = buildTaskEntries(buildWorkspaceConsoleView(local, report));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [`local:story-ledger`, `project:${issueId}`, `subtask:${storyId}:9001000031`]);
  const groups = viewModel.groupTaskEntries(entries);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, `group:${storyId}`);
  assert.deepEqual(groups[0].members.map((entry) => entry.key).sort(), entries.map((entry) => entry.key).sort());
  assert.equal(viewModel.taskEntryLane(groups[0]), 'unstarted');
  assert.deepEqual(filterTaskEntries(groups, 'all', issueId).map((entry) => entry.key), [`group:${storyId}`]);
});

test('keeps a responsibility item outside a story group when its relation is ambiguous', () => {
  const issue = { ...responsibility.items[0], workItemId: '9001000032', typeName: '缺陷',
    linkedStoryIds: ['9001000029', '9001000030'], localTaskIds: [] };
  const report = { ...workbenchReport([parent('9001000029', 'u')]), items: [issue] };
  const groups = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report)));
  assert.deepEqual(groups.map((entry) => entry.key).sort(), ['group:9001000029', 'project:9001000032']);
});

test('keeps a linked issue as one distinct entry when the same issue is also a workbench parent', () => {
  const storyId = '9001000029';
  const issueId = '9001000032';
  const issue = { ...responsibility.items[0], workItemId: issueId, title: '关联缺陷', typeName: '缺陷',
    linkedStoryIds: [storyId], localTaskIds: [] };
  const issueParent = { ...parent(issueId, 'u'), typeName: '缺陷' };
  const report = { ...workbenchReport([parent(storyId, 'u'), issueParent]), items: [issue] };
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, report));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), [`parent:${storyId}`, `project:${issueId}`]);
  const groups = viewModel.groupTaskEntries(entries);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((entry) => entry.key).sort(), [`parent:${storyId}`, `project:${issueId}`]);
});

test('keeps a local ledger linked to the issue inside its related story group', () => {
  const storyId = '9001000029';
  const issueId = '9001000032';
  const issue = { ...responsibility.items[0], workItemId: issueId, title: '关联缺陷', typeName: '缺陷',
    linkedStoryIds: [storyId], localTaskIds: ['issue-ledger'] };
  const report = { ...workbenchReport([parent(storyId, 'u')]), items: [issue] };
  const local = { ...dashboard, tasks: [task('issue-ledger', 'doing', [issueId])] };
  const entries = buildTaskEntries(buildWorkspaceConsoleView(local, report));
  const groups = viewModel.groupTaskEntries(entries);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((entry) => entry.key).sort(), [`local:issue-ledger`, `parent:${storyId}`, `project:${issueId}`]);
  assert.equal(viewModel.taskEntryLane(groups[0]), 'doing');
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

test('one parent group keeps every own child and separates parent and child ledger links', () => {
  const local = { ...dashboard, tasks: [
    task('parent-ledger', 'waiting', ['11']),
    task('child-ledger', 'doing', ['11', '22']),
    task('unrelated', 'todo', ['99']),
  ] };
  const source = buildTaskEntries(buildWorkspaceConsoleView(local, workbenchReport([
    parent('11', 'other', [child('22', true, 'completed'), child('23', false, 'upcoming')]),
  ])));
  const grouped = viewModel.groupTaskEntries(source);
  const group = grouped.find((entry) => entry.key === 'group:11');
  assert.deepEqual(group.members.map((entry) => entry.key).sort(),
    ['local:child-ledger', 'local:parent-ledger', 'subtask:11:22']);
  assert.equal(viewModel.taskEntryLane(group), 'doing');
  assert.deepEqual(viewModel.groupLocalTasks(group), {
    parent: ['parent-ledger'], children: { '22': ['child-ledger'], '23': [] },
  });
  assert.deepEqual(viewModel.filterTaskEntries(grouped, 'all', '23').map((entry) => entry.key), ['group:11']);
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

test('a grouped waiting ledger remains available in the lane status filter', () => {
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [task('ledger', 'waiting', ['11'])] },
    workbenchReport([parent('11', 'other', [child('22', true, 'completed')])])));
  const group = viewModel.groupTaskEntries(entries)[0];
  const lanes = groupTaskEntriesByLane([group]);
  assert.deepEqual(viewModel.taskEntryFilterStatuses(group), ['等待中']);
  assert.deepEqual(filterTaskLanesByStatus(lanes, { unstarted: '等待中', doing: '', completed: '' }).unstarted.map((entry) => entry.key), ['group:11']);
});

test('group lane and primary action follow an unfinished local ledger before a current Feishu child', () => {
  const report = workbenchReport([parent('11', 'u', [child('22', false, 'current')])]);
  const grouped = (status) => viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(
    { ...dashboard, tasks: [task('ledger', status, ['22'])] }, report,
  )))[0];
  const waiting = grouped('waiting');
  assert.equal(viewModel.taskEntryLane(waiting), 'unstarted');
  assert.equal(viewModel.taskEntryStatusLabel(waiting), '等待中');
  assert.equal(viewModel.selectGroupPrimaryEntry(waiting).key, 'local:ledger');
  assert.deepEqual(groupTaskEntriesByLane([waiting]).unstarted.map((entry) => entry.key), ['group:11']);
  const completedLocal = grouped('done');
  assert.equal(viewModel.taskEntryLane(completedLocal), 'unstarted');
  assert.equal(viewModel.taskEntryStatusLabel(completedLocal), '待核对');
  assert.equal(viewModel.selectGroupPrimaryEntry(completedLocal).key, 'subtask:11:22');
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

test('native completion and archive status control lanes and labels', () => {
  const entries = buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks: [] }, workbenchReport([
    parent('11', 'u', [child('21', true), child('22', false, 'upcoming')], 'done'),
    parent('12', 'u', [], 'archived', true),
    { ...parent('13', 'u', [], null), currentNodeNames: [] },
  ])));
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  for (const [key, lane, label] of [
    ['subtask:11:21', 'completed', '已完成'],
    ['parent:11', 'completed', '已完成'], ['parent:12', 'completed', '已归档'],
    ['parent:13', 'unstarted', '状态待核对'],
  ]) {
    assert.equal(viewModel.taskEntryLane(byKey.get(key)), lane);
    assert.equal(viewModel.taskEntryStatusLabel(byKey.get(key)), label);
  }
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
  assert.equal(viewModel.workbenchSubtaskNodeLabel(child('1', false, 'current')), '当前节点：实施改造');
  assert.equal(viewModel.workbenchSubtaskNodeLabel(child('1', true, 'completed')), '已结束节点：实施改造');
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

test('Feishu view retains linked ledgers while local-only view keeps unmatched tasks', () => {
  const local = { ...dashboard, tasks: [task('linked', 'doing', ['123']), task('linked-by-report', 'waiting'), task('local-only', 'paused')] };
  const project = { ...responsibility, items: [
    { ...responsibility.items[0], workItemId: '123', title: '关联飞书', localTaskIds: ['linked'] },
    { ...responsibility.items[0], workItemId: '789', title: '独立飞书', localTaskIds: [] },
    { ...responsibility.items[0], workItemId: '999', title: '已有任务目录', localTaskIds: ['directory-only'] },
    { ...responsibility.items[0], workItemId: '456', title: '报表关联飞书', localTaskIds: ['linked-by-report'] },
  ], localAssociated: [] };
  const view = buildWorkspaceConsoleView(local, project);
  assert.deepEqual(buildTaskEntries(view).map((entry) => entry.key).sort(), ['local:linked', 'local:linked-by-report', 'local:local-only', 'project:789', 'project:999']);
  assert.deepEqual(buildTaskEntries(view, 'local').map((entry) => entry.key), ['local:local-only']);
  const feishu = buildTaskEntries(view, 'feishu');
  assert.deepEqual(feishu.map((entry) => entry.key).sort(), ['local:linked', 'local:linked-by-report', 'project:789', 'project:999']);
  assert.deepEqual(groupTaskEntriesByLane(feishu).unstarted.map((entry) => entry.key).sort(), ['local:linked-by-report', 'project:789', 'project:999']);
  assert.deepEqual(filterTaskEntries(feishu, 'all', '独立').map((entry) => entry.key), ['project:789']);
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

test('a work item ID in a task directory belongs to the uncertain association filter', () => {
  const local = { ...dashboard, tasks: [{ ...task('directory-task', 'waiting'), taskPath: 'tasks/feishu-9001000002-review' }] };
  const report = { ...responsibility, items: [{ ...responsibility.items[0], workItemId: '9001000002', localTaskIds: [] }], localAssociated: [] };
  const view = buildWorkspaceConsoleView(local, report);
  assert.deepEqual(buildTaskEntries(view, 'feishu'), []);
  assert.deepEqual(buildTaskEntries(view, 'local'), []);
  assert.deepEqual(buildTaskEntries(view, 'uncertain').map((entry) => entry.key), ['local:directory-task']);
  assert.deepEqual(buildTaskEntries(view).map((entry) => entry.key), ['local:directory-task']);
  assert.deepEqual(projectItemsForTask(local.tasks[0], report).map((item) => item.workItemId), ['9001000002']);
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
    { id: 'open-old', passed: false },
    { id: 'open-new', passed: false },
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
    { id: 'child-1', title: '子任务一', passed: true },
    { id: 'child-2', title: '子任务二', passed: false },
  ]);
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

test('focus groups two active ledgers under their one Feishu child', () => {
  const local = { ...dashboard, tasks: [task('etl', 'doing', ['9001000024']), task('alert', 'waiting', ['9001000024'])] };
  const grouped = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,
    workbenchReport([parent('9001000005', 'other', [child('9001000024', false, 'current')])]))));
  assert.deepEqual(viewModel.selectFocusEntries(grouped).map((entry) => entry.key), ['group:9001000005']);
  assert.deepEqual(viewModel.focusGroupLocalTasks(grouped[0]).map((item) => item.id), ['etl', 'alert']);
  const filtered = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,
    workbenchReport([parent('9001000005', 'other', [child('9001000024', false, 'current')])])), 'feishu'));
  assert.deepEqual(filtered[0].members.filter((entry) => entry.kind === 'local').map((entry) => entry.task.id).sort(), ['alert', 'etl']);
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

test('group card action targets active work, then an available task for reprocessing', () => {
  const report = workbenchReport([parent('11', 'u', [child('22', false, 'current')])]);
  const makeGroup = (tasks) => viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({ ...dashboard, tasks }, report)))[0];
  assert.equal(viewModel.selectGroupPrimaryEntry(makeGroup([task('ledger', 'doing', ['22'])])).key, 'local:ledger');
  assert.equal(viewModel.selectGroupPrimaryEntry(makeGroup([task('ledger', 'done', ['22'])])).key, 'subtask:11:22');
  const finishedReport = workbenchReport([{ ...parent('11', 'u', [child('22', true, 'completed')], 'done'), flowFinished: true }]);
  const finished = viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(
    { ...dashboard, tasks: [task('ledger', 'done', ['22'])] }, finishedReport,
  )))[0];
  assert.equal(viewModel.selectGroupPrimaryEntry(finished).key, 'local:ledger');
});

test('a local task linked to a child opens the exact Feishu subtask with its title and ID', () => {
  const linked = task('etl', 'doing', ['9001000024']);
  const report = workbenchReport([{
    ...parent('9001000005', 'other', [child('9001000024', false, 'current')]),
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

test('recent run observation shows distinct tasks before older runs of the same task', () => {
  const runs = [
    { runId: 'a3', taskId: 'a' }, { runId: 'a2', taskId: 'a' },
    { runId: 'b1', taskId: 'b' }, { runId: 'a1', taskId: 'a' }, { runId: 'c1', taskId: 'c' },
  ];
  assert.deepEqual(viewModel.selectRecentRuns(runs, 4).map((item) => item.runId), ['a3', 'b1', 'c1', 'a2']);
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

test('all-task list keeps local history and standalone Project responsibility without duplicating linked items', () => {
  const local = { ...dashboard, tasks: [task('doing-task', 'doing', ['123']), task('finished-task', 'done')] };
  const project = { ...responsibility, items: [
    { ...responsibility.items[0], workItemId: '123', localTaskIds: ['doing-task'] },
    { ...responsibility.items[0], workItemId: '789', title: '仅 Project 责任', localTaskIds: [] },
  ] };
  const entries = buildTaskEntries(buildWorkspaceConsoleView(local, project));
  assert.deepEqual(entries.map((item) => item.key), ['local:finished-task', 'project:789', 'local:doing-task']);
  assert.deepEqual(filterTaskEntries(entries, 'unfinished', '').map((item) => item.key), ['project:789', 'local:doing-task']);
  assert.deepEqual(filterTaskEntries(entries, 'doing', '').map((item) => item.key), ['local:doing-task']);
  assert.deepEqual(filterTaskEntries(entries, 'completed', '').map((item) => item.key), ['local:finished-task']);
  assert.deepEqual(filterTaskEntries(entries, 'project', '789').map((item) => item.key), ['project:789']);
});

test('9001000037 completed personal work stays completed until the future application node activates', () => {
  const p = { ...parent('9001000037', 'other', [child('9001000040', true, 'completed')]), currentNodeNames: ['生产验收'],
    myNodes: [{id:'n1',name:'数据治理',phase:'completed'}, {id:'application',name:'衔接应用',phase:'upcoming'}] };
  const local = {...dashboard,tasks:[task('terminal-ledger','done',[p.workItemId])]};
  const report = {...workbenchReport([p]),items:[{...responsibility.items[0],workItemId:p.workItemId,actionability:'upcoming'}]};
  const grouped = (r) => viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,r)))[0];
  const complete = grouped(report);
  assert.equal(viewModel.taskEntryLane(complete),'completed');
  assert.equal(viewModel.taskEntryStatusLabel(complete),'本轮已完成');
  assert.equal(viewModel.taskEntryConflict(complete),null);
  assert.deepEqual(viewModel.futureFeishuItems(report,local.tasks),[]);
  const activated = {...report,workbenchItems:[{...p,myNodes:[p.myNodes[0],{...p.myNodes[1],phase:'current'}]}]};
  const pending = grouped(activated);
  assert.equal(viewModel.taskEntryLane(pending),'unstarted');
  assert.equal(viewModel.taskEntryStatusLabel(pending),'待核对');
  assert.match(viewModel.taskEntryConflict(pending),/新一轮/);
});

test('9001000036 local execution remains doing even after personal Feishu development completed', () => {
  const p={...parent('9001000036','other',[child('9001000039',true,'completed')]),myNodes:[{id:'n1',phase:'completed'}]};
  const entries=buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[task('running','doing',[p.workItemId])]},workbenchReport([p])));
  const group=viewModel.groupTaskEntries(entries)[0];
  assert.equal(viewModel.taskEntryLane(group),'doing');
  assert.equal(viewModel.taskEntryStatusLabel(group),'处理中');
  assert.equal(viewModel.selectGroupPrimaryEntry(group).key,'local:running');
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

test('a waiting branch cannot hide an independently executing sibling or an available new task', () => {
  const p=parent('parallel','other',[child('wait'),child('run'),child('new')]);
  const local={...dashboard,tasks:[task('waiting','waiting',['wait']),task('running','doing',['run'])]};
  const group=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,workbenchReport([p]))))[0];
  assert.equal(viewModel.taskEntryLane(group),'doing');
  assert.equal(viewModel.selectGroupPrimaryEntry(group).key,'local:running');
  const pending=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...local,tasks:local.tasks.slice(0,1)},workbenchReport([p]))))[0];
  assert.ok(['subtask:parallel:run','subtask:parallel:new'].includes(viewModel.selectGroupPrimaryEntry(pending).key));
  const allWaiting={kind:'local',key:'local:external',task:task('external','waiting')};
  assert.equal(viewModel.selectFocusEntries([allWaiting,pending])[0].key,'group:parallel');
});

test('paused-only work leaves focus while unknown or unfinished ended-node work remains pending review', () => {
  const paused={kind:'local',key:'paused',task:task('paused','paused')};
  const p={...parent('unknown','u'),myNodes:[{id:'x',phase:'unknown'}]};
  const unknown={kind:'parent',key:'parent:unknown',item:p};
  assert.equal(viewModel.taskEntryLane(unknown),'unstarted');
  assert.equal(viewModel.taskEntryStatusLabel(unknown),'状态待核对');
  assert.deepEqual(viewModel.selectFocusEntries([paused,unknown]).map(e=>e.key),['parent:unknown']);
});

test('old completed branch records do not conflict with its explicitly unfinished new local round', () => {
  const p={...parent('round','u',[child('c')]),myNodes:[{id:'n1',phase:'current',ownerCount:1}]};
  const group=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[task('old','done',['c']),task('new','doing',['c'])]},workbenchReport([p]))))[0];
  assert.equal(viewModel.taskEntryConflict(group),null);
  assert.equal(viewModel.taskEntryStatusLabel(group),'处理中');
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
  assert.deepEqual(viewModel.trackedOpenFeishuItems(report,[task('running','doing',['finished'])]).map(e=>e.item.workItemId).sort(),['future','project-next']);
});

test('a grouped pending defect is a primary action candidate instead of the old parent or completed work', () => {
  const p={...parent('story','u'),myNodes:[{id:'n1',phase:'current'}]};
  const issue={...responsibility.items[0],workItemId:'issue',typeName:'缺陷',title:'新缺陷',linkedStoryIds:['story']};
  const report={...workbenchReport([p]),items:[issue]};
  const group=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView({...dashboard,tasks:[]},report)))[0];
  assert.equal(viewModel.taskEntryLane(group),'unstarted');
  assert.equal(viewModel.selectGroupPrimaryEntry(group).key,'project:issue');
});

test('a paused branch leaves focus even when its covered parent node is current, but a new independent child stays visible', () => {
  const p={...parent('paused-parent','u'),myNodes:[{id:'n1',phase:'current'}]};
  const local={...dashboard,tasks:[{...task('paused-work','paused',[p.workItemId]),startedAt:'2026-11-01T00:00:00+08:00'}]};
  const group=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,workbenchReport([p]))))[0];
  assert.equal(viewModel.taskEntryLane(group),'doing');
  assert.deepEqual(viewModel.selectFocusEntries([group]),[]);
  const fresh=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,workbenchReport([{...p,mySubtasks:[child('new-work')]}]))))[0];
  assert.equal(viewModel.selectFocusEntries([fresh]).length,1);
  assert.equal(viewModel.selectGroupPrimaryEntry(fresh).key,'subtask:paused-parent:new-work');
  const ownChild={...p,mySubtasks:[child('paused-child')]};
  const childPaused={...local,tasks:[{...local.tasks[0],feishuWorkItemIds:['paused-child']}]};
  const childGroup=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(childPaused,workbenchReport([ownChild]))))[0];
  assert.deepEqual(viewModel.selectFocusEntries([childGroup]),[]);
});

test('an ended story cannot keep both a standalone active issue ledger and a duplicate pending issue card', () => {
  const p={...parent('ended-story','u'),flowFinished:true};
  const issue={...responsibility.items[0],workItemId:'new-issue',typeName:'缺陷',linkedStoryIds:[p.workItemId],localTaskIds:['issue-work']};
  const local={...dashboard,tasks:[task('issue-work','doing',['new-issue'])]};
  const groups=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,{...workbenchReport([p]),items:[issue]})));
  assert.deepEqual(groups.map(e=>e.key).sort(),['group:ended-story','local:issue-work']);
  assert.equal(viewModel.taskEntryLane(groups.find(e=>e.key==='local:issue-work')),'doing');
  assert.equal(viewModel.taskEntryLane(groups.find(e=>e.key==='group:ended-story')),'completed');
});

test('the grouping index keeps ambiguous shared children and numeric local IDs independent', () => {
  const report=workbenchReport([parent('11','other',[child('shared')]),parent('12','other',[child('shared')])]);
  const local={...dashboard,tasks:[task('ambiguous','doing',['shared']),task('11','todo')]};
  const groups=viewModel.groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(local,report)));
  assert.deepEqual(groups.map(e=>e.key).sort(),['group:11','group:12','local:11','local:ambiguous']);
  assert.ok(groups.filter(e=>e.kind==='group').every(e=>e.members.every(m=>m.kind!=='local')));
});

test('9001000038 completed defect and its completed ledger share one history card outside the ended story', () => {
  const p = { ...parent('9001000013', 'u'), flowFinished: true };
  const issue = { ...responsibility.items[0], workItemId: '9001000038', typeName: '缺陷',
    title: '司法案件询价评估企业角色重复', statusName: '已修复，待验收', actionability: 'state_responsibility',
    linkedStoryIds: [p.workItemId], localTaskIds: [], personalSubtasks: [], myRoleKeys: ['operator'], baseOwnerIsMe: false };
  const ledger = { ...task('feishu-9001000038-inquiry-subject', 'done', [issue.workItemId]), title: '询价评估时间线补充被执行人' };
  const view = buildWorkspaceConsoleView({ ...dashboard, tasks: [ledger] }, { ...workbenchReport([p]), items: [issue] });
  const entries = viewModel.groupTaskEntries(buildTaskEntries(view));
  assert.deepEqual(entries.map((entry) => entry.key).sort(), ['group:9001000013', 'project:9001000038']);
  assert.equal(groupTaskEntriesByLane(entries).completed.length, 2);
  const card = entries.find((entry) => entry.kind === 'project');
  assert.deepEqual(card.item.tasks.map((task) => task.id), [ledger.id]);
  assert.deepEqual(projectTaskCardDetails(card.item), { current: '本轮已完成', next: '等待后续验收或流程流转' });
  assert.deepEqual(filterTaskEntries(entries, 'completed', ledger.title).map((entry) => entry.key), [card.key]);
  assert.deepEqual(filterTaskEntries(entries, 'completed', ledger.id).map((entry) => entry.key), [card.key]);
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

test('completed project dedup preserves unfinished, shared and locally filtered ledgers', () => {
  const issue = { ...responsibility.items[0], workItemId: 'issue-a', typeName: '缺陷', statusName: '已修复',
    localTaskIds: ['ledger'], linkedStoryIds: ['ended-story'], personalSubtasks: [] };
  const report = { ...responsibility, items: [issue], workbenchItems: [], localAssociated: [] };
  const cards = (tasks, source = report, filter = 'all') => viewModel.groupTaskEntries(buildTaskEntries(
    buildWorkspaceConsoleView({ ...dashboard, tasks }, source), filter));
  assert.deepEqual(cards([task('ledger', 'done', ['issue-a'])]).map((entry) => entry.key), ['project:issue-a']);
  assert.equal(cards([task('ledger', 'waiting', ['issue-a'])]).length, 2);
  assert.equal(cards([task('ledger', 'done', ['issue-a', 'other'])]).length, 2);
  const shared = { ...report, items: [issue, { ...issue, workItemId: 'issue-b' }] };
  assert.equal(cards([task('ledger', 'done')], shared).length, 3);
  const localReport = { ...report, items: [{ ...issue, workItemId: 'other', localTaskIds: [] }] };
  assert.deepEqual(cards([task('local-only', 'done')], localReport, 'local').map((entry) => entry.key), ['local:local-only']);
});
