import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import { ensureWorkspaceSnapshotsTable } from '../db/workspace-snapshots.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
import { parseReportProfile, parseResponsibilityReport, projectPythonExecutable, ResponsibilityReportService } from './responsibility-report.js';

test('accepts only sanitized report timing and route counts from Python stdout', () => {
  const profile = parseReportProfile(JSON.stringify({ stage_ms: { responsibility: 12000, unknown: 9 },
    api_metrics: { calls: 22, json_calls: 4, wait_ms: 100, routes: {
      '/open_api/{scope}/work_item/{type}/query': { calls: 3, elapsed_ms: 900 },
      '/open_api/secret123/query': { calls: 1, elapsed_ms: 20 },
      '/open_api/{scope}/work_item/secret/query': { calls: 1, elapsed_ms: 20 },
    } } }));
  assert.deepEqual(profile, { stages: { responsibility: 12000 }, jsonCalls: 4, rateLimiterCalls: 22, rateWaitMs: 100,
    routes: [{ route: '/open_api/{scope}/work_item/{type}/query', calls: 3, elapsedMs: 900 }] });
  assert.equal(parseReportProfile('{invalid'), null);
});

test('Project responsibility uses the workspace Python with Shanghai timezone data', {
  skip: !existsSync(path.join(FIXED_WORKSPACE_PATH, '.runtime', 'conda-envs', 'py312', 'python.exe')),
}, async () => {
  const python = projectPythonExecutable(FIXED_WORKSPACE_PATH);
  const { stdout } = await promisify(execFile)(python, ['-c', 'from zoneinfo import ZoneInfo; print(ZoneInfo("Asia/Shanghai"))']);
  assert.equal(stdout.trim(), 'Asia/Shanghai');
});

const expected = { userKey: 'user-1', projectKey: 'project-1' };
const report = {
  report_kind: 'project_responsibility',
  todo_equivalent: false,
  report_id: 'report-1',
  generated_at: '2026-09-26T05:35:12+08:00',
  source_user_key: 'user-1',
  complete: true,
  integrity: { source_ids_exactly_once: true, retrieval_complete: true, classification_complete: true, source_complete: true, workbench_projection_complete: true },
  workbench_items: [{ work_item_id: '9001000003', project_key: 'project-1', name: '父工作项',
    updated_at: 1792050482045,
    work_item_type: 'story', type_name: '需求', owner_user_key: 'other-user',
    work_item_status: { state_key: 'doing', is_archived_state: false },
    flow_finished: false, current_node_names: ['实施改造'],
    current_nodes: [{ name: '实施改造', owner_names: ['张三', '李四'] }],
    work_item_url: 'https://project.feishu.cn/demo-space/story/detail/9001000003',
    my_subtasks: [{ id: '9001000028', name: '本人子任务', owners: ['user-1'], passed: false, node_id: 'n1', node_name: '实施改造', phase: 'current' }],
  }, { work_item_id: '9001000004', project_key: 'project-1', name: '无子任务父项',
    work_item_type: 'story', owner_user_key: 'user-1', work_item_status: { state_key: 'doing', is_archived_state: false },
    flow_finished: false, current_node_names: ['开发'], my_subtasks: [] }],
  items: [{
    work_item_id: '9001000015', project_key: 'project-1', name: '示例数据表', type_name: '需求',
    updated_at: 1792132410884,
    actionability: 'current', personal_subtasks: [{ id: '9001000017', name: '完成切换改造', passed: false }],
    shared_nodes: [{ name: '实施改造', status: 2 }],
    release: { effective_version: '2026/10/01 发版' },
    work_item_url: 'https://project.feishu.cn/demo-space/story/detail/9001000015',
  }],
  business_items: [{
    work_item_id: '9001000015', project_key: 'project-1', name: '示例数据表',
    local_tasks: [{ task_id: 'task-a' }, { task_id: 'task-b' }],
  }],
  summary: { current_items: 1, state_responsibility_items: 0, upcoming_items: 0 },
};

