import { spawn } from 'node:child_process';
import os from 'node:os';
import type {
  JsonRpcEnvelope,
  JsonRpcTransport,
  JsonRpcTransportState,
} from './transport.js';
import { NdjsonParser, type NdjsonParserError } from './ndjson-parser.js';

export interface AcpChildProcess {
  readonly pid?: number;
  readonly stdin: NodeJS.WritableStream & { writable: boolean };
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
}

export interface AcpSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  detached: boolean;
  stdio: ['pipe', 'pipe', 'pipe'];
}

export type SpawnAcpProcess = (
  command: string,
  args: readonly string[],
  options: AcpSpawnOptions,
) => AcpChildProcess;

export type TerminateAcpProcess = (child: AcpChildProcess, force: boolean) => Promise<void>;

export class StdioAcpTransportParseError extends Error {
  constructor(
    readonly parserCode: NdjsonParserError['code'],
    readonly preview: string,
  ) {
    super('CodeBuddy ACP stdout 包含无效协议数据');
    this.name = 'StdioAcpTransportParseError';
  }
}

export class AcpProcessExitError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(`CodeBuddy ACP 进程异常退出：code=${exitCode ?? 'null'} signal=${signal ?? 'null'}`);
    this.name = 'AcpProcessExitError';
  }
}

export class AcpProcessStartupTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`CodeBuddy ACP 进程启动超时（${timeoutMs}ms）`);
    this.name = 'AcpProcessStartupTimeoutError';
  }
}

export interface StdioAcpTransportOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  spawnProcess?: SpawnAcpProcess;
  terminateProcess?: TerminateAcpProcess;
}

function waitForChildCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    const finish = () => resolve();
    killer.once('exit', finish);
    killer.once('error', finish);
  });
}

export function buildKnownProcessTreeTermination(
  pid: number | undefined,
  platform = process.platform,
): { command: string; args: string[] } | null {
  if (platform !== 'win32' || !pid) return null;
  return { command: 'taskkill.exe', args: ['/PID', String(pid), '/T', '/F'] };
}

export function buildKnownProcessGroupTermination(
  pid: number | undefined,
  force: boolean,
  platform = process.platform,
): { pid: number; signal: NodeJS.Signals } | null {
  if (platform === 'win32' || !pid) return null;
  return { pid: -pid, signal: force ? 'SIGKILL' : 'SIGTERM' };
}

export async function terminateKnownProcessTree(
  child: AcpChildProcess,
  force: boolean,
  platform = process.platform,
): Promise<void> {
  if (child.exitCode !== null) return;
  const treeCommand = buildKnownProcessTreeTermination(child.pid, platform);
  if (treeCommand) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      waitForChildCommand(treeCommand.command, treeCommand.args).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return;
  }
  const groupTermination = buildKnownProcessGroupTermination(child.pid, force, platform);
  if (groupTermination) {
    try {
      process.kill(groupTermination.pid, groupTermination.signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

export function sanitizeAcpDiagnostic(
  value: string,
  options: { cwd: string; homeDir: string },
): string {
  let sanitized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const [secret, replacement] of [
    [options.cwd, '<CWD>'],
    [options.homeDir, '<USER_HOME>'],
  ] as const) {
    if (!secret) continue;
    const variants = new Set([secret, secret.replaceAll('\\', '/'), secret.replaceAll('/', '\\')]);
    for (const variant of variants) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(escaped, 'gi'), replacement);
    }
  }
  sanitized = sanitized
    .replace(/\b(?:authorization|cookie|set-cookie|sessiontoken|connectionid|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\r\n]+/gi, '<REDACTED>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer <REDACTED>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<REDACTED>');
  return sanitized.slice(-2_000);
}

