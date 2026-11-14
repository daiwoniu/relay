import fs from 'node:fs/promises';
import path from 'node:path';

type Interval = { start: number; end: number };

async function durationForTask(root: string, taskId: string, now: number): Promise<number | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) return null;
  const dir = path.join(root, '.tmp', 'task-activity', taskId);
  let files;
  try { files = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const intervals = (await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith('.json')).map(async (file): Promise<Interval | null> => {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, file.name), 'utf8')) as Record<string, unknown>;
      if (record.task_id !== taskId || typeof record.started_at !== 'string') return null;
      const start = Date.parse(record.started_at);
      const end = typeof record.ended_at === 'string' ? Date.parse(record.ended_at) : now;
      return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
    } catch { return null; }
  }))).filter((interval): interval is Interval => interval !== null).sort((a, b) => a.start - b.start);
  if (!intervals.length) return null;
  let seconds = 0;
  let mergedEnd = Number.NEGATIVE_INFINITY;
  for (const interval of intervals) {
    seconds += Math.max(0, interval.end - Math.max(interval.start, mergedEnd)) / 1000;
    mergedEnd = Math.max(mergedEnd, interval.end);
  }
  return Math.floor(seconds);
}

export async function readObservedTaskDurations(root: string, taskIds: string[], now: number): Promise<Map<string, number>> {
  const results = await Promise.all(taskIds.map(async (taskId) => [taskId, await durationForTask(root, taskId, now)] as const));
  return new Map(results.filter((entry): entry is readonly [string, number] => entry[1] !== null));
}
