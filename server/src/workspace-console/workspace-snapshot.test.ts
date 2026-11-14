import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceSnapshot, FIXED_WORKSPACE_PATH, projectActivitySummary } from './workspace-snapshot.js';
import { loadWorkspaceConfig } from './workspace-config.js';

test('workbench root comes from local configuration, never from process cwd', () => {
  const configured = loadWorkspaceConfig();
  if (configured.configured) assert.equal(FIXED_WORKSPACE_PATH, configured.workspaceRoot);
  else assert.ok(FIXED_WORKSPACE_PATH.endsWith(path.join('.relay-dev', 'unconfigured-workspace')));
});

test('projects activity timing and current action from the workspace activity ledger', () => {
  const result = projectActivitySummary({
    task_id: 'task',
    title: '任务',
    status: 'doing',
    activity_state: 'active',
    latest_heartbeat_at: '2026-09-22T10:10:00+08:00',
    next_action: '继续验证',
    activities: [{
      started_at: '2026-09-22T09:00:00+08:00',
      ended_at: null,
      current_action: '执行测试',
      heartbeat_at: '2026-09-22T10:10:00+08:00',
    }],
  });
  assert.equal(result.startedAt, '2026-09-22T09:00:00+08:00');
  assert.equal(result.endedAt, null);
  assert.equal(result.currentAction, '执行测试');
});

test('projects observed activity duration supplied by the workspace script', () => {
  const result = projectActivitySummary({ observed_started_at: '2026-09-22T09:00:00+08:00', observed_ended_at: null, observed_duration_seconds: 3600, current_action: '执行测试' });
  assert.equal(result.observedStartedAt, '2026-09-22T09:00:00+08:00');
  assert.equal(result.observedDurationSeconds, 3600);
});

test('separates lifecycle state from realtime activity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-workspace-console-'));
  try {
    await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
    await fs.writeFile(path.join(root, 'tasks', 'task-registry.json'), JSON.stringify({
      schema_version: 1, generated_at: '2026-09-22T10:00:00+08:00',
      tasks: { task: { kind: 'task', title: '进行中任务', task_path: 'tasks/task', status: 'active' } },
    }), 'utf8');
    const snapshot = await createWorkspaceSnapshot(root, {
      fixedWorkspacePath: root,
      now: 1_000,
      activityReader: async () => ({ generatedAt: 900, tasks: [], errors: [] }),
      gitReader: async () => ({ branch: 'main', dirtyCount: 0, commitsAhead: 0 }),
    });
    assert.equal(snapshot.taskRegistry.tasks[0]!.status, 'active');
    assert.deepEqual(snapshot.activity.tasks, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rejects a non-fixed workspace path', async () => {
  await assert.rejects(() => createWorkspaceSnapshot('D:\\other'), /fixed workspace/);
});
