import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { NdjsonParser } from '../engine/transports/ndjson-parser.js';
import {
  buildKnownProcessGroupTermination,
  buildKnownProcessTreeTermination,
  sanitizeAcpDiagnostic,
} from '../engine/transports/stdio-acp.js';

/** ZCode Protocol 消息:裸 NDJSON,禁止 jsonrpc 字段(服务端直接拒绝)。 */
export interface ZcodeProtocolMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type ZcodeTransportState = 'connecting' | 'open' | 'closing' | 'closed';

export class ZcodeProtocolParseError extends Error {
  constructor(readonly preview: string) {
    super('ZCode app-server stdout 包含无效协议数据');
    this.name = 'ZcodeProtocolParseError';
  }
}

export class ZcodeProcessExitError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(`ZCode app-server 进程异常退出：code=${exitCode ?? 'null'} signal=${signal ?? 'null'}`);
    this.name = 'ZcodeProcessExitError';
  }
}

export interface ZcodeChildProcess {
  readonly pid?: number;
  readonly stdin: NodeJS.WritableStream & { writable: boolean };
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
}

export type SpawnZcodeProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] },
) => ZcodeChildProcess;

export interface ZcodeStdioTransportOptions {
  /** ZCode CLI 入口(zcode.cjs 绝对路径或 PATH 上的可执行)。 */
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnZcodeProcess;
  parseChunk?: (chunk: string, onLine: (line: string) => void) => void;
}

/**
 * 解析 ZCode app-server 入口:优先显式环境变量,其次常见桌面安装路径。
 * 返回 null 表示本机未安装,可用性层据此标记引擎不可用。
 */