test('provider-only responsibility loads never hydrate or write through the legacy database',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'relay-responsibility-source-'));let calls=0;
  try{const source=new ResponsibilityReportService({workspaceRoot:root,expected,database:new Proxy({} as SQLiteDB,{get(){throw new Error('legacy cache must not be consulted');}}),runner:async(args)=>{
    calls++;if(args[0]==='todo-report')await writeFile(args[args.indexOf('--output')+1]!,JSON.stringify(report));return'';
  }});
    assert.deepEqual(await source.readIdentity(),expected);assert.equal((await source.loadFresh(expected)).sourceUserKey,expected.userKey);assert.equal(calls,2);
    await assert.rejects(source.loadFresh({...expected,userKey:'wrong-user'}),/RESPONSIBILITY_IDENTITY_CHANGED/);assert.equal(calls,2);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('projects current responsibility and preserves both local task IDs', () => {
  const result = parseResponsibilityReport(report, expected);
  assert.equal(result.items[0]?.workItemId, '9001000015');
  assert.equal(result.items[0]?.actionability, 'current');
  assert.deepEqual(result.items[0]?.localTaskIds, ['task-a', 'task-b']);
  assert.deepEqual(result.items[0]?.personalSubtasks, [{ id: '9001000017', name: '完成切换改造', passed: false }]);
  assert.equal(result.items[0]?.url, 'https://project.feishu.cn/demo-space/story/detail/9001000015');
  assert.equal(result.items[0]?.updatedAt, '2026-10-16T06:33:30.884Z');
  assert.equal(result.generatedAt, report.generated_at);
});

test('empty Project names use descriptions or a visible placeholder without dropping cards', () => {
  const empty = { ...report.items[0], name: '', description: '  客户售后跟进  ' };
  const unnamed = { ...report.workbench_items[1], name: '  ', description: '' };
  const local = { ...report.business_items[0], actionability: 'local_associated', name: null };
  const result = parseResponsibilityReport({ ...report, items: [empty],
    workbench_items: [{ ...report.workbench_items[0], name: '', my_subtasks: [
      { ...report.workbench_items[0].my_subtasks[0], name: '' } ] }, unnamed],
    business_items: [local] }, expected);
  assert.equal(result.items[0]?.title, '客户售后跟进');
  assert.equal(result.workbenchItems[0]?.title, '未填写名称（飞书任务 9001000003）');
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.title, '未填写名称（飞书任务 9001000028）');
  assert.equal(result.workbenchItems[1]?.title, '未填写名称（飞书任务 9001000004）');
  assert.equal(result.localAssociated[0]?.title, '未填写名称（飞书任务 9001000015）');
});

test('preserves a state-flow defect relation to its verified story', () => {
  const issue = { ...report.items[0], work_item_id: '9001000032', name: '账款评估入口缺陷',
    type_name: '缺陷', actionability: 'state_responsibility', personal_subtasks: [],
    linked_story_ids: ['9001000029'], status_name: '待处理', my_role_keys: ['operator'], base_owner_is_me: false,
    work_item_url: 'https://project.feishu.cn/demo-space/issue/detail/9001000032' };
  const result = parseResponsibilityReport({ ...report, items: [issue], business_items: [] }, expected);
  assert.deepEqual(result.items[0]?.linkedStoryIds, ['9001000029']);
  assert.equal(result.items[0]?.actionability, 'state_responsibility');
  assert.equal(result.items[0]?.statusName, '待处理');
  assert.deepEqual(result.items[0]?.myRoleKeys, ['operator']);
  assert.equal(result.items[0]?.baseOwnerIsMe, false);
});

