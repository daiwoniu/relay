import { existsSync } from 'node:fs';
import process from 'node:process';
import {
  ZcodeStdioTransport,
  resolveZcodeAppServerEntry,
} from './transport.js';

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export class ZcodeNotInstalledError extends Error {
  constructor() {
    super('ZCODE_NOT_INSTALLED');
    this.name = 'ZcodeNotInstalledError';
  }
}

export interface ZcodeProcessManagerOptions {
  idleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
  createTransport?: (cwd: string) => ZcodeStdioTransport;
}

interface ManagedEntry {
  transport: ZcodeStdioTransport;
  cwd: string;
  /** 会话级引用:adapter connect 时 acquire,close 时 release。 */
  refs: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  removeCloseListener: () => void;
  closePromise: Promise<void> | null;
}

/**
 * ZCode app-server 是单进程承载多会话的常驻拓扑(与按会话起子进程的 ACP 引擎不同),
 * 且进程启动时绑定工作区目录。管理器按 cwd 维护共享传输实例:同工作区会话复用同一
 * 进程,不同工作区各自持有独立进程,引用清空后按空闲超时逐进程回收。
 */
export class ZcodeProcessManager {
  private readonly entries = new Map<string, ManagedEntry>();
  private readonly idleTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly exists: (candidate: string) => boolean;
  private readonly createTransport: (cwd: string) => ZcodeStdioTransport;

  constructor(options: ZcodeProcessManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 1) {
      throw new Error('ZCode app-server 空闲时间必须大于 0');
    }
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    // 默认必须是真实文件系统探测:恒真 exists 会让第一个候选路径(可能不存在)被直接选中。
    this.exists = options.exists ?? existsSync;
    this.createTransport = options.createTransport ?? ((cwd) => {
      const executable = resolveZcodeAppServerEntry({ platform: this.platform, env: this.env, exists: this.exists });
      if (!executable) throw new ZcodeNotInstalledError();
      return new ZcodeStdioTransport({ executable, cwd, env: this.env });
    });
  }

  get hasLiveProcess(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.transport.state !== 'closed') return true;
    }
    return false;
  }

  get refCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.refs.size;
    return total;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 会话建立连接时获取共享传输;同 cwd 会话复用同一进程,不同 cwd 各自独立进程。 */
  acquire(sessionId: string, cwd: string): ZcodeStdioTransport {
    const existing = this.entries.get(cwd);
    if (existing && existing.transport.state !== 'closed' && existing.transport.state !== 'closing') {
      this.scheduleIdle(existing);
      existing.refs.add(sessionId);
      return existing.transport;
    }
    if (existing) this.removeEntry(existing);
    const transport = this.createTransport(cwd);
    const entry: ManagedEntry = {
      transport,
      cwd,
      refs: new Set([sessionId]),
      idleTimer: null,
      removeCloseListener: () => undefined,
      closePromise: null,
    };
    entry.removeCloseListener = transport.onClose(() => this.removeEntry(entry));
    this.entries.set(cwd, entry);
    this.scheduleIdle(entry);
    return transport;
  }

  /** 活动信号:刷新指定工作区进程的空闲计时;未指定 cwd 时刷新全部(兼容旧语义)。 */
  touch(cwd?: string): void {
    if (cwd !== undefined) {
      const entry = this.entries.get(cwd);
      if (entry) this.scheduleIdle(entry);
      return;
    }
    for (const entry of this.entries.values()) this.scheduleIdle(entry);
  }

  /** 会话关闭时释放引用;引用清空后该工作区进程进入空闲倒计时。 */
  release(sessionId: string): void {
    for (const entry of this.entries.values()) {
      if (!entry.refs.delete(sessionId)) continue;
      this.scheduleIdle(entry);
    }
  }

  /**
   * 模型目录发现用独立传输：复用 createTransport 的 env 注入逻辑，但**不** acquire/绑定
   * 工作区进程 entry，避免污染真实会话的工作区绑定与空闲回收。调用方负责用完 closeAndWait。
   */
  createDiscoveryTransport(cwd: string): ZcodeStdioTransport {
    return this.createTransport(cwd);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
  }

  private scheduleIdle(entry: ManagedEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.refs.size > 0) {
      entry.idleTimer = null;
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (this.entries.get(entry.cwd) !== entry) return;
      void this.closeEntry(entry).catch(() => undefined);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private async closeEntry(entry: ManagedEntry): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    const promise = entry.transport.closeAndWait(false).finally(() => {
      if (entry.transport.state === 'closed') this.removeEntry(entry);
    });
    entry.closePromise = promise;
    return promise;
  }

  private removeEntry(entry: ManagedEntry): void {
    if (this.entries.get(entry.cwd) === entry) this.entries.delete(entry.cwd);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    entry.removeCloseListener();
  }
}

export const zcodeProcessManager = new ZcodeProcessManager();
