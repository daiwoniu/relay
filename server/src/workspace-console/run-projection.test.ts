import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRunRecord } from './run-projection.js';

test('formats long run duration in hours, minutes and seconds', () => {
  const result = projectRunRecord({ status: 'succeeded', exit_code: 0, elapsed_seconds: 1993 }, 'run-1', 'task-a', []);
  assert.equal(result.durationSeconds, 1993);
  assert.equal(result.summary, '退出码 0 · 用时 33 分 13 秒');
});

test('uses explicit operation names and does not mistake heartbeat for completion', () => {
  const result = projectRunRecord({ status: 'running', started_at: '2026-11-20 09:00:00', updated_at: '2026-11-20 09:01:00' }, 'run', 'task', [],
    { notification: { display_name: '新增裁判文书候选边界只读复核' }, command: 'private command' });
  assert.equal(result.displayName, '新增裁判文书候选边界只读复核');
  assert.equal(result.finishedAt, null);
  assert.equal(result.durationSeconds, null);
  assert.doesNotMatch(JSON.stringify(result), /private command/);
});

test('projects repair run facts into a readable summary', () => {
  const result = projectRunRecord({
    run_id: 'run-repair-1', mode: 'repair', target: 'df_risk.df_risk_judgement_ch', state: 'succeeded',
    started_at: '2026-09-09T22:53:49+08:00', finished_at: '2026-09-09T23:01:03+08:00',
    committed: true, updated_rows: 6807, inserted_rows: 0,
    verification: { row_count: 7492, invalid_data_status_count: 0 },
  }, 'run-repair-1', 'task-a', ['status.json', 'run.log']);
  assert.deepEqual(result, {
    runId: 'run-repair-1', taskId: 'task-a', source: 'task-runner', status: 'succeeded', mode: 'repair', target: 'df_risk.df_risk_judgement_ch',
    startedAt: '2026-09-09T22:53:49+08:00', finishedAt: '2026-09-09T23:01:03+08:00', durationSeconds: 434, exitCode: null,
    committed: true, insertedRows: 0, updatedRows: 6807, summary: '更新 6807 行 · 新增 0 行 · 已提交', evidenceFiles: ['status.json', 'run.log'], verification: { rowCount: 7492, invalidDataStatusCount: 0 }, executionLocation: null,
  });
});

test('uses only an explicit run metadata location to identify local execution', () => {
  const local = projectRunRecord({ status: 'succeeded' }, 'run-local', 'task-a', [], { location: 'local' });
  const unknown = projectRunRecord({ status: 'succeeded', endpoint_mode: 'external', endpoint: 'db.example' }, 'run-unknown', 'task-a', []);
  assert.equal(local.executionLocation, 'local');
  assert.equal(unknown.executionLocation, null);
});

test('projects execute run facts and falls back from status to state', () => {
  const result = projectRunRecord({
    run_id: 'run-execute-1', task_name: 'tests', mode: 'execute', state: 'succeeded', job_started_at: '2026-09-09 20:43:53', job_finished_at: '2026-09-09 20:43:54', exit_code: 0, elapsed_seconds: 0.812, peak_job_memory_mib: 2.301,
  }, 'run-execute-1', 'task-b', ['status.json', 'command.txt']);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.mode, 'execute');
  assert.equal(result.exitCode, 0);
  assert.equal(result.durationSeconds, 0.812);
  assert.equal(result.summary, '退出码 0 · 用时 0.8 秒');
  assert.deepEqual(result.evidenceFiles, ['status.json', 'command.txt']);
});
