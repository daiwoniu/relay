import { lstat,readdir,readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { projectRunRecord,type WorkspaceRunProjection } from './run-projection.js';
import { projectRunMetrics,type RunMetrics } from './run-metrics.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
function runSortTime(run: WorkspaceRunProjection): number {
  const encoded = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(run.runId);
  const value = run.startedAt ?? (encoded ? `${encoded[1]}-${encoded[2]}-${encoded[3]}T${encoded[4]}:${encoded[5]}:${encoded[6]}` : null);
  const time = value ? Date.parse(value.replace(' ', 'T')) : NaN;
  return Number.isFinite(time) ? time : 0;
}

async function readRunMetrics(directory: string, runId: string, status: string, statusRecord: Record<string, unknown>, availableFiles?: string[]): Promise<RunMetrics | null> {
  const names = status === 'running' ? ['progress', 'summary'] as const : ['summary', 'progress'] as const;
  for (const name of names) {
    if (availableFiles && !availableFiles.includes(`${name}.json`)) continue;
    try {
      const filePath = path.join(directory, `${name}.json`);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if ('run_id' in record && record.run_id !== runId) continue;
      const items = projectRunMetrics(record);
      if (items.length) return { source: name, items };
    } catch { /* Progress and summary files may be absent or temporarily unreadable. */ }
  }
  const items = projectRunMetrics(statusRecord);
  return items.length ? { source: 'status', items } : null;
}

export async function readWorkspaceRuns(root = FIXED_WORKSPACE_PATH): Promise<WorkspaceRunProjection[]> {
  const result: WorkspaceRunProjection[] = [];
  const taskEntries = await readdir(path.join(root, 'tasks'), { withFileTypes: true });
  for (const taskEntry of taskEntries) {
    if (!taskEntry.isDirectory()) continue;
    let runEntries: Dirent[];
    try { runEntries = await readdir(path.join(root, 'tasks', taskEntry.name, 'runs'), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') runEntries = []; else throw error; }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory()) continue;
      const runPath = path.join(root, 'tasks', taskEntry.name, 'runs', runEntry.name);
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(await readFile(path.join(runPath, 'status.json'), 'utf8')) as Record<string, unknown>; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let metadata: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(await readFile(path.join(runPath, 'run-meta.json'), 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      const evidenceFiles = (await readdir(runPath, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
      const runId = typeof raw.run_id === 'string' ? raw.run_id : runEntry.name;
      const resultMetrics = await readRunMetrics(runPath, runId, typeof raw.status === 'string' ? raw.status : 'unknown', raw, evidenceFiles);
      const metricFile = resultMetrics ? `${resultMetrics.source}.json` : null;
      result.push({ ...projectRunRecord(raw, runId, taskEntry.name, evidenceFiles, metadata),
        detailFilePath: metricFile && evidenceFiles.includes(metricFile) ? path.join(runPath, metricFile) : evidenceFiles.includes('summary.json') ? path.join(runPath, 'summary.json') : evidenceFiles.includes('status.json') ? path.join(runPath, 'status.json') : null,
        resultMetrics });
    }
    let registry: unknown;
    try { registry = JSON.parse(await readFile(path.join(root, 'tasks', taskEntry.name, 'remote', 'runs-registry.json'), 'utf8')) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!registry || typeof registry !== 'object' || !('runs' in registry) || !Array.isArray(registry.runs)) continue;
    for (const candidate of registry.runs) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const run = candidate as Record<string, unknown>;
      if (run.location !== 'remote' || typeof run.run_id !== 'string' || !run.run_id) continue;
      const field = (key: string) => typeof run[key] === 'string' && run[key] ? run[key] as string : null;
      let collected: Record<string, unknown> = {};
      let detailFilePath: string | null = null;
      let collectedFiles: string[] = [];
      let resultMetrics: RunMetrics | null = null;
      const resultDir = field('local_result_dir');
      if (resultDir) {
        const localPath = path.resolve(root, resultDir);
        const taskPath = path.resolve(root, 'tasks', taskEntry.name);
        if (path.basename(localPath) === `remote-${run.run_id}` && localPath.toLowerCase().startsWith(`${taskPath.toLowerCase()}${path.sep}`)) {
          try {
            let checked = taskPath;
            for (const segment of path.relative(taskPath, localPath).split(path.sep)) {
              checked = path.join(checked, segment);
              const stat = await lstat(checked);
              if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid collected run directory');
            }
            const statusPath = path.join(localPath, 'status.json');
            const statusStat = await lstat(statusPath);
            if (!statusStat.isFile() || statusStat.isSymbolicLink()) throw new Error('Invalid collected run status');
            const parsed: unknown = JSON.parse(await readFile(statusPath, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (!('run_id' in parsed) || parsed.run_id === run.run_id)) {
              collected = parsed as Record<string, unknown>;
              detailFilePath = statusPath;
              collectedFiles = ['status.json'];
              resultMetrics = await readRunMetrics(localPath, run.run_id, field('status') ?? 'unknown', collected);
              if (resultMetrics?.source === 'progress') {
                detailFilePath = path.join(localPath, 'progress.json');
                collectedFiles.unshift('progress.json');
              }
              try {
                const summaryPath = path.join(localPath, 'summary.json');
                const summaryStat = await lstat(summaryPath);
                if (summaryStat.isFile() && !summaryStat.isSymbolicLink()) {
                  if (resultMetrics?.source !== 'progress') detailFilePath = summaryPath;
                  collectedFiles.unshift('summary.json');
                }
              } catch { /* The validated status file remains available. */ }
            }
          } catch { /* Collected evidence is optional; retain the registration. */ }
        }
      }
      const projected = projectRunRecord(collected, run.run_id, taskEntry.name, collectedFiles);
      result.push({ ...projected, source: 'remote-runner', status: field('status') ?? projected.status,
        mode: field('mode') ?? projected.mode, target: field('task_name') ?? projected.target,
        startedAt: projected.startedAt ?? field('created_at'), executionLocation: 'remote',
        serverName: field('server_profile'), observedAt: field('last_checked_at'), detailFilePath, resultMetrics });
    }
  }
  return result.sort((left, right) => runSortTime(right) - runSortTime(left) || right.runId.localeCompare(left.runId));
}