export class StdioAcpTransport implements JsonRpcTransport {
  private transportState: JsonRpcTransportState = 'connecting';
  private child: AcpChildProcess | null = null;
  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: JsonRpcEnvelope) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly parser: NdjsonParser;
  private stderr = '';
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private closeRequested = false;
  private closePromise: Promise<void> | null = null;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });

  constructor(private readonly options: StdioAcpTransportOptions) {
    this.parser = new NdjsonParser({
      onMessage: (message) => {
        for (const listener of this.messageListeners) listener(message);
      },
      onError: (error) => this.handleParserError(error),
    });
    queueMicrotask(() => this.start());
  }

  get state(): JsonRpcTransportState {
    return this.transportState;
  }

  send(message: JsonRpcEnvelope): void {
    if (this.transportState !== 'open' || !this.child?.stdin.writable) {
      throw new Error('CodeBuddy ACP stdio transport 未连接');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    void this.closeAndWait().catch((error) => this.emitError(error));
  }

  terminate(): void {
    void this.closeAndWait(true).catch((error) => this.emitError(error));
  }

  async closeAndWait(force = false): Promise<void> {
    if (this.transportState === 'closed') return;
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.transportState = 'closing';
    this.clearStartupTimer();
    const child = this.child;
    const operation = (async () => {
      if (!child) {
        this.finalizeClose();
        return;
      }
      if (child.stdin.writable) child.stdin.end();
      await (this.options.terminateProcess ?? terminateKnownProcessTree)(child, force);
      const timeoutMs = this.options.shutdownTimeoutMs ?? 2_000;
      try {
        await this.waitUntilClosed(timeoutMs);
      } catch (error) {
        if (force || this.transportState === 'closed') throw error;
        await (this.options.terminateProcess ?? terminateKnownProcessTree)(child, true);
        await this.waitUntilClosed(timeoutMs);
      }
    })();
    this.closePromise = operation.catch((error) => {
      this.closePromise = null;
      throw error;
    });
    return this.closePromise;
  }

  diagnostic(): string {
    return sanitizeAcpDiagnostic(this.stderr, {
      cwd: this.options.cwd,
      homeDir: this.options.homeDir ?? os.homedir(),
    });
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    if (this.transportState === 'open') queueMicrotask(listener);
    return () => this.openListeners.delete(listener);
  }

  onMessage(listener: (message: JsonRpcEnvelope) => void): () => void {
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
      const spawnProcess = this.options.spawnProcess ?? ((command, args, spawnOptions) => (
        spawn(command, [...args], spawnOptions) as AcpChildProcess
      ));
      const child = spawnProcess(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      child.stdout.on('data', (chunk) => this.parser.push(chunk instanceof Uint8Array ? chunk : String(chunk)));
      child.stdout.on('end', () => this.parser.end());
      child.stderr.on('data', (chunk) => {
        this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_000);
      });
      child.once('spawn', () => this.markOpen());
      child.once('error', (error) => {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
        this.finalizeClose();
      });
      child.once('exit', (code, signal) => {
        if (!this.closeRequested) this.emitError(new AcpProcessExitError(code, signal));
      });
      child.once('close', () => this.finalizeClose());
      const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
      this.startupTimer = setTimeout(() => {
        if (this.transportState !== 'connecting') return;
        this.emitError(new AcpProcessStartupTimeoutError(timeoutMs));
        void this.closeAndWait(true).catch((error) => this.emitError(error));
      }, timeoutMs);
      this.startupTimer.unref?.();
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      this.finalizeClose();
    }
  }

  private markOpen(): void {
    if (this.transportState !== 'connecting') return;
    this.clearStartupTimer();
    this.transportState = 'open';
    for (const listener of this.openListeners) listener();
  }

  private handleParserError(error: NdjsonParserError): void {
    const sanitizedPreview = sanitizeAcpDiagnostic(error.preview, {
      cwd: this.options.cwd,
      homeDir: this.options.homeDir ?? os.homedir(),
    });
    this.emitError(new StdioAcpTransportParseError(error.code, sanitizedPreview));
    void this.closeAndWait(true).catch((closeError) => this.emitError(closeError));
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private waitUntilClosed(timeoutMs: number): Promise<void> {
    if (this.transportState === 'closed') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`CodeBuddy ACP 进程关闭超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.closed.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private clearStartupTimer(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private finalizeClose(): void {
    if (this.transportState === 'closed') return;
    this.clearStartupTimer();
    this.parser.end();
    this.transportState = 'closed';
    this.resolveClosed();
    for (const listener of this.closeListeners) listener();
  }
}
