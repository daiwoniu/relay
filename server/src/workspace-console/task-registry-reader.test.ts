import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTaskRegistry } from './task-registry-reader.js';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-workspace-console-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('projects only task registry fields and structured Feishu ids', async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({
      schema_version: 1,
      generated_at: '2026-09-22T10:00:00+08:00',
      tasks: {
        'task-a': {
          kind: 'task', title: '任务 A', task_path: 'tasks/task-a', status: 'active', horizon: 'now',
          next_action: '继续验收', waiting_on: null, status_basis: '本地修复已完成，等待验收', verification: 'verified',
          last_verified_at: '2026-09-22T09:00:00+08:00', started_at: '2026-09-22T08:00:00+08:00', completed_at: null,
          feishu_work_item_ids: ['9001000007'], feishu_work_item_urls: { '9001000007': 'https://project.feishu.cn/demo-space/story/detail/9001000007', 'other': 'https://example.com/' }, secret_field: 'must-not-leak',
        },
      },
    }), 'utf8');
    const result = await readTaskRegistry(root);
    assert.deepEqual(result.tasks, [{
      id: 'task-a', kind: 'task', diagnostics: ['任务说明缺失或目录不可读取'], title: '任务 A', description: null, taskPath: 'tasks/task-a', status: 'active', horizon: 'now',
      nextAction: '继续验收', waitingOn: null, statusBasis: '本地修复已完成，等待验收', verification: 'verified',
      lastVerifiedAt: '2026-09-22T09:00:00+08:00', startedAt: '2026-09-22T08:00:00+08:00', completedAt: null, taskDocumentPath: null, taskPlanPath: null, taskDirectoryUpdatedAt:null, deliveryMatrix: [], feishuWorkItemIds: ['9001000007'], feishuWorkItemUrls: { '9001000007': 'https://project.feishu.cn/demo-space/story/detail/9001000007' },
    }]);
    assert.equal('secret_field' in result.tasks[0]!, false);
  });
});

test('directory update time is the validated folder mtime, never completion or guide-file time',async()=>{
 await withRoot(async root=>{
  const directory=path.join(root,'tasks','recent');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'README.md'),'# 任务');
  const timestamp=new Date('2026-11-01T12:00:00Z');await fs.utimes(directory,timestamp,timestamp);
  await fs.writeFile(path.join(root,'tasks','task-registry.json'),JSON.stringify({schema_version:1,tasks:{recent:{kind:'task',task_path:'tasks/recent',completed_at:'2026-11-20T12:00:00Z',status:'done'},outside:{kind:'task',task_path:'../outside',status:'done'},item:{kind:'item',status:'done'}}}));
  const result=await readTaskRegistry(root);
  assert.equal(result.tasks.find(task=>task.id==='recent')!.taskDirectoryUpdatedAt,timestamp.toISOString());
  assert.equal(result.tasks.find(task=>task.id==='outside')!.taskDirectoryUpdatedAt,null);
  assert.equal(result.tasks.find(task=>task.id==='item')!.taskDirectoryUpdatedAt,null);
 });
});

test('recovers an exact Feishu work item URL from the task guide when the registry has only its ID', async () => {
  await withRoot(async (root) => {
    const taskRoot = path.join(root, 'tasks', 'issue-task');
    await fs.mkdir(taskRoot, { recursive: true });
    await fs.writeFile(path.join(taskRoot, 'README.md'), '# 修复缺陷\n\n来源：[9001000018](https://project.feishu.cn/demo-space/issue/detail/9001000018)；其他项：[9999999999](https://project.feishu.cn/demo-space/story/detail/9999999999)\n', 'utf8');
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({ schema_version: 1, tasks: {
      'issue-task': { title: '修复缺陷', task_path: 'tasks/issue-task', status: 'done', feishu_work_item_ids: ['9001000018'] },
    } }), 'utf8');
    const result = await readTaskRegistry(root);
    assert.deepEqual(result.tasks[0]?.feishuWorkItemUrls, { '9001000018': 'https://project.feishu.cn/demo-space/issue/detail/9001000018' });
  });
});

test('retains a structured primary item only when it is a numeric member of all associations', async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, 'tasks'));
    const ids = ['9001000001', '9001000002'];
    const tasks = Object.fromEntries(['9001000002', '9001000003', 'invalid', 9001000001, null].map((primary, index) => [
      `task-${index}`, { title: '任务', status: 'waiting', feishu_work_item_ids: ids, feishu_primary_work_item_id: primary },
    ]));
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({ schema_version: 1, tasks }));
    const result = await readTaskRegistry(root);
    assert.equal(result.tasks[0]?.feishuPrimaryWorkItemId, '9001000002');
    assert(result.tasks.slice(1).every(task => task.feishuPrimaryWorkItemId === undefined));
    for (const task of result.tasks) {
      assert.deepEqual(task.feishuWorkItemIds, ids);
      assert.equal(task.status, 'waiting');
    }
  });
});

test('uses a Chinese README task name and a scope sentence when registry title is an ID', async () => {
  await withRoot(async (root) => {
    const taskId = 'feishu-9001000021-tanji-limit-consume-match-fix';
    const taskRoot = path.join(root, 'tasks', taskId);
    await fs.mkdir(taskRoot, { recursive: true });
    await fs.writeFile(path.join(taskRoot, 'README.md'), `# ${taskId}\n\n## 任务归属\n- 飞书任务：\`9001000021\`\n- 任务名称：优化限高数据下架逻辑及指标说明\n\n## 修复范围\n增量限高上下架比对按人员、案号、立案日期和主体匹配，避免不同企业记录连坐。\n\n## 当前情况\n已完成代码交付。\n`, 'utf8');
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({
      schema_version: 1, generated_at: null,
      tasks: { [taskId]: { title: taskId, task_path: `tasks/${taskId}`, status: 'waiting', status_basis: '等待产品验收', next_action: '推动验收', feishu_work_item_ids: ['9001000021'] } },
    }), 'utf8');
    const [task] = (await readTaskRegistry(root)).tasks;
    assert.equal(task?.title, '优化限高数据下架逻辑及指标说明');
    assert.equal(task?.description, '增量限高上下架比对按人员、案号、立案日期和主体匹配，避免不同企业记录连坐。');
    assert.equal(task?.statusBasis, '等待产品验收');
  });
});

