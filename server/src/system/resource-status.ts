import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { sampleProcessMemory, type ProcessMemorySummary } from './process-memory.js';

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_TTL_MS = 30_000;
const WARNING_THRESHOLD_PERCENT = 80;
const CRITICAL_THRESHOLD_PERCENT = 90;

export interface CommitMemorySample {
  committedBytes: number;
  commitLimitBytes: number;
}

export interface SystemResourceStatusSnapshot {
  available: boolean;
  level: 'normal' | 'warning' | 'critical' | 'unknown';
  committedBytes: number | null;
  commitLimitBytes: number | null;
  usagePercent: number | null;
  observedAt: number;
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  processMemory?: ProcessMemorySummary | null;
}

export interface SystemResourceStatusServiceOptions {
  now?: () => number;
  cacheTtlMs?: number;
  sample?: () => Promise<CommitMemorySample>;
  sampleProcesses?: () => Promise<ProcessMemorySummary>;
  platform?: NodeJS.Platform;
}

function parseLinuxMeminfo(value: string): CommitMemorySample {
  const fields = new Map<string, number>();
  for (const line of value.split(/\r?\n/)) {
    const match = /^([^:]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) fields.set(match[1], Number(match[2]) * 1024);
  }
  const committedBytes = fields.get('Committed_AS');
  const commitLimitBytes = fields.get('CommitLimit');
  if (!Number.isFinite(committedBytes) || !Number.isFinite(commitLimitBytes)) {
    throw new Error('Linux commit memory counters unavailable');
  }
  return { committedBytes: committedBytes!, commitLimitBytes: commitLimitBytes! };
}

export function parseTypeperfCommitMemory(value: string): CommitMemorySample {
  for (const line of value.split(/\r?\n/)) {
    const match = /^"[^"]+","([0-9.]+)","([0-9.]+)"$/.exec(line.trim());
    if (!match) continue;
    const committedBytes = Number(match[1]);
    const commitLimitBytes = Number(match[2]);
    if (Number.isFinite(committedBytes) && Number.isFinite(commitLimitBytes)) {
      return { committedBytes, commitLimitBytes };
    }
  }
  throw new Error('Windows commit memory counters unavailable');
}

async function sampleWindowsCommitMemory(): Promise<CommitMemorySample> {
  const { stdout } = await execFileAsync('typeperf.exe', [
    '\\Memory\\Committed Bytes',
    '\\Memory\\Commit Limit',
    '-sc',
    '1',
  ], {
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 16 * 1024,
    encoding: 'utf8',
  });
  return parseTypeperfCommitMemory(stdout);
}

export async function sampleCommitMemory(platform: NodeJS.Platform = process.platform): Promise<CommitMemorySample> {
  if (platform === 'win32') return sampleWindowsCommitMemory();
  if (platform === 'linux') return parseLinuxMeminfo(await readFile('/proc/meminfo', 'utf8'));
  throw new Error('Commit memory counters unsupported on this platform');
}

function createSnapshot(sample: CommitMemorySample, observedAt: number): SystemResourceStatusSnapshot {
  if (!Number.isFinite(sample.committedBytes) || sample.committedBytes < 0
    || !Number.isFinite(sample.commitLimitBytes) || sample.commitLimitBytes <= 0) {
    throw new Error('Invalid commit memory sample');
  }
  const usagePercent = Math.round((sample.committedBytes / sample.commitLimitBytes) * 1_000) / 10;
  const level = usagePercent >= CRITICAL_THRESHOLD_PERCENT
    ? 'critical'
    : usagePercent >= WARNING_THRESHOLD_PERCENT ? 'warning' : 'normal';
  return {
    available: true,
    level,
    committedBytes: Math.round(sample.committedBytes),
    commitLimitBytes: Math.round(sample.commitLimitBytes),
    usagePercent,
    observedAt,
    warningThresholdPercent: WARNING_THRESHOLD_PERCENT,
    criticalThresholdPercent: CRITICAL_THRESHOLD_PERCENT,
  };
}

function unavailableSnapshot(observedAt: number): SystemResourceStatusSnapshot {
  return {
    available: false,
    level: 'unknown',
    committedBytes: null,
    commitLimitBytes: null,
    usagePercent: null,
    observedAt,
    warningThresholdPercent: WARNING_THRESHOLD_PERCENT,
    criticalThresholdPercent: CRITICAL_THRESHOLD_PERCENT,
  };
}

export function createSystemResourceStatusService(options: SystemResourceStatusServiceOptions = {}) {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const sample = options.sample ?? (() => sampleCommitMemory(options.platform));
  const sampleProcesses = options.sampleProcesses ?? (() => sampleProcessMemory(options.platform));
  let cached: { at: number; snapshot: SystemResourceStatusSnapshot } | null = null;
  let pending: Promise<SystemResourceStatusSnapshot> | null = null;

  return {
    async getSnapshot(): Promise<SystemResourceStatusSnapshot> {
      const currentTime = now();
      if (cached && currentTime - cached.at < cacheTtlMs) return cached.snapshot;
      if (pending) return pending;
      pending = Promise.all([
        Promise.resolve().then(sample).then((value) => createSnapshot(value, currentTime)).catch(() => unavailableSnapshot(currentTime)),
        Promise.resolve().then(sampleProcesses).catch(() => null),
      ])
        .then(([snapshot, processMemory]) => {
          snapshot.processMemory = processMemory;
          cached = { at: currentTime, snapshot };
          return snapshot;
        })
        .finally(() => { pending = null; });
      return pending;
    },
  };
}

export const systemResourceStatusService = createSystemResourceStatusService();
