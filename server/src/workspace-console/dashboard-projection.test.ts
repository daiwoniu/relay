import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkspaceDashboard } from './dashboard-projection.js';
import type { TaskRegistryTask } from './task-registry-reader.js';
import type { WorkspaceRunProjection } from './run-projection.js';
import type { SessionCardProjection } from './session-projection.js';
import type { WorkspaceLink } from '../db/queries-workspace-console.js';

const task = (id: string, status: string, feishuWorkItemIds: string[] = []): TaskRegistryTask => ({ id, title: id, description: null, taskPath: null, taskDocumentPath: null, status, horizon: null, nextAction: null, waitingOn: null, statusBasis: null, verification: null, lastVerifiedAt: null, completedAt: status === 'done' ? '2026-09-26T10:00:00+08:00' : null, feishuWorkItemIds });
const run = (runId: string, taskId: string): WorkspaceRunProjection => ({ runId, taskId, status: 'unknown', source: 'task-runner', mode: null, target: null, startedAt: null, finishedAt: null, durationSeconds: null, exitCode: null, committed: null, insertedRows: null, updatedRows: null, summary: '', evidenceFiles: [], verification: null });
const session = (sessionId: string, projectPath = FIXED_WORKSPACE_PATH): SessionCardProjection => ({ sessionId, title: sessionId, projectPath, updatedAt: 2, status: 'idle', url: `/?session=${sessionId}`, engine: 'codex', modelId: null, latestMessage: null });
const link = (taskId: string, sessionId: string): WorkspaceLink => ({ id: `link-${taskId}`, workspace_path: FIXED_WORKSPACE_PATH, task_id: taskId, session_id: sessionId, feishu_work_item_id: null, run_id: null, relation_source: 'explicit', confidence: 'high', last_verified_at: 1, created_at: 1, updated_at: 1 });

test('keeps completed tasks and separate deliverables sharing a Project parent', () => {
  const result = buildWorkspaceDashboard({ schemaVersion: 1, generatedAt: '2026-09-26T10:00:00+08:00', tasks: [task('a', 'done', ['123']), task('b', 'active', ['123'])] }, [], [], [], 3);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0]?.status, 'done');
  assert.deepEqual(result.tasks.map((item) => item.feishuWorkItemIds), [['123'], ['123']]);
  assert.equal(result.counts.completed, 1);
});

test('adds observed activity time only to its matching task', () => {
  const registry = { schemaVersion: 1, generatedAt: null, tasks: [task('a', 'doing'), task('b', 'waiting')] };
  const result = buildWorkspaceDashboard(registry, [], [], [], 3, [], undefined, new Map([['a', 3661]]));
  assert.deepEqual(result.tasks.map((item) => item.observedDurationSeconds), [3661, null]);
});

test('retains unknown and unmatched runs without changing task status', () => {
  const result = buildWorkspaceDashboard({ schemaVersion: 1, generatedAt: null, tasks: [task('a', 'active')] }, [run('r1', 'a'), run('r2', 'missing')], [], [], 3);
  assert.equal(result.tasks[0]?.status, 'active');
  assert.deepEqual(result.tasks[0]?.runIds, ['r1']);
  assert.deepEqual(result.unmatchedRuns.map((item) => item.runId), ['r2']);
  assert.equal(result.runs[0]?.status, 'unknown');
});

test('rejects deleted or cross-workspace session links and retains unlinked sessions', () => {
  const result = buildWorkspaceDashboard({ schemaVersion: 1, generatedAt: null, tasks: [task('a', 'active')] }, [], [session('alive'), session('other', 'D:\\other')], [link('a', 'deleted'), link('a', 'other')], 3);
  assert.deepEqual(result.tasks[0]?.sessionIds, []);
  assert.deepEqual(result.unlinkedSessions.map((item) => item.sessionId), ['alive']);
});
