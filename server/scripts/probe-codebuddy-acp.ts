import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import net from 'node:net';
import { assertCodeBuddyCancellationResult, assertCodeBuddyPromptCompleted, classifyCodeBuddyPermissionProbe, codeBuddyProbeExitCode } from '../../scripts/lib/codebuddy-maintenance.mjs';

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

type ProbeMode = 'availability' | 'basic' | 'replay' | 'interaction' | 'failure' | 'model' | 'readiness';

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

function codeBuddyLaunch(argumentsList: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'codebuddy', args: argumentsList };
  const entrypoint = (process.env.PATH || '')
    .split(path.delimiter)
    .map((directory) => path.join(
      directory,
      'node_modules',
      '@tencent-ai',
      'codebuddy-code',
      'bin',
      'codebuddy',
    ))
    .find((candidate) => existsSync(candidate));
  if (!entrypoint) throw new Error('CODEBUDDY_CLI_NOT_INSTALLED');
  return { command: process.execPath, args: [entrypoint, ...argumentsList] };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('无法分配 CodeBuddy 探针清理端口');
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  return address.port;
}

async function terminateProcessTree(child: import('node:child_process').ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await Promise.race([
      new Promise<void>((resolve) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('exit', () => resolve());
        killer.once('error', () => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    return;
  }
  child.kill('SIGTERM');
}

async function deletePersistedSession(sessionId: string, cwd: string): Promise<void> {
  const port = await reserveLoopbackPort();
  const gatewayPassword = randomBytes(32).toString('base64url');
  const launch = codeBuddyLaunch([
    '--serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--agent',
    'cli',
    '--permission-mode',
    'default',
    '--auth',
    'password',
    '--no-session-persistence',
  ]);
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: {
      ...process.env,
      CODEBUDDY_GATEWAY_AUTH: 'password',
      CODEBUDDY_GATEWAY_PASSWORD: gatewayPassword,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const headers = {
    'X-CodeBuddy-Request': '1',
    Authorization: `Bearer ${gatewayPassword}`,
  };
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/v1/health', { headers });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // 本地服务尚未开始监听。
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('CodeBuddy 探针清理服务启动超时');
    const response = await fetch(
      'http://127.0.0.1:' + port + '/api/v1/sessions/' + encodeURIComponent(sessionId),
      { method: 'DELETE', headers },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error('CodeBuddy 探针会话清理失败：HTTP ' + response.status);
    }
  } finally {
    await terminateProcessTree(child);
  }
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
  if (!mode || !['availability', 'basic', 'replay', 'interaction', 'failure', 'model', 'readiness'].includes(mode)) {
    throw new Error('--mode 必须是 availability、basic、replay、interaction、failure、model 或 readiness');
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
  private serverRequestHandler: ((envelope: JsonRpcEnvelope) => unknown) | null = null;

  constructor(
    private readonly cwd: string,
    private readonly timeoutMs: number,
    private readonly persistent: boolean,
    private readonly toolsEnabled = false,
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new Error('ACP 探针进程已启动');
    const args = [
      '--acp',
      '--acp-transport',
      'stdio',
      '--agent',
      'cli',
      '--permission-mode',
      'default',
      '--tools',
      this.toolsEnabled ? 'default' : '',
    ];
    if (!this.persistent) args.push('--no-session-persistence');
    const launch = codeBuddyLaunch(args);
    this.child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      env: process.env,
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
      this.rejectAll(new Error(`CodeBuddy ACP 进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
  }

  get recordedEvents(): readonly JsonRpcEnvelope[] {
    return this.events;
  }

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

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  onServerRequest(handler: (envelope: JsonRpcEnvelope) => unknown): void {
    this.serverRequestHandler = handler;
  }

  async waitForEvent(
    predicate: (event: JsonRpcEnvelope) => boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<JsonRpcEnvelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.find(predicate);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('等待 ACP 事件超时（' + timeoutMs + 'ms）');
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
              windowsHide: true,
              stdio: 'ignore',
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
    this.rejectAll(new Error('CodeBuddy ACP 探针已关闭'));
  }

  private write(envelope: JsonRpcEnvelope): void {
    if (!this.child?.stdin.writable) throw new Error('CodeBuddy ACP stdin 不可写');
    this.events.push({ ...envelope, _direction: 'client' });
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let envelope: JsonRpcEnvelope;
    try {
      envelope = JSON.parse(line) as JsonRpcEnvelope;
    } catch {
      this.rejectAll(new Error(`CodeBuddy ACP stdout 出现非 JSON-RPC 内容：${line.slice(0, 120)}`));
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
    if (envelope.id !== undefined && envelope.method) {
      const result = this.serverRequestHandler?.(envelope);
      if (result === undefined) {
        this.write({
          jsonrpc: '2.0',
          id: envelope.id,
          error: { code: -32601, message: 'Relay 探针不支持服务端请求：' + envelope.method },
        });
      } else {
        this.write({ jsonrpc: '2.0', id: envelope.id, result });
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  diagnostic(): string {
    return this.stderr
      .replaceAll(this.cwd, '<PROBE_CWD>')
      .replaceAll(os.homedir(), '<USER_HOME>')
      .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <REDACTED>')
      .replace(/\b(authorization|cookie|sessiontoken|connectionid|api[_-]?key|access[_-]?token|refresh[_-]?token|provider[_-]?key)\b\s*[:=]\s*[^\s,"']+/gi, '$1=<REDACTED>')
      .slice(-2_000);
  }
}

async function initialize(processHandle: AcpProbeProcess): Promise<void> {
  await processHandle.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'relay-codebuddy-probe', version: '1.0.0' },
  });
}

async function runAvailabilityProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probe = new AcpProbeProcess(options.cwd, options.timeoutMs, false);
  try {
    await probe.start();
    await initialize(probe);
    const sessionId = sessionIdFrom(await probe.request('session/new', {
      cwd: options.cwd,
      mcpServers: [],
    }));
    const promptResult = await probe.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '只回复 OK' }],
    });
    assertCodeBuddyPromptCompleted(promptResult);
    return [...probe.recordedEvents];
  } finally {
    await probe.close();
  }
}

async function runModelProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probe = new AcpProbeProcess(options.cwd, options.timeoutMs, false);
  try {
    await probe.start();
    await initialize(probe);
    const created: any = await probe.request('session/new', { cwd: options.cwd, mcpServers: [] });
    const sessionId = sessionIdFrom(created);
    const model = created?.models?.availableModels?.find((candidate: any) => candidate.modelId !== created.models.currentModelId);
    if (!model?.modelId) throw new Error('CodeBuddy 未提供可切换的非默认模型');
    await probe.request('session/set_model', { sessionId, modelId: model.modelId });
    const thought = created?.configOptions?.find((option: any) => option.id === 'thought_level');
    const effort = thought?.options?.find((option: any) => option.value !== thought.currentValue);
    if (effort?.value) await probe.request('session/set_config_option', { sessionId, configId: 'thought_level', value: effort.value });
    assertCodeBuddyPromptCompleted(await probe.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '只回复 MODEL_OK' }] }));
    return [...probe.recordedEvents];
  } finally {
    await probe.close();
  }
}

function sessionIdFrom(result: any): string {
  const sessionId = result?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error(`session/new 未返回 sessionId：${JSON.stringify(result)}`);
  }
  return sessionId;
}

async function runBasicProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probes = [
    new AcpProbeProcess(options.cwd, options.timeoutMs, false),
    new AcpProbeProcess(options.cwd, options.timeoutMs, false),
  ];
  try {
    await Promise.all(probes.map(async (probe) => {
      await probe.start();
      await initialize(probe);
    }));
    const sessions = await Promise.all(probes.map((probe) => (
      probe.request('session/new', { cwd: options.cwd, mcpServers: [] })
    )));
    await Promise.all(probes.map(async (probe, index) => assertCodeBuddyPromptCompleted(await probe.request('session/prompt', {
      sessionId: sessionIdFrom(sessions[index]),
      prompt: [{ type: 'text', text: '只回复 ACP_' + (index + 1) }],
    }))));
    return probes.flatMap((probe, index) => (
      probe.recordedEvents.map((event) => ({ ...event, _probe: String(index + 1) }))
    ));
  } catch (error) {
    throw new Error(
      (error instanceof Error ? error.message : String(error))
      + '\n'
      + probes.map((probe) => probe.diagnostic()).filter(Boolean).join('\n'),
    );
  } finally {
    await Promise.all(probes.map((probe) => probe.close()));
  }
}

async function runReplayProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const first = new AcpProbeProcess(options.cwd, options.timeoutMs, true);
  const second = new AcpProbeProcess(options.cwd, options.timeoutMs, true);
  let sessionId = '';
  try {
    await first.start();
    await initialize(first);
    sessionId = sessionIdFrom(await first.request('session/new', {
      cwd: options.cwd,
      mcpServers: [],
    }));
    assertCodeBuddyPromptCompleted(await first.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '本轮对话暗号是 RELAY_FIRST，只回复 FIRST' }],
    }));
    await first.close();

    await second.start();
    await initialize(second);
    await second.request('session/load', { sessionId, cwd: options.cwd, mcpServers: [] });
    assertCodeBuddyPromptCompleted(await second.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '前一轮标记是什么？只回复 SECOND:标记' }],
    }));
    return [
      ...first.recordedEvents.map((event) => ({ ...event, _probe: 'replay-source' })),
      ...second.recordedEvents.map((event) => ({ ...event, _probe: 'replay-resume' })),
    ];
  } finally {
    await Promise.all([first.close(), second.close()]);
    if (sessionId) await deletePersistedSession(sessionId, options.cwd);
  }
}

async function runInteractionProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probe = new AcpProbeProcess(options.cwd, options.timeoutMs, false, true);
  let permissionRequested = false;
  try {
    probe.onServerRequest((envelope) => {
      if (envelope.method === 'session/request_permission') {
        permissionRequested = true;
        return { outcome: { outcome: 'cancelled' } };
      }
      return undefined;
    });
    await probe.start();
    await initialize(probe);
    const sessionId = sessionIdFrom(await probe.request('session/new', {
      cwd: options.cwd,
      mcpServers: [],
    }));
    const permissionPromptResult = await probe.request('session/prompt', {
      sessionId,
      prompt: [{
        type: 'text',
        text: '请使用 Bash 执行 Write-Output CODEBUDDY_PROBE，未经允许不要改用其他方式。',
      }],
    }).catch(() => undefined);
    classifyCodeBuddyPermissionProbe(permissionRequested, permissionPromptResult);
    const cancelPrompt = probe.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '请从 1 到 1000 逐项解释，收到取消前不要提前结束。' }],
    });
    await probe.waitForEvent((event) => {
      const update = (event.params as any)?.update;
      return update?.sessionUpdate === 'agent_thought_chunk'
        || update?._meta?.['codebuddy.ai/agentPhase']?.phase === 'model_requesting';
    }, Math.min(options.timeoutMs, 30_000));
    probe.notify('session/cancel', { sessionId });
    const cancelResult = await cancelPrompt;
    assertCodeBuddyCancellationResult(cancelResult);
    return [...probe.recordedEvents];
  } finally {
    await probe.close();
  }
}

async function runFailureProbe(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  const probe = new AcpProbeProcess(options.cwd, options.timeoutMs, false);
  try {
    await probe.start();
    await initialize(probe);
    await probe.request('session/delete', {
      sessionId: 'relay-probe-session-does-not-exist',
    }).catch(() => undefined);
    return [...probe.recordedEvents];
  } finally {
    await probe.close();
  }
}

async function runSingleMode(options: ProbeOptions): Promise<JsonRpcEnvelope[]> {
  if (options.mode === 'availability') return runAvailabilityProbe(options);
  if (options.mode === 'basic') return runBasicProbe(options);
  if (options.mode === 'replay') return runReplayProbe(options);
  if (options.mode === 'interaction') return runInteractionProbe(options);
  if (options.mode === 'model') return runModelProbe(options);
  if (options.mode === 'readiness') {
    const basic = await runBasicProbe(options);
    const replay = await runReplayProbe(options);
    const interaction = await runInteractionProbe(options);
    return [
      ...basic.map((event) => ({ ...event, _probe: `readiness-basic-${event._probe || 'event'}` })),
      ...replay.map((event) => ({ ...event, _probe: `readiness-${event._probe || 'replay'}` })),
      ...interaction.map((event) => ({ ...event, _probe: 'readiness-interaction' })),
    ];
  }
  return runFailureProbe(options);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await validateProbePaths(options);
  const events = await runSingleMode(options);
  const sanitizer = new FixtureSanitizer(options.cwd);
  const content = events
    .map((event) => JSON.stringify(sanitizer.sanitizeEnvelope(event, event._direction || 'server')))
    .join('\n');
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${content}\n`, 'utf8');
  console.log(`CodeBuddy ACP ${options.mode} fixture 已写入：${options.output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = codeBuddyProbeExitCode(error);
});
