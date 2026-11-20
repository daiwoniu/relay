import { lstat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { projectRunRecord,type WorkspaceRunProjection } from './run-projection.js';
import { projectRunMetrics,type RunMetrics } from './run-metrics.js';
import { projectRunBusinessResult } from './run-business-result.js';
import { readRunOperation } from './run-operation.js';
import {readRunTestResult} from './run-test-result.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
import { readWorkspaceDirectory, readWorkspaceFile } from './workspace-files.js';
function runSortTime(run: WorkspaceRunProjection): number {
  const encoded = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(run.runId);
  const value = run.startedAt ?? (encoded ? `${encoded[1]}-${encoded[2]}-${encoded[3]}T${encoded[4]}:${encoded[5]}:${encoded[6]}` : null);
  const time = value ? Date.parse(value.replace(' ', 'T')) : NaN;
  return Number.isFinite(time) ? time : 0;
}

async function readRunResult(root: string, directory: string, runId: string, status: string, statusRecord: Record<string, unknown>, availableFiles?: string[]): Promise<{ resultMetrics: RunMetrics | null; businessResult: WorkspaceRunProjection['businessResult']; resultFile: string | null }> {
  const names = status === 'running' ? ['progress', 'summary'] as const : ['summary', 'progress'] as const;
  let fallbackFile: string | null = null;
  let resultFile: string | null = null;
  let resultMetrics: RunMetrics | null = null;
  let businessResult: WorkspaceRunProjection['businessResult'] = null;
  for (const name of names) {
    if (availableFiles && !availableFiles.includes(`${name}.json`)) continue;
    try {
      const filePath = path.join(directory, `${name}.json`);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
      const parsed: unknown = JSON.parse(await readWorkspaceFile(root, filePath));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if ('run_id' in record && record.run_id !== runId) continue;
      fallbackFile ??= `${name}.json`;
      const items = projectRunMetrics(record);
      const business = projectRunBusinessResult(record, name);
      if (items.length || business) resultFile ??= `${name}.json`;
      if (!resultMetrics && items.length) resultMetrics = { source: name, items };
      businessResult ??= business;
      if (resultMetrics && businessResult) break;
    } catch { /* Progress and summary files may be absent or temporarily unreadable. */ }
  }
  const items = projectRunMetrics(statusRecord);
  return { resultMetrics: resultMetrics ?? (items.length ? { source: 'status', items } : null),
    businessResult: businessResult ?? projectRunBusinessResult(statusRecord, 'status'), resultFile: resultFile ?? (items.length ? null : fallbackFile) };
}

export async function readWorkspaceRuns(root = FIXED_WORKSPACE_PATH): Promise<WorkspaceRunProjection[]> {
  const result: WorkspaceRunProjection[] = [];
  const taskEntries = await readWorkspaceDirectory(root, path.join(root, 'tasks'));
  for (const taskEntry of taskEntries) {
    if (!taskEntry.isDirectory()) continue;
    let runEntries: Dirent[];
    try { runEntries = await readWorkspaceDirectory(root, path.join(root, 'tasks', taskEntry.name, 'runs')); }
    catch { runEntries = []; }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory()) continue;
      const runPath = path.join(root, 'tasks', taskEntry.name, 'runs', runEntry.name);
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(await readWorkspaceFile(root, path.join(runPath, 'status.json'))) as Record<string, unknown>;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}; }
      catch { raw = {}; }
      let metadata: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(await readWorkspaceFile(root, path.join(runPath, 'run-meta.json')));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch { /* Metadata is optional. */ }
      const evidenceFiles = (await readWorkspaceDirectory(root, runPath)).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
      // runs/ also holds screenshots, probes and build artifacts. A directory
      // alone is not an execution; preserve interrupted runs with valid metadata.
      const hasStatus = typeof raw.status === 'string' || typeof raw.state === 'string';
      const hasMetadata = metadata?.version === 1 && typeof metadata.task_name === 'string' && typeof metadata.run_id === 'string';
      if (!hasStatus && !hasMetadata) continue;
      const runId = typeof raw.run_id === 'string' ? raw.run_id : runEntry.name;
      const { resultMetrics, businessResult, resultFile } = await readRunResult(root, runPath, runId, typeof raw.status === 'string' ? raw.status : typeof raw.state === 'string' ? raw.state : 'unknown', raw, evidenceFiles);
      if(result.length>=5000)throw new Error('工作台执行记录超过安全上限');
      const projected=projectRunRecord(raw, runId, taskEntry.name, evidenceFiles, metadata);
      const hasTestHint=/(?:^|[^a-z])(contract|tests?|junit|suite)(?:[^a-z]|$)/i.test(`${runId} ${typeof metadata?.command==='string'?metadata.command:''}`);
      const sameRun=(!raw.run_id||raw.run_id===runEntry.name)&&(!metadata?.run_id||metadata.run_id===runEntry.name);
      const testResult=hasTestHint&&sameRun?await readRunTestResult(root,runPath,evidenceFiles):null;
      result.push({ ...projected,
        testResult,
        operation: await readRunOperation(root, taskEntry.name, metadata ?? raw, projected.mode),
        detailFilePath: testResult?path.join(runPath,'run.log'):resultFile ? path.join(runPath, resultFile) : hasStatus ? path.join(runPath, 'status.json') : path.join(runPath, 'run-meta.json'),
        resultMetrics, businessResult, observedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null });
    }
    let registry: unknown;
    try { registry = JSON.parse(await readWorkspaceFile(root, path.join(root, 'tasks', taskEntry.name, 'remote', 'runs-registry.json'))) as unknown; }
    catch { continue; }
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
      let businessResult: WorkspaceRunProjection['businessResult'] = null;
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
            const parsed: unknown = JSON.parse(await readWorkspaceFile(root, statusPath));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (!('run_id' in parsed) || parsed.run_id === run.run_id)) {
              collected = parsed as Record<string, unknown>;
              detailFilePath = statusPath;
              collectedFiles = ['status.json'];
              const result = await readRunResult(root, localPath, run.run_id, field('status') ?? 'unknown', collected);
              resultMetrics = result.resultMetrics;
              businessResult = result.businessResult;
              if (result.resultFile) {
                detailFilePath = path.join(localPath, result.resultFile);
                collectedFiles.unshift(result.resultFile);
              }
              for (const source of [result.resultMetrics?.source, result.businessResult?.source]) {
                if (source && source !== 'status' && !collectedFiles.includes(`${source}.json`)) collectedFiles.push(`${source}.json`);
              }
              try {
                const summaryPath = path.join(localPath, 'summary.json');
                const summaryStat = await lstat(summaryPath);
                if (summaryStat.isFile() && !summaryStat.isSymbolicLink()) {
                  if (!collectedFiles.includes('summary.json')) collectedFiles.unshift('summary.json');
                }
              } catch { /* The validated status file remains available. */ }
            }
          } catch { /* Collected evidence is optional; retain the registration. */ }
        }
      }
      const projected = projectRunRecord(collected, run.run_id, taskEntry.name, collectedFiles);
      if(result.length>=5000)throw new Error('工作台执行记录超过安全上限');
      result.push({ ...projected, source: 'remote-runner', status: field('status') ?? projected.status,
        operation: await readRunOperation(root, taskEntry.name, run, field('mode') ?? projected.mode),
        mode: field('mode') ?? projected.mode, target: field('task_name') ?? projected.target,
        startedAt: projected.startedAt ?? field('created_at'), executionLocation: 'remote',
        displayName: field('display_name')?.slice(0, 240) ?? projected.displayName ?? null,
        serverName: field('server_profile'), observedAt: field('last_checked_at'), collectedAt: field('collected_at'), detailFilePath, resultMetrics, businessResult });
    }
  }
  return result.sort((left, right) => runSortTime(right) - runSortTime(left) || right.runId.localeCompare(left.runId));
}

