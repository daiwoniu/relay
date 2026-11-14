import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessMemoryRow {
  pid: number;
  parentPid: number;
  name: string;
  privateBytes: number;
  startedAt: number;
}

export interface ProcessMemorySummary {
  relay: {
    privateBytes: number;
    backendPrivateBytes: number;
    processCount: number;
    scope: 'managed' | 'backend';
  } | null;
  topProcesses: { name: string; privateBytes: number; processCount: number }[];
}

export function parseWindowsProcessMemory(stdout: string): ProcessMemoryRow[] {
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) throw new Error('Process memory counters unavailable');
  return rows.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid process memory row');
    const { pid, parentPid, name, privateBytes, startedAt } = row as Record<string, unknown>;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0
      || !Number.isSafeInteger(parentPid) || Number(parentPid) < 0
      || typeof name !== 'string' || !/^[^\\/:\x00-\x1f]{1,120}$/.test(name)
      || !Number.isSafeInteger(privateBytes) || Number(privateBytes) < 0
      || !Number.isSafeInteger(startedAt) || Number(startedAt) <= 0) {
      throw new Error('Invalid process memory counters');
    }
    return { pid: Number(pid), parentPid: Number(parentPid), name, privateBytes: Number(privateBytes), startedAt: Number(startedAt) };
  });
}

export function summarizeProcessMemory(
  rows: ProcessMemoryRow[], backendPid: number, managedRootPid?: number,
): ProcessMemorySummary {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const backend = byPid.get(backendPid);
  // A managed backend is a direct child of the Relay launcher. Never climb to a user's shell.
  const managedRoot = managedRootPid === undefined ? undefined : byPid.get(managedRootPid);
  const managed = !!managedRoot && !!backend && backend.parentPid === managedRoot.pid && managedRoot.startedAt <= backend.startedAt;
  const rootPid = managed ? managedRoot!.pid : backendPid;
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parent = byPid.get(row.parentPid);
      // Windows retains old parent IDs after exit; timestamps prevent PID reuse from claiming unrelated processes.
      if (!descendants.has(row.pid) && descendants.has(row.parentPid) && parent && parent.startedAt <= row.startedAt) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const relayRows = rows.filter((row) => descendants.has(row.pid));
  const groups = new Map<string, ProcessMemorySummary['topProcesses'][number]>();
  for (const row of rows) {
    if (row.privateBytes === 0) continue;
    const key = row.name.toLowerCase();
    const group = groups.get(key) ?? { name: row.name, privateBytes: 0, processCount: 0 };
    group.privateBytes += row.privateBytes;
    group.processCount += 1;
    groups.set(key, group);
  }
  return {
    relay: backend ? {
      privateBytes: relayRows.reduce((sum, row) => sum + row.privateBytes, 0),
      backendPrivateBytes: backend.privateBytes,
      processCount: relayRows.length,
      scope: managed ? 'managed' : 'backend',
    } : null,
    topProcesses: [...groups.values()]
      .sort((a, b) => b.privateBytes - a.privateBytes || a.name.localeCompare(b.name))
      .slice(0, 5),
  };
}

export async function sampleProcessMemory(platform: NodeJS.Platform = process.platform): Promise<ProcessMemorySummary> {
  if (platform !== 'win32') throw new Error('Process private commit counters unsupported on this platform');
  // Only collect identities needed for local aggregation. No command lines or executable paths.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,PrivatePageCount,CreationDate | Where-Object { $_.ProcessId -gt 0 -and $_.ProcessId -ne $PID } |',
    'Select-Object @{n="pid";e={[int]$_.ProcessId}}, @{n="parentPid";e={[int]$_.ParentProcessId}},',
    '@{n="name";e={$_.Name}}, @{n="privateBytes";e={[double]$_.PrivatePageCount}},',
    '@{n="startedAt";e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress',
  ].join('\n');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 8_000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8',
  });
  return summarizeProcessMemory(
    parseWindowsProcessMemory(stdout), process.pid,
    Number(process.env.RELAY_LAUNCHER_CONTROL_VERSION) >= 1 ? process.ppid : undefined,
  );
}
