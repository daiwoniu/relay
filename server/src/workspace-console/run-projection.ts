import type { RunMetrics } from './run-metrics.js';
import { normalizeRunTimestamp } from '../../../scripts/lib/workbench-run-time.mjs';

export interface WorkspaceRunProjection {
  taskContext?:{directory:string;title:string|null;association:'registered'|'unregistered'|'ambiguous'};
  testResult?:{framework:'junit';total:number;failures:number;errorTypes:string[]}|null;
  operation?: { title: string; objects: string[]; scope: string[]; source: 'descriptor' | 'plan' | 'intent'; plannedBusinessWrite: boolean | null } | null;
  displayName?: string | null;
  failureReason?: string | null;
  collectedAt?: string | null;
  businessResult?: {
    source: 'progress' | 'summary' | 'status';
    status: string | null;
    complete: boolean | null;
    businessWrite: boolean | null;
    stopReason: string | null;
    object: string | null;
    rowsPerSecond: number | null;
    rowLimit: number | null;
    limitPercent: number | null;
    etaSeconds: number | null;
    verified?: boolean | null;
    preflightPassed?: boolean | null;
    businessWrites?: number | null;
    formalSpWrites?: number | null;
    phase?: string | null;
  } | null;
  runId: string;
  status: string;
  taskId: string | null;
  source: string;
  mode: string | null;
  target: string | null;
  createdAt?: string | null;
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
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
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
  const startedAt = normalizeRunTimestamp(stringValue(raw, 'job_started_at'))
    ?? normalizeRunTimestamp(stringValue(raw, 'started_at')) ?? normalizeRunTimestamp(stringValue(metadata ?? {}, 'started_at'));
  const createdAt = normalizeRunTimestamp(stringValue(raw, 'created_at'));
  const status = stringValue(raw, 'status', 'state') ?? 'unknown';
  // updated_at is also a running heartbeat, not proof of completion.
  const finishedAt = normalizeRunTimestamp(stringValue(raw, 'job_finished_at'))
    ?? normalizeRunTimestamp(stringValue(raw, 'finished_at')) ?? normalizeRunTimestamp(stringValue(raw, 'ended_at'));
  const mode = stringValue(raw, 'mode') ?? stringValue(metadata ?? {}, 'mode');
  const target = stringValue(raw, 'target', 'task_name') ?? stringValue(metadata ?? {}, 'task_name');
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
  const notification = metadata?.notification && typeof metadata.notification === 'object' ? metadata.notification as Record<string, unknown> : {};
  const displayName = stringValue(raw, 'display_name') ?? stringValue(metadata ?? {}, 'display_name') ?? stringValue(notification, 'display_name');
  const failureReason = stringValue(raw, 'lost_reason', 'failure_reason');
  return { runId, taskId, source: 'task-runner', status, mode, target, startedAt, finishedAt, durationSeconds: duration, exitCode, committed, insertedRows, updatedRows, summary: summaryParts.join(' · ') || '暂无结果摘要', evidenceFiles, verification, executionLocation: metadata?.location === 'local' ? 'local' : null,
    ...(createdAt ? { createdAt } : {}), ...(displayName ? { displayName: displayName.slice(0, 240) } : {}), ...(failureReason ? { failureReason: failureReason.slice(0, 500) } : {}) };
}
