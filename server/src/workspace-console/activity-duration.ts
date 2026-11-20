import path from 'node:path';
import { readWorkspaceDirectory, readWorkspaceFile } from './workspace-files.js';

type Interval = { start: number; end: number };
export type ActivityEvidence = { state: 'complete' | 'active' | 'uncertain' | 'stale' | 'unavailable'; incomplete: boolean };
export type ObservedActivity = { durations: Map<string, number>; evidence: Map<string, ActivityEvidence> };

async function durationForTask(root: string, taskId: string, now: number, evidence: Map<string, ActivityEvidence>): Promise<number | null> {
  let observation: ActivityEvidence = { state: 'complete', incomplete: false };
  const update = (state: ActivityEvidence['state']) => {
    const priority = { complete: 0, active: 1, unavailable: 2, uncertain: 3, stale: 4 };
    if (priority[state] > priority[observation.state]) observation.state = state;
    observation.incomplete ||= ['unavailable', 'uncertain', 'stale'].includes(state);
    evidence.set(taskId, observation);
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) return null;
  const dir = path.join(root, '.tmp', 'task-activity', taskId);
  let files;
  try { files = await readWorkspaceDirectory(root, dir); }
  catch { update('unavailable'); return null; }
  const intervals = (await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith('.json')).map(async (file): Promise<Interval | null> => {
    try {
      const record = JSON.parse(await readWorkspaceFile(root, path.join(dir, file.name), 64 * 1024)) as Record<string, unknown>;
      if (record.task_id !== taskId || typeof record.started_at !== 'string') { update('unavailable'); return null; }
      const start = Date.parse(record.started_at);
      let end: number;
      if (typeof record.ended_at === 'string') end = Date.parse(record.ended_at);
      else {
        if (record.schema_version !== 1 || !['working', 'tool_wait'].includes(String(record.state)) || typeof record.heartbeat_at !== 'string' || record.activity_id !== path.basename(file.name, '.json')) { update('unavailable'); return null; }
        const heartbeat = Date.parse(record.heartbeat_at);
        if (!Number.isFinite(heartbeat) || heartbeat < start || heartbeat > now + 60000) { update('unavailable'); return null; }
        update(now - heartbeat <= 120000 ? 'active' : now - heartbeat <= 600000 ? 'uncertain' : 'stale');
        // Only a live lease accrues to now. Stale/uncertain leases stop at the last observation.
        end = now - heartbeat <= 120000 ? now : heartbeat;
      }
      end = Math.min(end, now);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { update('unavailable'); return null; }
      return { start, end };
    } catch { update('unavailable'); return null; }
  }))).filter((interval): interval is Interval => interval !== null).sort((a, b) => a.start - b.start);
  if (!intervals.length) { update('unavailable'); return null; }
  let seconds = 0;
  let mergedEnd = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    seconds += Math.max(0, interval.end - Math.max(interval.start, mergedEnd)) / 1000;
    mergedEnd = Math.max(mergedEnd, interval.end);
  }
  evidence.set(taskId, observation); return Math.floor(seconds);
}

export async function readObservedTaskDurations(root: string, taskIds: string[], now: number): Promise<Map<string, number>> {
  return (await readObservedTaskActivity(root, taskIds, now)).durations;
}
export async function readObservedTaskActivity(root: string, taskIds: string[], now: number): Promise<ObservedActivity> {
  const evidence = new Map<string, ActivityEvidence>();
  const results = await Promise.all(taskIds.map(async taskId => [taskId, await durationForTask(root, taskId, now, evidence)] as const));
  return { durations: new Map(results.filter((entry): entry is readonly [string, number] => entry[1] !== null)), evidence };
}