test('keeps a Chinese registry title and reads an explicit task goal', async () => {
  await withRoot(async (root) => {
    const taskRoot = path.join(root, 'tasks', 'task-a');
    await fs.mkdir(taskRoot, { recursive: true });
    await fs.writeFile(path.join(taskRoot, 'README.md'), '# 旧标题\n- 任务目标：为两个服务实现公共网关客户端。\n## 当前进展\n已完成。\n', 'utf8');
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({
      schema_version: 1, generated_at: null,
      tasks: { 'task-a': { title: 'AI 网关公共客户端', task_path: 'tasks/task-a', status: 'doing', status_basis: '已完成部分开发', feishu_work_item_ids: [] } },
    }), 'utf8');
    const [task] = (await readTaskRegistry(root)).tasks;
    assert.equal(task?.title, 'AI 网关公共客户端');
    assert.equal(task?.description, '为两个服务实现公共网关客户端。');
  });
});

test('does not reuse a current-progress paragraph as the task description', async () => {
  await withRoot(async (root) => {
    const taskRoot = path.join(root, 'tasks', 'task-a');
    await fs.mkdir(taskRoot, { recursive: true });
    await fs.writeFile(path.join(taskRoot, 'README.md'), '# 任务 A\n## 当前情况\n已完成代码开发，等待验收。\n', 'utf8');
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({ schema_version: 1, tasks: {
      'task-a': { title: '任务 A', task_path: 'tasks/task-a', status_basis: '已完成代码开发', feishu_work_item_ids: [] },
    } }), 'utf8');
    const [task] = (await readTaskRegistry(root)).tasks;
    assert.equal(task?.description, null);
    assert.equal(task?.statusBasis, '已完成代码开发');
  });
});

test('projects a verified delivery matrix without trusting arbitrary paths', async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, 'tasks', 'task-a', 'project-results'), { recursive: true });
    await fs.writeFile(path.join(root, 'tasks', 'task-a', 'README.md'), '# task\n', 'utf8');
    await fs.writeFile(path.join(root, 'tasks', 'task-a', 'project-results', 'delivery-matrix.json'), JSON.stringify({
      schema_version: 1,
      generated_at: '2026-09-22T10:00:00+08:00',
      projects: [{ project: 'Web', base_branch: 'prod', feature_branch: 'feature/demo', target_branch: 'test', revision: 'abc123', source: 'tasks/task-a/README.md', verified_at: '2026-09-22T09:00:00+08:00' }],
    }), 'utf8');
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({
      schema_version: 1, generated_at: null,
      tasks: { 'task-a': { kind: 'task', title: 'A', task_path: 'tasks/task-a', status: 'doing', horizon: 'now', next_action: '继续', waiting_on: null, verification: 'verified', last_verified_at: null, feishu_work_item_ids: [] } },
    }), 'utf8');
    const result = await readTaskRegistry(root);
    assert.equal(result.tasks[0]!.taskDocumentPath, path.join(root, 'tasks', 'task-a', 'README.md'));
    assert.deepEqual(result.tasks[0]!.deliveryMatrix, [{ project: 'Web', baseBranch: 'prod', featureBranch: 'feature/demo', targetBranch: 'test', revision: 'abc123', source: 'tasks/task-a/README.md', verifiedAt: '2026-09-22T09:00:00+08:00' }]);
  });
});

test('finds only existing task planning files and prefers a next-step document', async () => {
  await withRoot(async root => {
    const directory = path.join(root, 'tasks', 'task-a');
    await fs.mkdir(path.join(directory, 'implementation'), {recursive:true});
    await fs.writeFile(path.join(directory, 'implementation', 'application-side-technical-plan.md'), '# 实施计划');
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({schema_version:1,tasks:{'task-a':{task_path:'tasks/task-a'}}}));
    assert.equal((await readTaskRegistry(root)).tasks[0]!.taskPlanPath, path.join(directory, 'implementation', 'application-side-technical-plan.md'));
    await fs.writeFile(path.join(directory, 'NEXT.md'), '# 下一步');
    assert.equal((await readTaskRegistry(root)).tasks[0]!.taskPlanPath, path.join(directory, 'NEXT.md'));
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({schema_version:1,tasks:{'task-a':{task_path:'../outside'}}}));
    assert.equal((await readTaskRegistry(root)).tasks[0]!.taskPlanPath, null);
  });
});

test('does not read generated ACTIVE or ALL_TASKS as the source of truth', async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
    await fs.writeFile(path.join(root, 'tasks', 'ACTIVE.md'), '# generated active\n', 'utf8');
    await fs.writeFile(path.join(root, 'tasks', 'ALL_TASKS.md'), '# generated all\n', 'utf8');
    await assert.rejects(() => readTaskRegistry(root), /task-registry\.json/);
  });
});

test('reports a missing registry as a source error', async () => {
  await withRoot(async (root) => {
    await assert.rejects(() => readTaskRegistry(root), /task-registry\.json/);
  });
});

test('rejects invalid registry JSON', async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), '{broken', 'utf8');
    await assert.rejects(() => readTaskRegistry(root), /invalid JSON/);
  });
});
