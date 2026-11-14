import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readTaskRegistry, type TaskRegistryProjection } from './task-registry-reader.js';
import { WORKSPACE_ROOT } from './workspace-config.js';

const execFileAsync = promisify(execFile);
// Compatibility name for the single configured workbench root, shared by the
// main process and storage Worker. It is no longer tied to a developer machine.
export const FIXED_WORKSPACE_PATH = WORKSPACE_ROOT;

export interface ActivityTask {
  id: string | null;
  title: string | null;
  activity: string | null;
  status: string | null;
  stale: boolean | null;
  phase: string | null;
  next: string | null;
  reason: string | null;
  worktree: string | null;
  branch: string | null;
  heartbeatAt: string | null;
  evidence: string | null;
  registered: boolean | null;
  startedAt: string | null;
  endedAt: string | null;
  currentAction: string | null;
  observedStartedAt?: string | null;
  observedEndedAt?: string | null;
  observedDurationSeconds?: number | null;
}

export interface ActivityProjection { generatedAt: string | number; tasks: ActivityTask[]; errors: string[]; }
export interface GitProjection { branch: string | null; dirtyCount: number | null; commitsAhead: number | null; }
export interface WorkspaceSnapshot {
  workspace: { path: string; accessible: boolean };
  taskRegistry: TaskRegistryProjection;
  activity: ActivityProjection;
  git: GitProjection;
  freshness: { capturedAt: number };
  errors: string[];
}

export interface SnapshotDependencies {
  fixedWorkspacePath?: string;
  now?: number;
  activityReader?: (root: string) => Promise<ActivityProjection>;
  gitReader?: (root: string) => Promise<GitProjection>;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function projectActivitySummary(task: Record<string, unknown>): Pick<ActivityTask, 'startedAt' | 'endedAt' | 'currentAction' | 'observedStartedAt' | 'observedEndedAt' | 'observedDurationSeconds'> {
  const activities = Array.isArray(task.activities)
    ? task.activities.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
  const latest = [...activities].sort((left, right) => String(right.heartbeat_at ?? '').localeCompare(String(left.heartbeat_at ?? '')))[0];
  return {
    startedAt: typeof latest?.started_at === 'string' ? latest.started_at : null,
    endedAt: typeof latest?.ended_at === 'string' ? latest.ended_at : null,
    currentAction: typeof latest?.current_action === 'string' ? latest.current_action : null,
    observedStartedAt: typeof task.observed_started_at === 'string' ? task.observed_started_at : null,
    observedEndedAt: typeof task.observed_ended_at === 'string' ? task.observed_ended_at : null,
    observedDurationSeconds: typeof task.observed_duration_seconds === 'number' ? task.observed_duration_seconds : null,
  };
}

async function readActivity(root: string): Promise<ActivityProjection> {
  const script = path.join(root, 'scripts', 'task_activity.py');
  try {
    const result = await execFileAsync('python', ['-X', 'utf8', script, 'current', '--json'], { cwd: root, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(result.stdout) as { tasks?: Array<Record<string, unknown>>; warnings?: unknown[] };
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map((task) => ({
      id: typeof task.task_id === 'string' ? task.task_id : null,
      title: typeof task.title === 'string' ? task.title : null,
      activity: typeof task.activity_state === 'string' ? task.activity_state : null,
      status: typeof task.status === 'string' ? task.status : null,
      stale: typeof task.latest_heartbeat_at === 'string' && ['stale', 'expired', 'timeout'].includes(String(task.activity_state)),
      phase: null,
      next: typeof task.next_action === 'string' ? task.next_action : null,
      reason: typeof task.waiting_on === 'string' ? task.waiting_on : null,
      worktree: null,
      branch: null,
      heartbeatAt: typeof task.latest_heartbeat_at === 'string' ? task.latest_heartbeat_at : null,
      evidence: null,
      registered: true,
      ...projectActivitySummary(task),
    })) : [];
    const errors = Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === 'string') : [];
    return { generatedAt: Date.now(), tasks, errors };
  } catch (error) {
    return { generatedAt: Date.now(), tasks: [], errors: [`实时活动读取失败：${error instanceof Error ? error.message : String(error)}`] };
  }
}

async function readGit(root: string): Promise<GitProjection> {
  try {
    const branch = (await execFileAsync('git', ['-C', root, 'branch', '--show-current'], { timeout: 10_000 })).stdout.trim() || null;
    const status = (await execFileAsync('git', ['-C', root, 'status', '--porcelain'], { timeout: 10_000 })).stdout.trim();
    return { branch, dirtyCount: status ? status.split(/\r?\n/).length : 0, commitsAhead: null };
  } catch { return { branch: null, dirtyCount: null, commitsAhead: null }; }
}

export async function createWorkspaceSnapshot(root: string, dependencies: SnapshotDependencies = {}): Promise<WorkspaceSnapshot> {
  const fixedWorkspacePath = dependencies.fixedWorkspacePath ?? FIXED_WORKSPACE_PATH;
  if (!samePath(root, fixedWorkspacePath)) throw new Error(`workspace-console 仅支持 fixed workspace：${fixedWorkspacePath}`);
  const activityReader = dependencies.activityReader ?? readActivity;
  const gitReader = dependencies.gitReader ?? readGit;
  const [taskRegistry, activity, git] = await Promise.all([readTaskRegistry(root), activityReader(root), gitReader(root)]);
  return {
    workspace: { path: root, accessible: true },
    taskRegistry,
    activity,
    git,
    freshness: { capturedAt: dependencies.now ?? Date.now() },
    errors: [...activity.errors],
  };
}