test('projects workbench parents and verified own children independently', () => {
  const result = parseResponsibilityReport(report, expected);
  assert.equal(result.workbenchItems.length, 2);
  assert.deepEqual(result.workbenchItems[0]?.mySubtasks.map((task) => task.id), ['9001000028']);
  assert.deepEqual(result.workbenchItems[0]?.currentNodes, [{ name: '实施改造', ownerNames: ['张三', '李四'] }]);
  assert.equal(result.workbenchItems[0]?.ownerUserKey, 'other-user');
  assert.equal(result.workbenchItems[0]?.updatedAt, '2026-10-15T07:48:02.045Z');
  assert.deepEqual(result.workbenchItems[1]?.mySubtasks, []);
  assert.equal(result.workbenchItems[1]?.ownerUserKey, 'user-1');
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.nodeName, '实施改造');
  assert.deepEqual(result.workbenchItems[1]?.currentNodeNames, ['开发']);
});

test('accepts an open parent with completed personal nodes and no personal subtask', () => {
  const historical = { ...report.workbench_items[0], work_item_id: '9001000014', owner_user_key: 'other-user',
    work_item_url: 'https://project.feishu.cn/demo-space/story/detail/9001000014',
    my_subtasks: [], my_nodes: [{ id: 'n1', name: '研发', status: 3, owner_count: 1 }] };
  const result = parseResponsibilityReport({ ...report, workbench_items: [historical] }, expected);
  assert.deepEqual(result.workbenchItems[0]?.myNodes, [{ id: 'n1', name: '研发', phase: 'completed', ownerCount: 1 }]);
});

test('projects a closed node-flow parent without relying on its opaque status key', () => {
  const closed = { ...report.workbench_items[1], work_item_id: '9001000010',
    work_item_status: { state_key: 'can_b6fb_7', is_archived_state: false },
    flow_finished: true, finished_at: 1791947045123, current_node_names: [],
    my_subtasks: [{ id: '9001000028', name: '已完成子任务', owners: ['user-1'], passed: true,
      finished_at: 1791947045000, node_id: 'n1', node_name: '产品验收', phase: 'completed' }] };
  const result = parseResponsibilityReport({ ...report, workbench_items: [closed] }, expected);
  assert.equal(result.workbenchItems[0]?.flowFinished, true);
  assert.equal(result.workbenchItems[0]?.stateKey, 'can_b6fb_7');
  assert.equal(result.workbenchItems[0]?.finishedAt, '2026-10-14T03:04:05.123Z');
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.finishedAt, '2026-10-14T03:04:05.000Z');
});

test('preserves absolute child and parent timestamps already normalized by the collector', () => {
  const parent = { ...report.workbench_items[0], updated_at: 1792136734498,
    my_subtasks: [{ ...report.workbench_items[0].my_subtasks[0], passed: true,
      created_at: Date.parse('2026-10-13T15:03:24.010Z'), updated_at: Date.parse('2026-10-16T07:45:00Z'),
      finished_at: Date.parse('2026-10-14T15:03:24.010Z') }] };
  const result = parseResponsibilityReport({ ...report, workbench_items: [parent] }, expected);
  assert.equal(result.workbenchItems[0]?.updatedAt, '2026-10-16T07:45:34.498Z');
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.finishedAt, '2026-10-14T15:03:24.010Z');
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.createdAt, '2026-10-13T15:03:24.010Z');
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.updatedAt, '2026-10-16T07:45:00.000Z');
});

test('older workbench reports keep missing workflow and node names unknown', () => {
  const { flow_finished: _finished, current_node_names: _names, current_nodes: _currentNodes,
    my_subtasks: originalChildren, ...olderParent } = report.workbench_items[0];
  const { node_name: _nodeName, ...olderChild } = originalChildren[0];
  const result = parseResponsibilityReport({ ...report, workbench_items: [{ ...olderParent, my_subtasks: [olderChild] }] }, expected);
  assert.equal(result.workbenchItems[0]?.flowFinished, null);
  assert.deepEqual(result.workbenchItems[0]?.currentNodeNames, []);
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.nodeName, null);
});

test('keeps verified child when parent owner is unknown', () => {
  const item = { ...report.workbench_items[0], owner_user_key: null };
  const result = parseResponsibilityReport({ ...report, workbench_items: [item] }, expected);
  assert.equal(result.workbenchItems[0]?.ownerUserKey, null);
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.id, '9001000028');
});

