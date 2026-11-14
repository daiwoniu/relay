/**
 * ZCode Protocol app-server 探针:验证 stdio NDJSON 协议握手、会话创建与事件流。
 *
 * 用法(仓库根目录):
 *   npx tsx server/scripts/probe-zcode-protocol.ts --mode availability
 *   npx tsx server/scripts/probe-zcode-protocol.ts --mode basic --output <jsonl 路径>
 *
 * 模式:
 *   availability  仅探测 ZCode 可执行文件是否可启动 app-server(不创建会话)
 *   basic         创建会话、发送最小 prompt、收集事件流直至 turn 完成(真实模型调用)
 *
 * 环境变量:
 *   RELAY_ZCODE_EXECUTABLE  显式指定 zcode.cjs 路径;缺省按常见安装路径与 PATH 探测
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

type ProbeMode = 'availability' | 'basic';

interface ProbeOptions {
  cwd: string;
  output: string | null;
  mode: ProbeMode;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function parseArguments(argv: readonly string[]): ProbeOptions {
  const options: ProbeOptions = { cwd: process.cwd(), output: null, mode: 'availability', timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mode') {
      index += 1;
      const mode = argv[index];
      if (mode !== 'availability' && mode !== 'basic') throw new Error(`未知探针模式:${mode}`);
      options.mode = mode;
    } else if (value === '--output') {
      index += 1;
      options.output = argv[index] ?? null;
    } else if (value === '--timeout-ms') {
      index += 1;
      options.timeoutMs = Number(argv[index]) || DEFAULT_TIMEOUT_MS;
    } else if (value === '--cwd') {
      index += 1;
      options.cwd = argv[index] ?? options.cwd;
    }
  }
  return options;
}

/** ZCode 桌面安装的 app-server 入口(Electron resources 下的 CLI bundle)。 */
export function resolveZcodeExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const explicit = env.RELAY_ZCODE_EXECUTABLE?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = platform === 'win32'
    ? [
      join(env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs'),
      join('C:', sep, 'Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    ]
    : [
      join('/opt', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
      join('/usr', 'lib', 'zcode', 'resources', 'glm', 'zcode.cjs'),
    ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function spawnAppServer(executable: string, cwd: string): ChildProcessWithoutNullStreams {
  const command = executable.endsWith('.cjs') ? process.execPath : executable;
  const args = executable.endsWith('.cjs') ? [executable, 'app-server', `--cwd=${cwd}`] : ['app-server', `--cwd=${cwd}`];
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
}

function answerRuntimePreferences(): Record<string, unknown> {
  return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false };
}

export async function probeZcodeProtocol(options: ProbeOptions): Promise<{ ok: boolean; summary: string; sessionId?: string }> {
  const executable = resolveZcodeExecutable();
  if (!executable) return { ok: false, summary: '未找到 ZCode 可执行文件(设置 RELAY_ZCODE_EXECUTABLE 或安装 ZCode 桌面版)' };
  if (options.mode === 'availability') return { ok: true, summary: `ZCode app-server 入口可用:${executable}` };

  const child = spawnAppServer(executable, options.cwd);
  const captured: unknown[] = [];
  const record = (direction: string, message: unknown) => {
    captured.push({ _direction: direction, ...(message as Record<string, unknown>) });
  };

  const runtimePreferencesIds = new Set<string | number>();
  const pendingServerRequests = new Map<string | number, string>();
  let sessionId: string | null = null;
  let turnCompleted = false;
  let failure: string | null = null;

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(text); } catch { return; }
    const method = typeof message.method === 'string' ? message.method : null;
    const id = message.id as string | number | undefined;
    if (method && id !== undefined && id !== null) {
      record('server-request', message);
      pendingServerRequests.set(id, method);
      if (method === 'session/requestRuntimePreferences') runtimePreferencesIds.add(id);
      else runtimePreferencesIds.add(id); // 未识别的服务器请求统一回空对象,避免阻塞
      child.stdin.write(`${JSON.stringify({ id, result: method === 'session/requestRuntimePreferences' ? answerRuntimePreferences() : {} })}\n`);
      return;
    }
    record('server', message);
    if (message.method === 'session/event') {
      const params = message.params as { type?: string; payload?: { type?: string } } | undefined;
      if ((params?.type ?? params?.payload?.type) === 'turn.completed') turnCompleted = true;
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (text.trim()) failure = failure ?? text.slice(0, 500);
  });

  const timeout = setTimeout(() => { failure = failure ?? '探针超时'; try { child.kill(); } catch { /* 已退出 */ } }, options.timeoutMs);

  let nextId = 100;
  const request = (method: string, params: Record<string, unknown>) => {
    nextId += 1;
    record('client', { id: nextId, method, params });
    child.stdin.write(`${JSON.stringify({ id: nextId, method, params })}\n`);
    return nextId;
  };

  const createdId = request('session/create', {
    workspace: { workspacePath: options.cwd, workspaceKey: options.cwd },
    mode: 'build',
  });
  const createdMessage: Record<string, unknown> = await new Promise((resolve, reject) => {
    const onLine = (message: Record<string, unknown>) => {
      if (message.id === createdId) resolve(message);
    };
    reader.on('line', (line) => {
      try { onLine(JSON.parse(line)); } catch { /* 非JSON行 */ }
    });
    child.on('exit', () => reject(new Error(failure ?? 'app-server 提前退出')));
    setTimeout(() => reject(new Error('session/create 应答超时')), 30_000);
  });
  const createdResult = createdMessage.result as { projection?: { sessionId?: string }; session?: { sessionId?: string } } | undefined;
  sessionId = createdResult?.projection?.sessionId && createdResult.projection.sessionId !== 'unknown'
    ? createdResult.projection.sessionId
    : createdResult?.session?.sessionId ?? null;
  if (!sessionId) {
    clearTimeout(timeout);
    child.kill();
    return { ok: false, summary: `session/create 未返回 sessionId:${JSON.stringify(createdMessage.error ?? {})}` };
  }

  request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
  request('session/send', {
    sessionId,
    content: '只回复两个字母:OK。不要执行任何工具调用。',
  });

  const deadline = Date.now() + options.timeoutMs;
  while (!turnCompleted && Date.now() < deadline && !failure) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  clearTimeout(timeout);
  try { child.kill(); } catch { /* 已退出 */ }

  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, captured.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  }

  if (!turnCompleted) return { ok: false, summary: failure ?? 'turn 未在时限内完成', sessionId: sessionId ?? undefined };
  return {
    ok: true,
    summary: `create/subscribe/send/turn.completed 全链路通过,事件 ${captured.length} 条`,
    sessionId,
  };
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isDirectRun) {
  const options = parseArguments(process.argv.slice(2));
  probeZcodeProtocol(options).then((result) => {
    console.log(`[${result.ok ? 'OK' : 'FAIL'}] ${result.summary}`);
    process.exitCode = result.ok ? 0 : 1;
  }).catch((error: unknown) => {
    console.error('[FAIL]', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
