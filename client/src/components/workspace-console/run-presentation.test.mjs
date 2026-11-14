import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRun, describeRunCategory, describeRunListMetrics, describeRunMetrics, describeRunResult, formatRunDuration } from './run-presentation.ts';

test('run cards distinguish business runs from code checks without treating unknown records as results', () => {
  assert.equal(describeRunCategory(run({ source: 'remote-runner' })), '业务跑数');
  assert.equal(describeRunCategory(run({ runId: 'tests-2026', status: 'succeeded' })), '代码检查');
  assert.equal(describeRunCategory(run({ runId: 'misc-2026' })), '执行记录');
});

test('compact run counts prioritize planned work for preview and actual changes for execution', () => {
  const resultMetrics = { source: 'summary', items: [
    { label: '已扫描', value: 100000, kind: 'total' },
    { label: '计划修复', value: 98694, kind: 'total' },
    { label: '已更新', value: 428, kind: 'change' },
    { label: '已插入', value: 0, kind: 'change' },
    { label: '身份信息不一致', value: 1043, kind: 'condition' },
  ] };
  assert.equal(describeRunListMetrics(run({ mode: 'dry-run', resultMetrics })), '已扫描 100,000 条 · 计划修复 98,694 条');
  assert.equal(describeRunListMetrics(run({ mode: 'execute', resultMetrics })), '已更新 428 条 · 已扫描 100,000 条');
  assert.equal(describeRunListMetrics(run()), null);
});

test('summarizes recorded progress and keeps condition counts in the detail', () => {
  const metrics = { source: 'progress', items: [
    { label: '已扫描', value: 100000, kind: 'total' },
    { label: '计划修复', value: 98694, kind: 'total' },
    { label: '已更新', value: 0, kind: 'change' },
    { label: '身份信息不一致', value: 1043, kind: 'condition' },
  ] };
  assert.deepEqual(describeRunMetrics(run({ status: 'running', resultMetrics: metrics })), {
    sourceLabel: '执行进度', summary: '已扫描 100,000 条 · 计划修复 98,694 条 · 已更新 0 条 · 身份信息不一致 1,043 条',
    totals: ['已扫描 100,000 条', '计划修复 98,694 条', '已更新 0 条'],
    conditions: ['身份信息不一致 1,043 条'],
  });
});

test('formats run duration for the detail panel', () => {
  assert.equal(formatRunDuration(1993), '33 分 13 秒');
  assert.equal(formatRunDuration(3661), '1 小时 1 分 1 秒');
  assert.equal(formatRunDuration(0.812), '0.8 秒');
  assert.equal(formatRunDuration(60), '1 分钟');
  assert.equal(formatRunDuration(null), '未记录');
});

const run = (overrides = {}) => ({
  runId: 'compile-20260914e', status: 'unknown', taskId: 'task-a', source: 'task-runner',
  mode: null, target: null, startedAt: null, finishedAt: null, durationSeconds: null,
  exitCode: null, committed: null, insertedRows: null, updatedRows: null,
  summary: '暂无结果摘要', evidenceFiles: [], verification: null, ...overrides,
});

test('explains an empty legacy Run directory without claiming a run result', () => {
  assert.deepEqual(describeRun(run()), {
    title: '编译检查', outcome: '仅发现目录，暂无运行结果', detail: null,
  });
});

test('uses recorded result before the directory name', () => {
  assert.deepEqual(describeRun(run({ runId: 'validator-20260914', status: 'succeeded', mode: 'execute', target: 'tests', exitCode: 0, summary: '退出码 0 · 用时 4 秒' })), {
    title: '测试运行', outcome: '成功', detail: '退出码 0 · 用时 4 秒',
  });
});

test('does not infer success from exit code when final status is missing', () => {
  assert.deepEqual(describeRun(run({ runId: 'test-suite', exitCode: 0, summary: '退出码 0' })), {
    title: '测试运行', outcome: '最终状态未记录', detail: '退出码 0',
  });
});

test('labels an unrecognized Run and preserves evidence without inventing a result', () => {
  assert.deepEqual(describeRun(run({ runId: 'stock-fix-insert-1', evidenceFiles: ['command.txt'] })), {
    title: '修复运行', outcome: '结果未记录', detail: null,
  });
  assert.equal(describeRun(run({ runId: 'custom-job' })).title, '运行记录');
});

test('keeps a recorded but unfamiliar status visible', () => {
  assert.equal(describeRun(run({ status: 'skipped', evidenceFiles: ['status.json'] })).outcome, 'skipped');
});

test('remote runner presents known targets in Chinese while keeping repeated runs distinct by mode and time', () => {
  assert.deepEqual(describeRun(run({ source: 'remote-runner', target: 'tanji-executed-mapping-full', status: 'running' })), {
    title: '旧 ID 映射全量处理', outcome: '进行中', detail: null,
  });
  assert.equal(describeRun(run({ source: 'remote-runner', target: 'tanji-executed-history-sample' })).title, '历史被执行人样本导出');
  assert.equal(describeRun(run({ source: 'remote-runner', target: 'tanji-executed-mapping-canary' })).title, '旧 ID 映射核查');
  assert.equal(describeRun(run({ source: 'remote-runner', target: 'unfamiliar-job' })).title, '远程跑数任务');
});

test('runner modes have Chinese labels without treating execute as a write result', async () => {
  const { describeRunMode } = await import('./run-presentation.ts');
  assert.equal(typeof describeRunMode, 'function');
  assert.equal(describeRunMode(run({ mode: 'dry-run' })), '预演（不写入）');
  assert.equal(describeRunMode(run({ mode: 'execute' })), '执行');
  assert.equal(describeRunMode(run({ mode: 'custom' })), '其他模式');
});

test('remote running status does not imply a current heartbeat or finished business result', () => {
  assert.deepEqual(describeRunResult(run({ source: 'remote-runner', target: 'mapping-full', status: 'running', observedAt: '2026-10-09 20:36:05' })), {
    outcome: '进行中', facts: ['登记状态为进行中；本机尚未收集执行进度，是否仍在运行以最近核查为准'],
  });
});

test('remote success directs business verification to the owning task', () => {
  assert.deepEqual(describeRunResult(run({ source: 'remote-runner', target: 'mapping-full', status: 'succeeded', exitCode: 0 })), {
    outcome: '成功', facts: ['Runner 登记为成功；业务结果以所属任务的验收记录为准'],
  });
});

test('details a data repair with recorded changes and verification', () => {
  assert.deepEqual(describeRunResult(run({ status: 'succeeded', mode: 'repair', updatedRows: 6807, insertedRows: 0, committed: true, verification: { rowCount: 7492, invalidDataStatusCount: 0 } })), {
    outcome: '成功', facts: ['更新 6,807 行，新增 0 行', '变更已提交', '核验 7,492 行，异常状态 0 行'],
  });
});

test('does not turn a successful test process into an unrecorded pass count', () => {
  assert.deepEqual(describeRunResult(run({ status: 'succeeded', mode: 'execute', target: 'tests', exitCode: 0 })), {
    outcome: '成功', facts: ['未记录具体的测试通过数或业务结果'],
  });
});

test('states when a failed Run has no recorded cause', () => {
  assert.deepEqual(describeRunResult(run({ status: 'failed', mode: 'execute', target: 'tests', exitCode: 1 })), {
    outcome: '失败', facts: ['失败原因未记录'],
  });
});
