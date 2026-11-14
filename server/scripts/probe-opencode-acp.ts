import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  _direction?: 'client' | 'server';
  _probe?: string;
};

type ProbeMode = 'readiness' | 'availability' | 'basic' | 'model' | 'failure';

interface ProbeOptions {
  cwd: string;
  output: string;
  mode: ProbeMode;
  timeoutMs: number;
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_TIMEOUT_MS = 60_000;
const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|sessiontoken|connectionid|api[_-]?key|access[_-]?token|refresh[_-]?token|provider[_-]?key)$/i;
const ID_KEY = /(?:id|uuid)$/i;
const TIME_KEY = /(?:timestamp|startedAt|updatedAt|createdAt)$/i;

function opencodeLaunch(extraArgs: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: 'opencode', args: ['acp', ...extraArgs] };
  }
  const patheExtList = ['.EXE', '.COM', '.BAT', '.CMD'];
  const packagedEntrypoint = path.join(String(process.env.APPDATA || ''), 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  const entrypoint = existsSync(packagedEntrypoint)
    ? packagedEntrypoint
    : String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => patheExtList.map((ext) => path.join(directory, `opencode${ext.toLowerCase()}`)))
    .find((candidate) => existsSync(candidate))
    ;
  if (!existsSync(entrypoint)) throw new Error('OPENCODE_CLI_NOT_INSTALLED');
  return { command: entrypoint, args: ['acp', ...extraArgs] };
}

function parseArguments(argv: string[]): ProbeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`未知参数：${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少值`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  const cwd = values.get('cwd');
  const output = values.get('output');
  const mode = values.get('mode') as ProbeMode | undefined;
  if (!cwd) throw new Error('必须显式传入 --cwd 临时目录');
  if (!output) throw new Error('必须显式传入 --output fixture 文件');
  if (!mode || !['readiness', 'availability', 'basic', 'model', 'failure'].includes(mode)) {
    throw new Error('--mode 必须是 readiness、availability、basic、model 或 failure');
  }
  const timeoutMs = Number(values.get('timeout-ms') || DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000) {
    throw new Error('--timeout-ms 必须是 1000–180000 之间的整数');
  }
  return { cwd: path.resolve(cwd), output: path.resolve(output), mode, timeoutMs };
}

async function validateProbePaths(options: ProbeOptions): Promise<void> {
  await mkdir(options.cwd, { recursive: true });
  const resolvedCwd = await realpath(options.cwd);
  const formalWorkspace = path.join(PROJECT_ROOT, 'workspace');
  if (resolvedCwd === PROJECT_ROOT || resolvedCwd === formalWorkspace) {
    throw new Error('探针 cwd 不得使用项目根目录或正式 workspace');
  }
  if (!resolvedCwd.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new Error('探针 cwd 必须位于当前功能 worktree 内');
  }
  if (!options.output.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new Error('fixture 输出必须位于当前功能 worktree 内');
  }
}

class FixtureSanitizer {
  private readonly idMap = new Map<string, string>();

  constructor(private readonly probeCwd: string) {}

  sanitizeEnvelope(envelope: JsonRpcEnvelope, direction: 'client' | 'server'): JsonRpcEnvelope {
    return { ...(this.sanitizeValue(envelope, '') as JsonRpcEnvelope), _direction: direction };
  }

  private sanitizeValue(value: unknown, key: string): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.sanitizeValue(entry, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([entryKey]) => !SENSITIVE_KEY.test(entryKey))
          .map(([entryKey, entryValue]) => [entryKey, this.sanitizeValue(entryValue, entryKey)]),
      );
    }
    if (typeof value === 'number' && TIME_KEY.test(key)) return 0;
    if (typeof value !== 'string') return value;
    if (TIME_KEY.test(key)) return '<TIMESTAMP>';
    if (value.includes('<system-reminder') || value.length > 8_000) return '<REDACTED_SYSTEM_CONTEXT>';
    if (ID_KEY.test(key) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) {
      let replacement = this.idMap.get(value);
      if (!replacement) {
        replacement = `<ID_${this.idMap.size + 1}>`;
        this.idMap.set(value, replacement);
      }
      return replacement;
    }
    return value
      .replaceAll(this.probeCwd, '<PROBE_CWD>')
      .replaceAll(os.homedir(), '<USER_HOME>')
      .replaceAll(PROJECT_ROOT, '<PROJECT_ROOT>')
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/g, '<ABSOLUTE_PATH>')
      .replace(/\/(?:Users|home|root|private|var\/folders)\/[^\s"'<>]+/gi, '<ABSOLUTE_PATH>')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <REDACTED>');
  }
}

class AcpProbeProcess {
  private readonly pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly events: JsonRpcEnvelope[] = [];
  private requestId = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private stderr = '';