export function resolveZcodeAppServerEntry(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exists?: (candidate: string) => boolean;
  } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const explicit = env.RELAY_ZCODE_EXECUTABLE?.trim();
  if (explicit) return exists(explicit) ? explicit : null;
  const candidates = platform === 'win32'
    ? [
      path.join(env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs'),
      path.join('C:', path.sep, 'Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    ]
    : [
      path.join('/opt', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
      path.join('/usr', 'lib', 'zcode', 'resources', 'glm', 'zcode.cjs'),
    ];
  return candidates.find((candidate) => candidate.length > 0 && exists(candidate)) ?? null;
}

interface SpawnedZcodeProcess {
  child: ZcodeChildProcess;
  stderr: string;
}

function defaultSpawn(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): SpawnedZcodeProcess {
  const command = executable.toLowerCase().endsWith('.cjs') ? process.execPath : executable;
  const args = executable.toLowerCase().endsWith('.cjs') ? [executable, 'app-server', `--cwd=${cwd}`] : ['app-server', `--cwd=${cwd}`];
  const childEnv: NodeJS.ProcessEnv = { ...env };
  // app-server 按入口脚本相对路径定位 builtin provider 配置,其硬编码的向上层级
  // 假设与实际安装深度不符时(如 Program Files\ZCode)会启动失败;
  // 直接注入绝对路径绕过该推导(env 键名来自 ZCode bundle 常量)。
  if (executable.toLowerCase().endsWith('.cjs')) {
    const builtinConfig = path.join(path.dirname(executable), '..', 'config', 'provider', 'zcode-builtin.json');
    if (existsSync(builtinConfig)) {
      childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinConfig;
    }
  }
  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ZcodeChildProcess;
  return { child, stderr: '' };
}

/**
 * ZCode app-server 的 stdio NDJSON 双向传输。
 *
 * 与 JSON-RPC 的差异:消息不带 jsonrpc 字段;其余分发语义同构——
 * method+id 是服务器反向请求(必须应答),仅 id 是应答,仅 method 是通知/事件。
 */
export class ZcodeStdioTransport {
  private transportState: ZcodeTransportState = 'connecting';
  private child: ZcodeChildProcess | null = null;
  private stderrBuffer = '';
  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: ZcodeProtocolMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly parser: NdjsonParser;
  private closeRequested = false;
  private closeWait: Promise<void> | undefined;
  /** 进程级请求发号:同一 transport 被多个会话连接共享时,保证 JSON-RPC id 全进程唯一。 */
  private requestIdSequence = 0;

  constructor(private readonly options: ZcodeStdioTransportOptions) {
    this.parser = new NdjsonParser({
      onMessage: (message) => {
        for (const listener of this.messageListeners) listener(message as ZcodeProtocolMessage);
      },
      onError: (error) => {
        this.emitError(new ZcodeProtocolParseError(error.preview));
        void this.closeAndWait(true).catch((closeError) => this.emitError(closeError));
      },
    });
    queueMicrotask(() => this.start());
  }

  nextRequestId(): number {
    return ++this.requestIdSequence;
  }

  get state(): ZcodeTransportState {
    return this.transportState;
  }

  get exitCode(): number | null {
    return this.child ? (this.child as { exitCode?: number | null }).exitCode ?? null : null;
  }

  send(message: ZcodeProtocolMessage): void {
    if (this.transportState !== 'open' || !this.child?.stdin.writable) {
      throw new Error('ZCode app-server transport 未连接');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    void this.closeAndWait(false).catch((error) => this.emitError(error));
  }

  terminate(): void {
    void this.closeAndWait(true).catch((error) => this.emitError(error));
  }

  async closeAndWait(force: boolean): Promise<void> {
    if (this.transportState === 'closed') return;
    const first = !this.closeRequested;
    this.closeRequested = true;
    this.transportState = 'closing';
    const child = this.child;
    if (!child) {
      this.finalizeClose();
      return;
    }
    if (!this.closeWait) {
      const wait = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('ZCODE_PROCESS_CLOSE_UNCONFIRMED')); }, 2_000);
        timer.unref?.();
        const off = this.onClose(() => { clearTimeout(timer); off(); resolve(); });
      });
      this.closeWait = wait;
      void wait.finally(() => { if (this.closeWait === wait) this.closeWait = undefined; }).catch(() => undefined);
    }
    if (first && child.stdin.writable) child.stdin.end();
    if (force) {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
    await this.closeWait;
  }

  diagnostic(): string {
    return sanitizeAcpDiagnostic(this.stderrBuffer, {
      cwd: this.options.cwd,
      homeDir: process.env.USERPROFILE ?? process.env.HOME ?? '',
    });
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    if (this.transportState === 'open') queueMicrotask(listener);
    return () => this.openListeners.delete(listener);
  }

  onMessage(listener: (message: ZcodeProtocolMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    if (this.transportState === 'closed') queueMicrotask(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private start(): void {
    if (this.transportState !== 'connecting') return;
    try {
      const env = this.options.env ?? process.env;
      const spawned = this.options.spawnProcess
        ? { child: this.options.spawnProcess(this.options.executable, ['app-server', `--cwd=${this.options.cwd}`], { cwd: this.options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) }
        : defaultSpawn(this.options.executable, this.options.cwd, env);
      const child = spawned.child;
      this.child = child;
      child.stdout.on('data', (chunk: string | Uint8Array) => this.parser.push(chunk));
      child.stdout.on('end', () => this.parser.end());
      child.stderr.on('data', (chunk: unknown) => {
        this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-8_000);
      });
      child.once('spawn', () => this.markOpen());
      child.once('error', (error: unknown) => {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
        // Node emits close after error. An error by itself is not proof the process or its pipes have exited.
      });
      child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (!this.closeRequested) {
          const exitError = new ZcodeProcessExitError(code, signal);
          const stderrTail = this.diagnostic().slice(-600);
          if (stderrTail) exitError.message = `${exitError.message} | stderr: ${stderrTail}`;
          this.emitError(exitError);
        }
      });
      child.once('close', () => this.finalizeClose());
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      if (this.child) void this.closeAndWait(true).catch(closeError => this.emitError(closeError));
      else this.finalizeClose();
    }
  }

  private markOpen(): void {
    if (this.transportState !== 'connecting') return;
    this.transportState = 'open';
    for (const listener of this.openListeners) listener();
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private finalizeClose(): void {
    if (this.transportState === 'closed') return;
    this.parser.end();
    this.transportState = 'closed';
    for (const listener of this.closeListeners) listener();
  }
}

export { buildKnownProcessGroupTermination, buildKnownProcessTreeTermination };