test('keeps a complete workbench projection when legacy responsibility classification is incomplete', () => {
  const result = parseResponsibilityReport({ ...report, complete: false,
    integrity: { ...report.integrity, classification_complete: false },
    workbench_items: [{ ...report.workbench_items[0], owner_user_key: null }],
    unverified_items: [{ work_item_id: '9001000003', reason: 'owner_not_verified' }],
  }, expected);
  assert.equal(result.complete, false);
  assert.equal(result.unverifiedCount, 1);
  assert.deepEqual(result.workbenchItems[0]?.mySubtasks.map((child) => child.id), ['9001000028']);
});

test('classification diagnostics preserve counts without exposing raw unverified records', () => {
  const parsed = parseResponsibilityReport({ ...report, complete: false,
    integrity: { ...report.integrity, classification_complete: false, unverified_count: 1 },
    unverified_items: [{ work_item_id: '9001000003', reason: 'owner_not_verified', private_detail: 'not-for-client' }],
  }, expected);
  assert.equal(parsed.unverifiedCount, 1);
  assert.equal(parsed.stale, false);
  assert.equal(parsed.error, null);
  assert.ok(parsed.workbenchItems.length > 0);
  assert.equal(JSON.stringify(parsed).includes('private_detail'), false);
  assert.equal(Object.hasOwn(parseResponsibilityReport(report, expected), 'unverifiedCount'), false);
  assert.equal(parseResponsibilityReport({ ...report, unverified_items: [],
    integrity: { ...report.integrity, unverified_count: 0 } }, expected).unverifiedCount, 0);
});

test('classification diagnostics reject conflicting counts and invalid records containers', () => {
  for (const invalid of [
    { ...report, unverified_items: {} },
    { ...report, unverified_items: [{ work_item_id: '9001000003' }] },
    { ...report, unverified_items: [], integrity: { ...report.integrity, unverified_count: 1 } },
    { ...report, complete: false, unverified_items: [], integrity: { ...report.integrity, classification_complete: false } },
  ]) assert.throws(() => parseResponsibilityReport(invalid, expected), /待核实/);
});

test('shows an unfinished child in a completed node as a single unverified item', () => {
  const child = { ...report.workbench_items[0].my_subtasks[0], phase: 'completed', node_name: '产品研发' };
  const result = parseResponsibilityReport({ ...report, complete: false,
    integrity: { ...report.integrity, classification_complete: false },
    workbench_items: [{ ...report.workbench_items[0], my_subtasks: [child] }],
    unverified_items: [{ work_item_id: '9001000003', reason: 'unfinished_subtask_in_completed_node' }],
  }, expected);
  assert.equal(result.complete, false);
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.phase, 'completed');
  assert.equal(result.workbenchItems[0]?.mySubtasks[0]?.nodeName, '产品研发');
});

test('rejects incomplete, duplicate or untrusted workbench projection', () => {
  for (const invalid of [
    { ...report, integrity: { ...report.integrity, workbench_projection_complete: false } },
    { ...report, workbench_items: [...report.workbench_items, report.workbench_items[0]] },
    { ...report, workbench_items: [{ ...report.workbench_items[0], my_subtasks: [report.workbench_items[0].my_subtasks[0], report.workbench_items[0].my_subtasks[0]] }] },
    { ...report, workbench_items: [{ ...report.workbench_items[0], work_item_url: 'https://example.com/9001000003' }] },
  ]) assert.throws(() => parseResponsibilityReport(invalid, expected));
});

test('accepts a current Project responsibility report without the removed todo-equivalent field', () => {
  const { todo_equivalent: _removed, ...currentReport } = report;
  const result = parseResponsibilityReport(currentReport, expected);
  assert.equal(result.reportKind, 'project_responsibility');
  assert.equal(result.todoEquivalent, false);
  assert.throws(() => parseResponsibilityReport({ ...currentReport, todo_equivalent: true }, expected));
});