  constructor(
    private readonly cwd: string,
    private readonly timeoutMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new Error('OpenCode ACP 探针进程已启动');
    const launch = opencodeLaunch([]);
    this.child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_000);
    });
    this.child.once('error', (error) => this.rejectAll(error));
    this.child.once('exit', (code, signal) => {
      this.rejectAll(new Error(`OpenCode ACP 进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
  }

  get recordedEvents(): readonly JsonRpcEnvelope[] { return this.events; }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.requestId;
    const envelope = { jsonrpc: '2.0', id, method, params };
    this.write(envelope);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.lineReader?.close();
    this.lineReader = null;
    if (!child) return;
    if (child.stdin.writable) child.stdin.end();
    if (child.exitCode === null) {
      if (process.platform === 'win32' && child.pid) {
        await Promise.race([
          new Promise<void>((resolve) => {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true, stdio: 'ignore',
            });
            killer.once('exit', () => resolve());
            killer.once('error', () => resolve());
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
      } else {
        child.kill('SIGTERM');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    this.child = null;
    this.rejectAll(new Error('OpenCode ACP 探针已关闭'));
  }

  diagnostic(): string {
    return this.stderr
      .replaceAll(this.cwd, '<PROBE_CWD>')
      .replaceAll(os.homedir(), '<USER_HOME>')
      .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <REDACTED>')
      .slice(-2_000);
  }

  private write(envelope: JsonRpcEnvelope): void {
    if (!this.child?.stdin.writable) throw new Error('OpenCode ACP stdin 不可写');
    this.events.push({ ...envelope, _direction: 'client' });
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let envelope: JsonRpcEnvelope;
    try {
      envelope = JSON.parse(line) as JsonRpcEnvelope;
    } catch {
      this.rejectAll(new Error(`OpenCode ACP stdout 出现非 JSON-RPC 内容：${line.slice(0, 120)}`));
      return;
    }
    this.events.push({ ...envelope, _direction: 'server' });
    if (envelope.id !== undefined && !envelope.method) {
      const pending = this.pending.get(envelope.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(envelope.id);
      if (envelope.error) pending.reject(new Error(JSON.stringify(envelope.error)));
      else pending.resolve(envelope.result);
      return;
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function initialize(probe: AcpProbeProcess): Promise<void> {
  await probe.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'relay-opencode-probe', version: '1.0.0' },
  });
}

function sessionIdFrom(result: any): string {
  const sessionId = result?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error(`session/new 未返回 sessionId：${JSON.stringify(result)}`);
  }
  return sessionId;
}

async function runAvailabilityProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probe = new AcpProbeProcess(options.cwd, options.timeoutMs);
  try {
    await probe.start();
    await initialize(probe);
    const sessionId = sessionIdFrom(await probe.request('session/new', { cwd: options.cwd, mcpServers: [] }));
    await probe.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '只回复 OK' }] });
    return [...probe.recordedEvents];
  } finally {
    await probe.close();
  }
}

async function runReadinessProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probe = new AcpProbeProcess(options.cwd, options.timeoutMs);
  try {
    await probe.start();
    await initialize(probe);
    const result = await probe.request('session/new', { cwd: options.cwd, mcpServers: [] });
    sessionIdFrom(result);
    return [...probe.recordedEvents];
  } finally {
    await probe.close();
  }
}

async function runBasicProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probes = [new AcpProbeProcess(options.cwd, options.timeoutMs), new AcpProbeProcess(options.cwd, options.timeoutMs)];
  try {
    await Promise.all(probes.map(async (probe) => { await probe.start(); await initialize(probe); }));
    const sessions = await Promise.all(probes.map((probe) => probe.request('session/new', { cwd: options.cwd, mcpServers: [] })));
    await Promise.all(probes.map((probe, index) => probe.request('session/prompt', {
      sessionId: sessionIdFrom(sessions[index]),
      prompt: [{ type: 'text', text: '只回复 ACP_' + (index + 1) }],
    })));
    return probes.flatMap((probe, index) => probe.recordedEvents.map((event) => ({ ...event, _probe: String(index + 1) })));
  } catch (error) {
    throw new Error(
      (error instanceof Error ? error.message : String(error))
      + '\n' + probes.map((probe) => probe.diagnostic()).filter(Boolean).join('\n'),
    );
  } finally {
    await Promise.all(probes.map((probe) => probe.close()));
  }
}

async function runModelProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probe = new AcpProbeProcess(options.cwd, options.timeoutMs);
  try {
    await probe.start();
    await initialize(probe);
    const result: any = await probe.request('session/new', { cwd: options.cwd, mcpServers: [] });
    const sessionId = sessionIdFrom(result);
    const modelOption = (result?.configOptions ?? []).find((option: any) => option.id === 'model' && option.category === 'model');
    const model = modelOption?.options?.find((opt: any) => opt.value !== modelOption.currentValue);
    if (model?.value) await probe.request('session/set_model', { sessionId, modelId: model.value });
    await probe.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '只回复 MODEL_OK' }] });
    return [...probe.recordedEvents];
  } finally {
    await probe.close();
  }
}

async function runFailureProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probe = new AcpProbeProcess(options.cwd, options.timeoutMs);
  try {
    await probe.start();
    await initialize(probe);
    await probe.request('session/delete', { sessionId: 'relay-probe-session-does-not-exist' }).catch(() => undefined);
    return [...probe.recordedEvents];
  } finally {
    await probe.close();
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await validateProbePaths(options);
  const events = options.mode === 'readiness'
    ? await runReadinessProbe(options)
    : options.mode === 'availability'
      ? await runAvailabilityProbe(options)
    : options.mode === 'basic'
      ? await runBasicProbe(options)
      : options.mode === 'model'
        ? await runModelProbe(options)
        : await runFailureProbe(options);
  const sanitizer = new FixtureSanitizer(options.cwd);
  const content = events
    .map((event) => JSON.stringify(sanitizer.sanitizeEnvelope(event, event._direction || 'server')))
    .join('\n');
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${content}\n`, 'utf8');
  console.log(`OpenCode ACP ${options.mode} fixture 已写入：${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
