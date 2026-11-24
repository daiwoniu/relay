import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { JsonRpcTransport } from '../engine/transports/transport.js';
import { StdioAcpTransport } from '../engine/transports/stdio-acp.js';

const DEFAULT_MAX_PROCESSES = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const CODEBUDDY_SESSION_ARGS = [
  '--acp', '--acp-transport', 'stdio', '--agent', 'cli', '--permission-mode', 'default',
] as const;
export const CODEBUDDY_MODEL_DISCOVERY_ARGS = [
  ...CODEBUDDY_SESSION_ARGS, '--tools', '', '--no-session-persistence',
] as const;
const CODEBUDDY_FEISHU_ARGS = [
  ...CODEBUDDY_MODEL_DISCOVERY_ARGS, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
] as const;

export interface ManagedCodeBuddyTransport extends JsonRpcTransport {
  closeAndWait(force?: boolean): Promise<void>;
  diagnostic(): string;
}

export interface CodeBuddyLaunch {
  command: string;
  args: string[];
}

export function resolveCodeBuddyLaunch(
  argumentsList: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    envPath?: string;
    execPath?: string;
    exists?: (candidate: string) => boolean;
  } = {},
): CodeBuddyLaunch {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { command: 'codebuddy', args: [...argumentsList] };
  const exists = options.exists ?? existsSync;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const entrypoint = (options.envPath ?? process.env.PATH ?? '')
    .split(platform === 'win32' ? ';' : path.delimiter)
    .filter(Boolean)
    .map((directory) => pathApi.join(
      directory,
      'node_modules',
      '@tencent-ai',
      'codebuddy-code',
      'bin',
      'codebuddy',
    ))
    .find((candidate) => exists(candidate));
  if (!entrypoint) throw new Error('CODEBUDDY_CLI_NOT_INSTALLED');
  return { command: options.execPath ?? process.execPath, args: [entrypoint, ...argumentsList] };
}

export function createFeishuCodeBuddyTransport(cwd: string): ManagedCodeBuddyTransport {
  const launch = resolveCodeBuddyLaunch(CODEBUDDY_FEISHU_ARGS);
  return new StdioAcpTransport({ ...launch, cwd });
}

export class CodeBuddyProcessLimitError extends Error {
  constructor(readonly limit: number) {
    super(`CodeBuddy 活动子进程已达到上限（${limit}）`);
    this.name = 'CodeBuddyProcessLimitError';
  }
}

export interface CodeBuddyProcessManagerOptions {
  maxProcesses?: number;
  idleTimeoutMs?: number;
  readVersion?: () => string | null;
  createTransport?: (cwd: string, sessionId: string) => ManagedCodeBuddyTransport;
  createDiscoveryTransport?: (cwd: string) => ManagedCodeBuddyTransport;
}

interface ManagedEntry {
  sessionId: string;
  transport: ManagedCodeBuddyTransport;
  idleTimer: ReturnType<typeof setTimeout> | null;
  removeCloseListener: () => void;
  busy: boolean;
  version: string | null;
  closePromise: Promise<void> | null;
}

export class CodeBuddyProcessManager {
  private readonly entries = new Map<string, ManagedEntry>();
  private readonly allEntries = new Set<ManagedEntry>();
  private readonly maxProcesses: number;
  private readonly idleTimeoutMs: number;
  private readonly readVersion: () => string | null;
  private readonly createTransport: (cwd: string, sessionId: string) => ManagedCodeBuddyTransport;
  private readonly createDiscoveryTransport: (cwd: string) => ManagedCodeBuddyTransport;

  constructor(options: CodeBuddyProcessManagerOptions = {}) {
    this.maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.readVersion = options.readVersion ?? (() => null);
    if (!Number.isInteger(this.maxProcesses) || this.maxProcesses < 1) {
      throw new Error('CodeBuddy 子进程上限必须是正整数');
    }
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 1) {
      throw new Error('CodeBuddy 子进程空闲时间必须大于 0');
    }
    this.createTransport = options.createTransport ?? ((cwd) => {
      const launch = resolveCodeBuddyLaunch(CODEBUDDY_SESSION_ARGS);
      return new StdioAcpTransport({
        command: launch.command,
        args: launch.args,
        cwd,
      });
    });
    this.createDiscoveryTransport = options.createDiscoveryTransport ?? ((cwd) => {
      const launch = resolveCodeBuddyLaunch(CODEBUDDY_MODEL_DISCOVERY_ARGS);
      return new StdioAcpTransport({ command: launch.command, args: launch.args, cwd });
    });
  }

  get size(): number {
    return this.allEntries.size;
  }

  createModelDiscoveryTransport(cwd: string): ManagedCodeBuddyTransport {
    return this.createDiscoveryTransport(cwd);
  }

  has(sessionId: string): boolean {
    return [...this.allEntries].some((entry) => entry.sessionId === sessionId);
  }

  getOrCreate(sessionId: string, cwd: string): ManagedCodeBuddyTransport {
    const existing = this.entries.get(sessionId);
    if (existing && existing.transport.state !== 'closed' && existing.transport.state !== 'closing') {
      this.scheduleIdle(sessionId, existing);
      return existing.transport;
    }
    if (existing?.transport.state === 'closed') this.removeEntry(existing);
    if (this.allEntries.size >= this.maxProcesses) throw new CodeBuddyProcessLimitError(this.maxProcesses);

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

  async release(sessionId: string, transport?: ManagedCodeBuddyTransport): Promise<void> {
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

export const codeBuddyProcessManager = new CodeBuddyProcessManager();
