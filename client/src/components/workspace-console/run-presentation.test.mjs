import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRun, describeRunCategory, describeRunListMetrics, describeRunMetrics, describeRunResult, describeBusinessResult, describeRunProgress, runMatchesFilter, formatRunDuration } from './run-presentation.ts';

test('run cards distinguish business runs from code checks without treating unknown records as results', () => {
  assert.equal(describeRunCategory(run({ source: 'remote-runner', runId: 'mapping-job' })), '执行记录');
  assert.equal(describeRunCategory(run({ source: 'remote-runner', target: 'maven-build' })), '代码检查');
  assert.equal(describeRunCategory(run({ runId: 'mapping-job', businessResult: { object: 'example_table' } })), '业务跑数');
  assert.equal(describeRunCategory(run({ runId: 'tests-2026', status: 'succeeded' })), '代码检查');
  assert.equal(describeRunCategory(run({ runId: 'misc-2026' })), '执行记录');
});

test('JUnit evidence presents real test results rather than business completion or preview mode',()=>{
 const passing=run({runId:'project-switch-contract',status:'succeeded',exitCode:0,mode:'dry-run',testResult:{framework:'junit',total:13,failures:0,errorTypes:[]}});
 assert.equal(describeRun(passing).title,'契约测试');assert.equal(describeRun(passing).outcome,'测试通过');assert.equal(describeRunCategory(passing),'代码检查');
 assert.match(describeRunResult(passing).facts.join(' '),/13 项测试通过/);assert.doesNotMatch(describeRunResult(passing).facts.join(' '),/业务完成情况未记录/);
 const failed={...passing,status:'failed',exitCode:1,testResult:{framework:'junit',total:11,failures:1,errorTypes:['NullPointerException']}};
 assert.equal(describeRun(failed).outcome,'测试失败');assert.match(describeRunResult(failed).facts.join(' '),/失败 1 项.*空指针异常/);
 assert.equal(runMatchesFilter({...failed,status:'succeeded',exitCode:0},'abnormal'),true);
 assert.notEqual(describeRun({...passing,status:'running',exitCode:null}).outcome,'测试通过');
 assert.notEqual(describeRun({...passing,status:'failed',exitCode:1}).outcome,'测试通过');
 const empty={...passing,testResult:{framework:'junit',total:0,failures:0,errorTypes:[]}};
 assert.equal(describeRun(empty).outcome,'未执行测试');assert.match(describeRunResult(empty).facts.join(' '),/未证明验证通过/);
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
  assert.equal(describeRunListMetrics(run({ updatedRows: 21, insertedRows: 0 })), '已更新 21 条 · 已插入 0 条');
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
    title: 'compile-20260914e', outcome: '仅发现目录，暂无运行结果', detail: null,
  });
});

test('uses recorded result before the directory name', () => {
  assert.deepEqual(describeRun(run({ runId: 'validator-20260914', status: 'succeeded', mode: 'execute', target: 'tests', exitCode: 0, summary: '退出码 0 · 用时 4 秒' })), {
    title: 'tests', outcome: '进程正常结束', detail: '退出码 0 · 用时 4 秒',
  });
});

test('does not infer success from exit code when final status is missing', () => {
  assert.deepEqual(describeRun(run({ runId: 'test-suite', exitCode: 0, summary: '退出码 0' })), {
    title: 'test-suite', outcome: '最终状态未记录', detail: '退出码 0',
  });
});

test('labels an unrecognized Run and preserves evidence without inventing a result', () => {
  assert.deepEqual(describeRun(run({ runId: 'stock-fix-insert-1', evidenceFiles: ['command.txt'] })), {
    title: 'stock-fix-insert-1', outcome: '结果未记录', detail: null,
  });
  assert.equal(describeRun(run({ runId: 'custom-job' })).title, 'custom-job');
});

test('keeps a recorded but unfamiliar status visible', () => {
  assert.equal(describeRun(run({ status: 'skipped', evidenceFiles: ['status.json'] })).outcome, 'skipped');
});

test('remote runner presents known targets in Chinese while keeping repeated runs distinct by mode and time', () => {
  assert.deepEqual(describeRun(run({ source: 'remote-runner', target: 'tanji-executed-mapping-full', status: 'running' })), {
    title: '旧 ID 映射全量处理', outcome: '记录为运行中', detail: null,
  });
  assert.equal(describeRun(run({ source: 'remote-runner', target: 'tanji-executed-history-sample' })).title, '历史被执行人样本导出');
  assert.equal(describeRun(run({ source: 'remote-runner', target: 'tanji-executed-mapping-canary' })).title, '旧 ID 映射核查');
  assert.equal(describeRun(run({ source: 'remote-runner', target: 'unfamiliar-job' })).title, 'unfamiliar-job');
});

