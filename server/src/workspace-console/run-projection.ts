import type { RunMetrics } from './run-metrics.js';

export interface WorkspaceRunProjection {
  runId: string;
  status: string;
  taskId: string | null;
  source: string;
  mode: string | null;
  target: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  exitCode: number | null;
  committed: boolean | null;
  insertedRows: number | null;
  updatedRows: number | null;
  summary: string;
  evidenceFiles: string[];
  detailFilePath?: string | null;
  resultMetrics?: RunMetrics | null;
  verification: { rowCount: number | null; invalidDataStatusCount: number | null } | null;
  executionLocation?: 'local' | 'remote' | null;
  serverName?: string | null;
  observedAt?: string | null;
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return String(record[key]);
  return null;
}
function numberValue(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) if (typeof record[key] === 'number' && Number.isFinite(record[key])) return Number(record[key]);
  return null;
}
function durationSeconds(record: Record<string, unknown>, startedAt: string | null, finishedAt: string | null): number | null {
  const explicit = numberValue(record, 'elapsed_seconds', 'duration_seconds');
  if (explicit !== null) return explicit;
  if (!startedAt || !finishedAt) return null;
  const started = Date.parse(startedAt.replace(' ', 'T'));
  const finished = Date.parse(finishedAt.replace(' ', 'T'));
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? (finished - started) / 1000 : null;
}

function formatDuration(seconds: number): string {
  if (seconds < 1 && seconds > 0) return `${seconds.toFixed(1)} 秒`;
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  const parts = [hours ? `${hours} 小时` : null, minutes ? `${minutes} 分` : null, remainder ? `${remainder} 秒` : null].filter(Boolean);
  if (!parts.length) return '0 秒';
  return remainder ? parts.join(' ') : `${parts.join(' ')}${hours ? '' : '钟'}`;
}

export function projectRunRecord(raw: Record<string, unknown>, runId: string, taskId: string | null, evidenceFiles: string[], metadata?: Record<string, unknown> | null): WorkspaceRunProjection {
  const startedAt = stringValue(raw, 'job_started_at', 'started_at', 'created_at');
  const finishedAt = stringValue(raw, 'job_finished_at', 'finished_at', 'ended_at', 'updated_at');
  const status = stringValue(raw, 'status', 'state') ?? 'unknown';
  const mode = stringValue(raw, 'mode');
  const target = stringValue(raw, 'target', 'task_name');
  const exitCode = numberValue(raw, 'exit_code');
  const insertedRows = numberValue(raw, 'inserted_rows');
  const updatedRows = numberValue(raw, 'updated_rows');
  const committed = typeof raw.committed === 'boolean' ? raw.committed : null;
  const duration = durationSeconds(raw, startedAt, finishedAt);
  const verificationRaw = raw.verification && typeof raw.verification === 'object' && !Array.isArray(raw.verification) ? raw.verification as Record<string, unknown> : null;
  const verification = verificationRaw ? { rowCount: numberValue(verificationRaw, 'row_count'), invalidDataStatusCount: numberValue(verificationRaw, 'invalid_data_status_count') } : null;
  const summaryParts = [];
  if (updatedRows !== null) summaryParts.push(`更新 ${updatedRows} 行`);
  if (insertedRows !== null) summaryParts.push(`新增 ${insertedRows} 行`);
  if (committed === true) summaryParts.push('已提交');
  if (!summaryParts.length && exitCode !== null) summaryParts.push(`退出码 ${exitCode}`);
  if (exitCode !== null && duration !== null) summaryParts.push(`用时 ${formatDuration(duration)}`);
  if (!summaryParts.length && duration !== null) summaryParts.push(`用时 ${formatDuration(duration)}`);
  return { runId, taskId, source: 'task-runner', status, mode, target, startedAt, finishedAt, durationSeconds: duration, exitCode, committed, insertedRows, updatedRows, summary: summaryParts.join(' · ') || '暂无结果摘要', evidenceFiles, verification, executionLocation: metadata?.location === 'local' ? 'local' : null };
}
