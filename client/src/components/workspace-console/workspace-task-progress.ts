import type { WorkspaceConsoleDashboardDto } from '../../generated/relay-contracts';
import { runTimestamp } from '../../../../scripts/lib/workbench-run-time.mjs';

type Task = WorkspaceConsoleDashboardDto['tasks'][number];
type Run = WorkspaceConsoleDashboardDto['runs'][number];
export type ProgressTask = Task & { workProgress?: { started: boolean; at: number | null } };
export type ProgressDashboard = Omit<WorkspaceConsoleDashboardDto, 'tasks'> & { tasks: ProgressTask[] };
const day = 86_400_000;
const timestamp = (value: string | null | undefined, now: number): number | null => {
  const at = runTimestamp(value) || Date.parse(value ?? '');
  return Number.isFinite(at) && at <= now ? at : null;
};

export function withTaskProgress(task: Task, runs: readonly Run[], now = Date.now()): ProgressTask {
  const times = [timestamp(task.startedAt, now), timestamp(task.lastVerifiedAt, now)];
  const duration = task.observedDurationSeconds;
  let started = times[0] !== null || (typeof duration === 'number' && Number.isFinite(duration) && duration > 0);
  for (const run of runs) {
    if (run.taskId !== task.id) continue;
    const startedAt = runTimestamp(run.startedAt);
    const finishedAt = runTimestamp(run.finishedAt);
    const start = startedAt > 0 && startedAt <= now ? startedAt : null;
    const finish = finishedAt > 0 && finishedAt <= now ? finishedAt : null;
    started ||= start !== null || finish !== null;
    times.push(start, finish);
  }
  const valid = times.filter((at): at is number => at !== null);
  return { ...task, workProgress: {started, at:valid.length ? Math.max(...valid) : null} };
}

export function withDashboardProgress(dashboard: WorkspaceConsoleDashboardDto, now = Date.now()): ProgressDashboard {
  return { ...dashboard, tasks: dashboard.tasks.map((task) => withTaskProgress(task, dashboard.runs, now)) };
}

export function hasTaskStarted(task: ProgressTask): boolean {
  return task.workProgress ? task.workProgress.started : withTaskProgress(task, []).workProgress!.started;
}

export function taskProgressAt(task: ProgressTask): number | null {
  return task.workProgress ? task.workProgress.at : withTaskProgress(task, []).workProgress!.at;
}

export function progressRecency(at: number | null, now = Date.now()): { label: string; stale: boolean } {
  if (at === null || at > now) return { label: '推进时间未登记', stale: false };
  const days = Math.floor((now + 8 * 3_600_000) / day) - Math.floor((at + 8 * 3_600_000) / day);
  const stale = now - at >= 7 * day;
  return { label: stale ? `${days} 天无推进记录 · 待跟进` : days === 0 ? '今天有推进记录' : `${days} 天前有推进记录`, stale };
}