test('runner modes have Chinese labels without treating execute as a write result', async () => {
  const { describeRunMode } = await import('./run-presentation.ts');
  assert.equal(typeof describeRunMode, 'function');
  assert.equal(describeRunMode(run({ mode: 'dry-run' })), '预演模式');
  assert.equal(describeRunMode(run({ mode: 'execute' })), '执行模式');
  assert.equal(describeRunMode(run({ mode: 'custom' })), 'custom');
});

test('remote running status does not imply a current heartbeat or finished business result', () => {
  assert.deepEqual(describeRunResult(run({ source: 'remote-runner', target: 'mapping-full', status: 'running', observedAt: '2026-10-09 20:36:05' })), {
    outcome: '记录为运行中', facts: ['运行状态以最近观测为准；所示结果来自本机已有文件'],
  });
});

test('remote success directs business verification to the owning task', () => {
  assert.deepEqual(describeRunResult(run({ source: 'remote-runner', target: 'mapping-full', status: 'succeeded', exitCode: 0 })), {
    outcome: '进程正常结束', facts: ['业务完成情况未记录'],
  });
});

test('details a data repair with recorded changes and verification', () => {
  assert.deepEqual(describeRunResult(run({ status: 'succeeded', mode: 'repair', updatedRows: 6807, insertedRows: 0, committed: true, verification: { rowCount: 7492, invalidDataStatusCount: 0 } })), {
    outcome: '进程正常结束', facts: ['更新 6,807 行，新增 0 行', '变更已提交', '核验 7,492 行，异常状态 0 行'],
  });
});

test('does not turn a successful test process into an unrecorded pass count', () => {
  assert.deepEqual(describeRunResult(run({ status: 'succeeded', mode: 'execute', target: 'tests', exitCode: 0 })), {
    outcome: '进程正常结束', facts: ['业务完成情况未记录'],
  });
});

test('states when a failed Run has no recorded cause', () => {
  assert.deepEqual(describeRunResult(run({ status: 'failed', mode: 'execute', target: 'tests', exitCode: 1 })), {
    outcome: '执行失败', facts: ['失败原因未记录'],
  });
});

const businessResult = (overrides = {}) => ({ source: 'summary', status: 'stopped', complete: false, businessWrite: false,
  stopReason: 'row_limit_reached', object: 'example_table', rowsPerSecond: null, rowLimit: null, limitPercent: null, etaSeconds: null, ...overrides });

test('successful capped scan stays distinct from full completion and is not an execution failure', () => {
  const item = run({ status: 'succeeded', mode: 'dry-run', businessResult: businessResult() });
  assert.equal(describeRunResult(item).outcome, '进程正常结束');
  assert.deepEqual(describeBusinessResult(item), ['达到本轮条数上限', '全量未完成', '记录注明未写入业务数据']);
  assert.equal(runMatchesFilter(item, 'abnormal'), false);
  assert.deepEqual(describeBusinessResult(run({ mode: 'dry-run' })), []);
  assert.equal(runMatchesFilter(run({ status: 'lost' }), 'abnormal'), true);
  assert.equal(runMatchesFilter(run({ status: 'running' }), 'running'), true);
  assert.equal(runMatchesFilter(run({ status: 'succeeded', businessResult: businessResult({ status: 'failed' }) }), 'abnormal'), true);
});

test('explicit operation name wins, and unknown targets remain distinguishable', () => {
  assert.equal(describeRun(run({ displayName: '候选边界只读复核', target: 'generic-task' })).title, '候选边界只读复核');
  assert.notEqual(describeRun(run({ target: 'judgement-load-probe' })).title, describeRun(run({ target: 'notice-load-probe' })).title);
  assert.equal(describeRun(run({ status: 'prepared' })).outcome, '已准备');
  assert.equal(describeRun(run({ status: 'stopped' })).outcome, '已停止');
});

test('ETA and percentage refer only to this run limit, never a whole-task progress estimate', () => {
  const item = run({ businessResult: businessResult({ source: 'progress', rowsPerSecond: 1234.5, rowLimit: 100000, limitPercent: 50, etaSeconds: 60 }) });
  assert.deepEqual(describeRunProgress(item), ['记录速度 1,234.5 条/秒', '本轮上限 100,000 条', '本轮限额进度 50%', '记录预计距本轮上限 1 分钟']);
  assert.deepEqual(describeRunProgress(run({ businessResult: businessResult({ limitPercent: 50, etaSeconds: 60 }) })), []);
});
