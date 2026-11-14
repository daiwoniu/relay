import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { JsonRpcTransport } from '../engine/transports/transport.js';
import { StdioAcpTransport } from '../engine/transports/stdio-acp.js';
import { inspectOpenCodeInstallation } from './installation.js';

const DEFAULT_MAX_PROCESSES = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const OPENCODE_SESSION_ARGS = ['acp'] as const;
export const OPENCODE_MODEL_DISCOVERY_ARGS = OPENCODE_SESSION_ARGS;

export interface ManagedOpenCodeTransport extends JsonRpcTransport {
  closeAndWait(force?: boolean): Promise<void>;
  diagnostic(): string;
}

export interface OpenCodeLaunch {
  command: string;
  args: string[];
}

const WINDOWS_EXECUTABLES = ['.exe', '.cmd', '.bat', '.com'];

function findOnWindowsPath(directory: string, pathApi: typeof path.win32, exists: (candidate: string) => boolean): string | undefined {
  const npmLayout = pathApi.join(directory, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  if (exists(npmLayout)) return npmLayout;
  const direct = WINDOWS_EXECUTABLES
    .map((extension) => pathApi.join(directory, `opencode${extension}`))
    .find((candidate) => exists(candidate));
  return direct;
}

export function resolveOpenCodeLaunch(
  argumentsList: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    envPath?: string;
    exists?: (candidate: string) => boolean;
  } = {},
): OpenCodeLaunch {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { command: 'opencode', args: [...argumentsList] };
  const exists = options.exists ?? existsSync;
  const pathApi = path.win32;
  const entrypoint = (options.envPath ?? process.env.PATH ?? '')
    .split(';')
    .filter(Boolean)
    .map((directory) => findOnWindowsPath(directory, pathApi, exists))
    .find((candidate): candidate is string => Boolean(candidate));
  if (!entrypoint) throw new Error('OPENCODE_CLI_NOT_INSTALLED');
  return { command: entrypoint, args: [...argumentsList] };
}

export class OpenCodeProcessLimitError extends Error {
  constructor(readonly limit: number) {
    super(`OpenCode 活动子进程已达到上限（${limit}）`);
    this.name = 'OpenCodeProcessLimitError';
  }
}

export interface OpenCodeProcessManagerOptions {
  maxProcesses?: number;
  idleTimeoutMs?: number;
  readVersion?: () => string | null;
  createTransport?: (cwd: string, sessionId: string) => ManagedOpenCodeTransport;
  createDiscoveryTransport?: (cwd: string) => ManagedOpenCodeTransport;
}

interface ManagedEntry {
  sessionId: string;
  transport: ManagedOpenCodeTransport;
  idleTimer: ReturnType<typeof setTimeout> | null;
  removeCloseListener: () => void;
  busy: boolean;
  version: string | null;
  closePromise: Promise<void> | null;
}

export class OpenCodeProcessManager {
  private readonly entries = new Map<string, ManagedEntry>();
  private readonly allEntries = new Set<ManagedEntry>();
  private readonly maxProcesses: number;
  private readonly idleTimeoutMs: number;
  private readonly readVersion: () => string | null;
  private readonly createTransport: (cwd: string, sessionId: string) => ManagedOpenCodeTransport;
  private readonly createDiscoveryTransport: (cwd: string) => ManagedOpenCodeTransport;

