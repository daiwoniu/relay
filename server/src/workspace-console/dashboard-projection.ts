import type { WorkspaceLink } from '../db/queries-workspace-console.js';
import type { TaskRegistryProjection, TaskRegistryTask } from './task-registry-reader.js';
import type { WorkspaceRunProjection } from './run-projection.js';
import type { SessionCardProjection } from './session-projection.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';

// Leave room for the command envelope inside the storage transport's 8 MiB limit.
export const WORKSPACE_DASHBOARD_MAX_BYTES = 7 * 1024 * 1024;

export interface DashboardTask extends TaskRegistryTask {
  runIds: string[];
  sessionIds: string[];
  observedDurationSeconds: number | null;
}
export interface WorkspaceDashboard {
  workspacePath: string;
  capturedAt: number;
  registryGeneratedAt: string | null;
  counts: { total: number; completed: number; active: number; runs: number; sessions: number };
  tasks: DashboardTask[];
  runs: WorkspaceRunProjection[];
  unmatchedRuns: WorkspaceRunProjection[];
  sessions: SessionCardProjection[];
  unlinkedSessions: SessionCardProjection[];
  errors: string[];
  sourceAvailable: { registry: boolean; runs: boolean; sessions: boolean; links: boolean; activity: boolean };
  sourceMeta?: { state: 'live' | 'snapshot' | 'failed_snapshot' | 'unavailable'; lastSuccessAt: number | null; lastAttemptAt: number | null; error: string | null };
}

const completedStatuses = new Set(['done', 'completed', 'closed', 'cancelled', 'canceled']);

export function buildWorkspaceDashboard(
  registry: TaskRegistryProjection,
  runs: WorkspaceRunProjection[],
  sessions: SessionCardProjection[],
  links: WorkspaceLink[],
  capturedAt: number,
  errors: string[] = [],
  sourceAvailable: WorkspaceDashboard['sourceAvailable'] = { registry: true, runs: true, sessions: true, links: true, activity: true },
  observedDurations: Map<string, number> = new Map(),
): WorkspaceDashboard {
  const taskIds = new Set(registry.tasks.map((task) => task.id));
  const validSessions = sessions.filter((session) => session.projectPath.toLowerCase() === FIXED_WORKSPACE_PATH.toLowerCase());
  const sessionById = new Map(validSessions.map((session) => [session.sessionId, session]));
  const explicit = links.filter((link) => link.workspace_path.toLowerCase() === FIXED_WORKSPACE_PATH.toLowerCase()
    && link.relation_source === 'explicit' && link.confidence === 'high'
    && taskIds.has(link.task_id) && link.session_id && sessionById.has(link.session_id));
  const linkedSessionIds = new Set([...explicit.map((link) => link.session_id),...validSessions.filter(session=>session.feishuWorkItemIds?.length).map(session=>session.sessionId)]);
  const tasks = registry.tasks.map((task): DashboardTask => ({
    ...task,
    runIds: runs.filter((run) => run.taskId === task.id).map((run) => run.runId),
    sessionIds: [...new Set(explicit.filter((link) => link.task_id === task.id).map((link) => link.session_id!))],
    observedDurationSeconds: observedDurations.get(task.id) ?? null,
  }));
  return {
    workspacePath: FIXED_WORKSPACE_PATH, capturedAt, registryGeneratedAt: registry.generatedAt,
    counts: { total: tasks.length, completed: tasks.filter((task) => completedStatuses.has(task.status ?? '')).length,
      active: tasks.filter((task) => !completedStatuses.has(task.status ?? '')).length, runs: runs.length, sessions: validSessions.length },
    tasks, runs, unmatchedRuns: runs.filter((run) => !run.taskId || !taskIds.has(run.taskId)),
    sessions: validSessions, unlinkedSessions: validSessions.filter((session) => !linkedSessionIds.has(session.sessionId)), errors, sourceAvailable,
  };
}