test('keeps locally associated business items outside current responsibility', () => {
  const extra = {
    work_item_id: '9001000001', project_key: 'project-1', name: '示例抽查',
    actionability: 'local_associated', local_task_id: 'task-c',
    work_item_url: 'https://project.feishu.cn/demo-space/story/detail/9001000001',
  };
  const result = parseResponsibilityReport({
    ...report, business_items: [...report.business_items, extra],
  }, expected);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.localAssociated, [{
    associationKey: '9001000001:1',
    workItemId: '9001000001', title: '示例抽查', localTaskIds: ['task-c'],
    url: 'https://project.feishu.cn/demo-space/story/detail/9001000001',
  }]);
});

test('resolves any child through its verified parent and node relationship', () => {
  const wrongRoute = 'https://project.feishu.cn/demo-space/sub_task/detail/9001000016';
  const childRoute = 'https://project.feishu.cn/demo-space/demo-type/detail/9001000003?activeStateId=state_3&subTaskId=9001000016';
  const item = { ...report.items[0], work_item_id: '9001000016', type_name: '需求', work_item_url: wrongRoute };
  const local = { work_item_id: '9001000016', project_key: 'project-1', name: '示例交付准备', type_name: '需求',
    actionability: 'local_associated', local_task_id: 'demo-delivery', work_item_url: wrongRoute };
  const parent = { ...report.workbench_items[0], work_item_id: '9001000003',
    work_item_url: 'https://project.feishu.cn/demo-space/demo-type/detail/9001000003',
    my_subtasks: [{ ...report.workbench_items[0].my_subtasks[0], id: '9001000016', node_id: 'state_3' }] };
  const input = { ...report, workbench_items: [parent], items: [item], business_items: [local] };
  const parsed = parseResponsibilityReport(input, expected);
  assert.equal(parsed.items[0]?.url, childRoute);
  assert.equal(parsed.localAssociated[0]?.url, childRoute);
  assert.equal(parseResponsibilityReport({ ...input, items: [{ ...item, work_item_url: childRoute }] }, expected).items[0]?.url, childRoute);
  assert.equal(parseResponsibilityReport({ ...input, items: [{ ...item, work_item_url: null }] }, expected).items[0]?.url, childRoute);
  assert.throws(() => parseResponsibilityReport({ ...input, items: [{ ...item, work_item_url: 'https://example.com/9001000016' }] }, expected), /链接未通过核验/);
});

test('preserves verified parent routes supplied by the source', () => {
  const item = { ...report.items[0], work_item_id: '9001000003', work_item_type: 'demo-type', work_item_url: 'https://project.feishu.cn/demo-space/b2b_pipeline/detail/9001000003' };
  const parsed = parseResponsibilityReport({ ...report, items: [item] }, expected);
  assert.equal(parsed.items[0]?.url, item.work_item_url);
});

test('keeps other subtask routes even when the report type says Story', () => {
  const route = 'https://project.feishu.cn/demo-space/sub_task/detail/9001000022';
  const item = { ...report.items[0], work_item_id: '9001000022', type_name: '需求', work_item_url: route };
  assert.equal(parseResponsibilityReport({ ...report, items: [item] }, expected).items[0]?.url, route);
});

test('accepts a verified subtask deep link whose path ends with its parent ID', () => {
  const route = 'https://project.feishu.cn/demo-space/demo-type/detail/9001000003?activeStateId=state_3&subTaskId=9001000022';
  const item = { ...report.items[0], work_item_id: '9001000022', work_item_type: 'sub_task', work_item_url: route };
  assert.equal(parseResponsibilityReport({ ...report, items: [item] }, expected).items[0]?.url, route);
  assert.throws(() => parseResponsibilityReport({ ...report, items: [{ ...item, work_item_url: route.replace('subTaskId=9001000022', 'subTaskId=9001000023') }] }, expected), /链接未通过核验/);
});