  constructor(options: OpenCodeProcessManagerOptions = {}) {
    this.maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.readVersion = options.readVersion ?? (() => inspectOpenCodeInstallation().version);
    if (!Number.isInteger(this.maxProcesses) || this.maxProcesses < 1) {
      throw new Error('OpenCode 子进程上限必须是正整数');
    }
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 1) {
      throw new Error('OpenCode 子进程空闲时间必须大于 0');
    }
    this.createTransport = options.createTransport ?? ((cwd) => {
      const launch = resolveOpenCodeLaunch(OPENCODE_SESSION_ARGS);
      return new StdioAcpTransport({
        command: launch.command,
        args: launch.args,
        cwd,
      });
    });
    this.createDiscoveryTransport = options.createDiscoveryTransport ?? ((cwd) => {
      const launch = resolveOpenCodeLaunch(OPENCODE_MODEL_DISCOVERY_ARGS);
      return new StdioAcpTransport({ command: launch.command, args: launch.args, cwd });
    });
  }

  get size(): number {
    return this.allEntries.size;
  }

  createModelDiscoveryTransport(cwd: string): ManagedOpenCodeTransport {
    return this.createDiscoveryTransport(cwd);
  }

  has(sessionId: string): boolean {
    return [...this.allEntries].some((entry) => entry.sessionId === sessionId);
  }

  getOrCreate(sessionId: string, cwd: string): ManagedOpenCodeTransport {
    const existing = this.entries.get(sessionId);
    if (existing && existing.transport.state !== 'closed' && existing.transport.state !== 'closing') {
      this.scheduleIdle(sessionId, existing);
      return existing.transport;
    }
    if (existing?.transport.state === 'closed') this.removeEntry(existing);
    if (this.allEntries.size >= this.maxProcesses) throw new OpenCodeProcessLimitError(this.maxProcesses);

    const transport = this.createTransport(cwd, sessionId);
    const entry: ManagedEntry = {
      sessionId,
      transport,
      idleTimer: null,
      removeCloseListener: () => undefined,
      busy: false,
      version: this.readVersion(),
      closePromise: null,
    };
    entry.removeCloseListener = transport.onClose(() => {
      this.removeEntry(entry);
    });
    this.entries.set(sessionId, entry);
    this.allEntries.add(entry);
    this.scheduleIdle(sessionId, entry);
    return transport;
  }

  touch(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    this.scheduleIdle(sessionId, entry);
    return true;
  }

  setBusy(sessionId: string, busy: boolean): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    entry.busy = busy;
    if (busy) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    } else {
      this.scheduleIdle(sessionId, entry);
    }
    return true;
  }

  async release(sessionId: string, transport?: ManagedOpenCodeTransport): Promise<void> {
    const matching = [...this.allEntries].filter((entry) => (
      entry.sessionId === sessionId && (!transport || entry.transport === transport)
    ));
    await Promise.all(matching.map((entry) => this.closeEntry(entry)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.allEntries].map((entry) => this.closeEntry(entry)));
  }

  getInstanceSummary(): {
    activeInstanceCount: number;
    versions: Array<{ version: string | null; count: number }>;
  } {
    const counts = new Map<string | null, number>();
    for (const entry of this.allEntries) counts.set(entry.version, (counts.get(entry.version) || 0) + 1);
    const versions = [...counts.entries()]
      .map(([version, count]) => ({ version, count }))
      .sort((left, right) => {
        if (left.version === right.version) return 0;
        if (left.version === null) return 1;
        if (right.version === null) return -1;
        return left.version.localeCompare(right.version, 'en');
      });
    return { activeInstanceCount: this.allEntries.size, versions };
  }

  private scheduleIdle(sessionId: string, entry: ManagedEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.busy) {
      entry.idleTimer = null;
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (!this.allEntries.has(entry)) return;
      void this.closeEntry(entry).catch(() => undefined);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private closeEntry(entry: ManagedEntry): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    const promise = entry.transport.closeAndWait().finally(() => {
      if (entry.transport.state === 'closed') this.removeEntry(entry);
    });
    entry.closePromise = promise;
    return promise;
  }

  private removeEntry(entry: ManagedEntry): void {
    if (this.entries.get(entry.sessionId) === entry) this.entries.delete(entry.sessionId);
    this.allEntries.delete(entry);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    entry.removeCloseListener();
  }
}

export const openCodeProcessManager = new OpenCodeProcessManager();