test('keeps separate local associations under the same Project parent', () => {
  const local = (taskId: string) => ({ work_item_id: '9001000001', project_key: 'project-1', name: `事项 ${taskId}`, actionability: 'local_associated', local_task_id: taskId, work_item_url: 'https://project.feishu.cn/demo-space/story/detail/9001000001' });
  const result = parseResponsibilityReport({ ...report, business_items: [...report.business_items, local('task-a'), local('task-b')] }, expected);
  assert.deepEqual(result.localAssociated.map((item) => item.localTaskIds), [['task-a'], ['task-b']]);
  assert.equal(new Set(result.localAssociated.map((item) => item.associationKey)).size, 2);
});

test('rejects incomplete, wrong-account, wrong-space and untrusted-link reports', () => {
  for (const invalid of [
    { ...report, complete: false },
    { ...report, source_user_key: 'other-user' },
    { ...report, items: [{ ...report.items[0], project_key: 'other-project' }] },
    { ...report, items: [{ ...report.items[0], work_item_url: 'https://example.com/9001000015' }] },
  ]) {
    assert.throws(() => parseResponsibilityReport(invalid, expected));
  }
});

test('shares a report read, caches it and cleans each generated pair by report ID', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-responsibility-'));
  let now = 1000;
  const calls: string[][] = [];
  const service = new ResponsibilityReportService({
    workspaceRoot, expected, now: () => now,
    runner: async (args) => {
      calls.push(args);
      const output = args[args.indexOf('--output') + 1]!;
      if (args[0] === 'todo-report') await writeFile(output, JSON.stringify(report), 'utf8');
      return '';
    },
  });
  try {
    const [first, concurrent] = await Promise.all([service.get(), service.get()]);
    assert.equal(first.items.length, 1);
    assert.equal(first.servedFromCache, false);
    assert.equal(concurrent.servedFromCache, false);
    assert.equal(concurrent.generatedAt, first.generatedAt);
    assert.equal((await service.get()).servedFromCache, true);
    assert.equal(calls.filter((args) => args[0] === 'todo-report').length, 1);
    now += 60 * 60_000 - 1;
    assert.equal((await service.get()).servedFromCache, true);
    assert.equal(calls.filter((args) => args[0] === 'todo-report').length, 1);
    now += 1;
    assert.equal((await service.get()).servedFromCache, true);
    assert.equal(calls.filter((args) => args[0] === 'todo-report').length, 1);
    assert.deepEqual(calls.find((args) => args[0] === 'cleanup-todo-report')?.slice(-2), ['--report-id', 'report-1']);
    now += 60_000;
    assert.equal((await service.get(true)).servedFromCache, false);
    assert.equal(calls.filter((args) => args[0] === 'todo-report').length, 2);
    assert.equal((await readFile(calls[0]![calls[0]!.indexOf('--output') + 1]!, 'utf8')).length > 0, true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('a forced refresh replaces an unnamed card with its later Project name', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-responsibility-title-'));
  let title = '';
  const service = new ResponsibilityReportService({ workspaceRoot, expected,
    runner: async (args) => {
      if (args[0] === 'todo-report') await writeFile(args[args.indexOf('--output') + 1]!,
        JSON.stringify({ ...report, items: [{ ...report.items[0], name: title }] }), 'utf8');
      return '';
    } });
  try {
    const first = await service.get(true);
    assert.equal(first.items[0]?.title, '未填写名称（飞书任务 9001000015）');
    assert.equal(first.sourceMeta?.state, 'live');
    title = '售后事项已补充标题';
    const refreshed = await service.get(true);
    assert.equal(refreshed.items[0]?.title, '售后事项已补充标题');
    assert.equal(refreshed.sourceMeta?.state, 'live');
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test('reports only phase, elapsed time and outcome for a forced read', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-responsibility-timing-'));
  const events: Array<{ phase: string; elapsedMs: number; outcome: string }> = [];
  const service = new ResponsibilityReportService({
    workspaceRoot, expected, diagnostic: (event) => events.push(event),
    runner: async (args) => {
      if (args[0] === 'todo-report') await writeFile(args[args.indexOf('--output') + 1]!, JSON.stringify(report), 'utf8');
      return '';
    },
  });
  try {
    await service.get(true);
    assert.deepEqual(events.map(({ phase, outcome }) => [phase, outcome]), [
      ['report', 'ok'], ['parse', 'ok'], ['cleanup', 'ok'], ['total', 'ok'],
    ]);
    assert.ok(events.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0));
    assert.ok(events.every((event) => Object.keys(event).sort().join(',') === 'elapsedMs,outcome,phase'));
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test('普通缓存读取进行中时强制刷新排队执行且只拉一次新报表', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-report-force-queue-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  let reads = 0;
  const service = new ResponsibilityReportService({ workspaceRoot, expected, runner: async (args) => {
    if (args[0] === 'todo-report') {
      reads++;
      await writeFile(args[args.indexOf('--output') + 1]!, JSON.stringify({ ...report, report_id: `report-${reads}` }));
    }
    return '';
  } });
  await service.get(true);
  const cached = service.get();
  const forced = service.get(true);
  assert.notEqual(cached, forced);
  assert.equal(service.get(true), forced);
  assert.equal((await cached).servedFromCache, true);
  assert.equal((await forced).servedFromCache, false);
  assert.equal(reads, 2);
});

test('a failed manual refresh keeps the old snapshot visibly stale for later reads', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-responsibility-stale-'));
  let reads = 0;
  const events: Array<{ phase: string; outcome: string }> = [];
  const service = new ResponsibilityReportService({ workspaceRoot, expected, now: () => 1000,
    diagnostic: ({ phase, outcome }) => events.push({ phase, outcome }), runner: async (args) => {
      if (args[0] === 'todo-report') {
        reads += 1;
        if (reads === 2) throw new Error('Project unavailable');
        await writeFile(args[args.indexOf('--output') + 1]!, JSON.stringify(report), 'utf8');
      }
      return '';
  } });
  try {
    assert.equal((await service.get()).stale, false);
    const failedRefresh = await service.get(true);
    assert.equal(failedRefresh.stale, true);
    assert.equal(failedRefresh.servedFromCache, true);
    const later = await service.get();
    assert.equal(later.stale, true);
    assert.match(later.error ?? '', /Project unavailable/);
    assert.equal(reads, 2);
    assert.deepEqual(events.slice(-2), [{ phase: 'report', outcome: 'error' }, { phase: 'total', outcome: 'error' }]);
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test('report persists across service instances and failed or incomplete refreshes keep its success time', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-responsibility-persist-'));
  const filename = path.join(workspaceRoot, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
    const database = new SQLiteDB(raw, filename);
    ensureWorkspaceSnapshotsTable(database);
    let now = 1000;
    let mode: 'success' | 'failure' | 'incomplete' | 'partial' = 'success';
    let reportReads = 0;
    const runner = async (args: string[]) => {
      if (args[0] === 'todo-report') {
        reportReads += 1;
        if (mode === 'failure') throw new Error('Project unavailable');
        const payload = mode === 'incomplete' ? { ...report, complete: false }
          : mode === 'partial' ? { ...report, complete: false,
            integrity: { ...report.integrity, classification_complete: false },
            unverified_items: [{ work_item_id: '9001000003', reason: 'unfinished_subtask_in_completed_node' }] }
            : report;
        await writeFile(args[args.indexOf('--output') + 1]!, JSON.stringify(payload), 'utf8');
      }
      return '';
    };
    const service = new ResponsibilityReportService({ workspaceRoot, expected, database, now: () => now, runner });
    const first = await service.get();
    assert.equal(first.sourceMeta?.state, 'live');
    assert.equal(first.fetchedAt, 1000);

    const reopened = new SQLiteDB(new SQL.Database(await readFile(filename)), filename);
    const restarted = new ResponsibilityReportService({ workspaceRoot, expected, database: reopened, now: () => now, runner });
    const snapshot = await restarted.get();
    assert.equal(snapshot.items[0]?.workItemId, first.items[0]?.workItemId);
    assert.equal(snapshot.sourceMeta?.state, 'snapshot');
    assert.equal(snapshot.sourceMeta?.lastSuccessAt, 1000);
    assert.equal(reportReads, 1);

    now = 2000;
    mode = 'failure';
    const failed = await restarted.get(true);
    assert.equal(failed.sourceMeta?.state, 'failed_snapshot');
    assert.equal(failed.sourceMeta?.lastSuccessAt, 1000);
    assert.equal(failed.sourceMeta?.lastAttemptAt, 2000);
    assert.equal(failed.fetchedAt, 1000);

    now = 3000;
    mode = 'incomplete';
    const incomplete = await restarted.get(true);
    assert.equal(incomplete.sourceMeta?.state, 'failed_snapshot');
    assert.equal(incomplete.sourceMeta?.lastSuccessAt, 1000);
    const afterIncomplete = new ResponsibilityReportService({ workspaceRoot, expected, database: reopened, now: () => now, runner });
    assert.equal((await afterIncomplete.get()).complete, true);
    assert.equal((await afterIncomplete.get()).fetchedAt, 1000);

    now = 4000;
    mode = 'partial';
    const partial = await afterIncomplete.get(true);
    assert.equal(partial.complete, false);
    assert.equal(partial.sourceMeta?.state, 'live');
    const afterPartial = new ResponsibilityReportService({ workspaceRoot, expected, database: reopened, now: () => now, runner });
    const partialSnapshot = await afterPartial.get();
    assert.equal(partialSnapshot.complete, false);
    assert.equal(partialSnapshot.sourceMeta?.state, 'snapshot');
    assert.equal(partialSnapshot.workbenchItems.length, partial.workbenchItems.length);
    assert.equal(partialSnapshot.fetchedAt, 4000);

    now = 5000;
    mode = 'failure';
    const partialFailure = await afterPartial.get(true);
    assert.equal(partialFailure.sourceMeta?.state, 'failed_snapshot');
    assert.equal(partialFailure.complete, false);
    assert.equal(partialFailure.sourceMeta?.lastSuccessAt, 4000);

    const otherIdentity = new ResponsibilityReportService({ workspaceRoot,
      expected: { userKey: 'other-user', projectKey: expected.projectKey }, database: reopened, now: () => now, runner });
    await assert.rejects(() => otherIdentity.get());
    assert.equal(reportReads, 6);
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test('preserves verified reporter or creator names without treating them as node owners', () => {
  for (const role of ['reporter', 'creator']) {
    const item = { ...report.items[0], fallback_contact: { role, names: ['张三', '姓名未知(user-2)'] } };
    const result = parseResponsibilityReport({ ...report, items: [item] }, expected);
    assert.deepEqual(result.items[0]?.fallbackContact, { role, names: ['张三', '姓名未知(user-2)'] });
  }
  for (const fallback_contact of [{ role: 'owner', names: ['张三'] }, { role: 'reporter', names: [] },
    { role: 'creator', names: [''] }]) {
    assert.throws(() => parseResponsibilityReport({ ...report, items: [{ ...report.items[0], fallback_contact }] }, expected), /报告人或创建人/);
  }
});


test('accepts role-only participation and rejects unrelated or malformed role owners', () => {
  const parent = { ...report.workbench_items[1], owner_user_key: 'creator', my_nodes: [],
    role_owner_user_keys: ['user-1', 'user-1', 'other'] };
  const result = parseResponsibilityReport({ ...report, workbench_items: [parent] }, expected);
  assert.equal(result.workbenchItems[0]?.ownerUserKey, 'creator');
  assert.deepEqual(result.workbenchItems[0]?.roleOwnerUserKeys, ['user-1', 'other']);
  for (const role_owner_user_keys of [['other'], []]) {
    assert.throws(() => parseResponsibilityReport({ ...report, workbench_items: [
      { ...parent, role_owner_user_keys },
    ] }, expected), /缺少本人责任/);
  }
  for (const role_owner_user_keys of ['user-1', [123], ['']]) {
    assert.throws(() => parseResponsibilityReport({ ...report, workbench_items: [
      { ...parent, role_owner_user_keys },
    ] }, expected), /角色负责人无效/);
  }
});
