import { createHash, randomUUID } from 'node:crypto';
import type {
  EngineAdapter,
  EngineAvailability,
  EngineConnection,
  EngineConnectionOptions,
  EngineEvent,
  EngineTurnItem,
  EngineTurnOptions,
} from '../engine/adapter.js';
import { ENGINE_CATALOG } from '../engine/catalog.js';
import { createEngineEventEmitter, type EngineEventSource } from '../engine/events.js';
import { createUncheckedEngineHealth, type EngineLocalHealth } from '../engine/health.js';
import { validateEngineConcurrencyResource, type EngineConcurrencyContext } from '../engine/concurrency/types.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import { defineNormalizedInteraction, type InteractionAction, type NormalizedInteractionKind } from '../engine/interactions.js';
import { ZcodeStdioTransport, resolveZcodeAppServerEntry } from './transport.js';
import { zcodeProcessManager } from './process-manager.js';
import { mapZcodeError, ZcodePromptStalledError } from './errors.js';

const DEFAULT_CANCEL_CONFIRMATION_TIMEOUT_MS = 10_000;
export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 20 * 60_000;

/**
 * 服务器反向请求按 transport 实例去重:同工作区多个会话共享进程时,每条反向请求
 * 只由第一个看到的连接应答一次,避免向 app-server 重复回包。
 */
const answeredServerRequests = new WeakMap<object, Set<string | number>>();

type RecordValue = Record<string, any>;
type ZcodeUsage = Extract<EngineEvent, { type: 'token_usage' }>['usage'];

/** ZCode 权限请求 options 里 kind 与 optionId 的映射(实测 optionId 为 allow_project)。 */
const PERMISSION_ACTIONS: Record<string, InteractionAction> = {
  allow_once: 'accept_once',
  allow_always: 'accept_for_session',
  allow_project: 'accept_for_session',
  deny: 'decline',
};

function toolNameFromPermission(params: RecordValue): string | undefined {
  return typeof params.toolName === 'string' ? params.toolName : undefined;
}

function interactionKind(params: RecordValue): NormalizedInteractionKind {
  const toolName = toolNameFromPermission(params);
  const input = params.input && typeof params.input === 'object' ? params.input as RecordValue : {};
  if (typeof input.command === 'string' || toolName && /^(?:bash|shell|terminal|execute|command|printf)$/i.test(toolName)) return 'command';
  if (typeof input.file_path === 'string' || typeof input.path === 'string' || toolName && /^(?:write|edit|multiedit|applypatch|notebookedit)$/i.test(toolName)) return 'file';
  return 'permissions';
}

export const zcodeInteractionAdapter: EngineInteractionAdapter = {
  normalize(request) {
    if (request.method === 'interaction/requestPermission') {
      const params = request.params as RecordValue;
      const kind = interactionKind(params);
      const title = kind === 'command'
        ? '需要授权执行命令'
        : kind === 'file'
          ? '需要授权修改文件'
          : '需要授权使用工具';
      const options = Array.isArray(params.options) ? params.options : [];
      const availableActions = [...new Set(options.flatMap((option: RecordValue) => {
        const action = typeof option?.kind === 'string' ? PERMISSION_ACTIONS[option.kind] : undefined;
        return action ? [action] : [];
      })), 'cancel' as const] as InteractionAction[];
      const input = params.input && typeof params.input === 'object' ? params.input : {};
      // 文件路径同时映射到白名单内的 path 字段：rawInput 不在 presenter 详情白名单里，
      // 只放 rawInput 会让文件授权卡片没有任何可展示详情。
      const filePath = typeof input.file_path === 'string' ? input.file_path
        : typeof input.path === 'string' ? input.path : undefined;
      return defineNormalizedInteraction({
        requestId: request.requestId,
        kind,
        snapshot: {
          title,
          toolName: toolNameFromPermission(params),
          reason: typeof params.reason === 'string' ? params.reason : undefined,
          command: typeof input.command === 'string' ? input.command : undefined,
          ...(filePath ? { path: filePath } : {}),
          rawInput: Object.fromEntries(Object.entries(input).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))),
          availableDecisions: [...options.map((option: RecordValue) => option?.kind === 'allow_once' ? 'accept' : option?.kind === 'allow_always' || option?.kind === 'allow_project' ? 'acceptForSession' : 'decline'), 'cancel'],
        },
        availableActions,
      });
    }
    if (request.method === 'session/request_user_input') {
      return defineNormalizedInteraction({
        requestId: request.requestId,
        kind: 'user_input',
        snapshot: { ...(request.params as RecordValue), title: '引擎需要你的回答' },
        availableActions: ['submit', 'cancel'],
      });
    }
    return defineNormalizedInteraction({
      requestId: request.requestId,
      kind: 'unknown',
      snapshot: { title: '需要处理客户端请求' },
      availableActions: [],
    });
  },
  buildResponse(request, command) {
    if (request.method === 'interaction/requestPermission') {
      const params = request.params as RecordValue;
      const options = Array.isArray(params.options) ? params.options : [];
      if (command.action === 'cancel') return {};
      // 实测报文 kind 与 optionId 不一一对应(allow_always/allow_project),按两者并集匹配。
      const acceptedKinds = command.action === 'accept_once'
        ? ['allow_once']
        : command.action === 'accept_for_session'
          ? ['allow_always', 'allow_project']
          : command.action === 'decline'
            ? ['deny']
            : [];
      const selected = options.find((option: RecordValue) => (
        option && typeof option === 'object'
        && (acceptedKinds.includes(option.kind) || (command.action === 'accept_for_session' && option.kind === 'allow_always' && option.optionId === 'allow_project'))
      )) as RecordValue | undefined;
      // ZCode 空对象应答会被按拒绝处理;命中项回预置 response 体,缺 response 时回 optionId。
      if (acceptedKinds.length === 0 || !selected) return {};
      if (selected.response && typeof selected.response === 'object') return selected.response;
      return { optionId: typeof selected.optionId === 'string' ? selected.optionId : acceptedKinds[0] };
    }
    if (request.method === 'session/request_user_input') {
      if (command.action === 'cancel') return {};
      if (command.action !== 'submit') throw new Error('该输入决定当前不可用');
      return { answers: command.answers || {} };
    }
    throw new Error(`暂不支持处理 ZCode 请求：${request.method}`);
  },
};

/** session/create(resume) result 的 settings.model.available → 统一模型目录。 */
export function parseZcodeModelCatalog(result: RecordValue, engineId = 'zcode' as const): EngineModelCatalog {
  const available = Array.isArray(result?.settings?.model?.available) ? result.settings.model.available : [];
  const models = available.flatMap((entry: RecordValue) => {
    const modelId = typeof entry?.ref?.modelId === 'string' ? entry.ref.modelId : null;
    const label = typeof entry?.label === 'string' && entry.label.trim() ? entry.label : modelId;
    if (!modelId || !label) return [];
    const levels = Array.isArray(entry?.reasoning?.levels)
      ? entry.reasoning.levels.flatMap((level: RecordValue) => (
        typeof level?.value === 'string' && typeof level?.label === 'string'
          ? [{ id: level.value, label: level.label }]
          : []
      ))
      : [];
    const defaultLevel = typeof entry?.reasoning?.defaultLevel === 'string' ? entry.reasoning.defaultLevel : undefined;
    const contextWindow = Number.isFinite(Number(entry?.contextWindow)) ? Number(entry.contextWindow) : undefined;
    const supportsImage = entry?.properties?.inputFormat?.supportsImage === true;
    return [{
      id: modelId,
      displayName: label,
      isDefault: entry?.ref?.modelId === result?.settings?.model?.current?.modelId,
      inputModalities: supportsImage ? ['text', 'image'] as const : ['text'] as const,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      reasoning: {
        supported: levels.length > 0,
        scope: 'session' as const,
        ...(defaultLevel && levels.some((level: { id: string }) => level.id === defaultLevel) ? { defaultOptionId: defaultLevel } : {}),
        options: levels,
      },
    }];
  });
  return { engineId, fetchedAt: Date.now(), stale: false, models };
}

function stableId(sessionId: string, kind: string, sequence: number): string {
  return `zcode:${createHash('sha256').update(`${sessionId}:${kind}:${sequence}`).digest('hex').slice(0, 20)}`;
}

/**
 * ZCode 的任务计划由 TodoWrite 工具承载（无独立 plan 事件）:input.todos / result.content
 * 都是 {content, status, priority} 数组。解析为统一 plan 快照，供前端计划卡片消费;
 * status 与 codex 对齐（pending/in_progress/completed），未知值丢弃。
 */
export function parseZcodeTodoPlan(value: unknown): Array<{ step: string; status: string }> | null {
  const todos = Array.isArray(value) ? value : null;
  if (!todos) return null;
  const plan = todos.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as RecordValue;
    if (typeof record.content !== 'string' || !record.content.trim()) return [];
    const status = record.status === 'completed' ? 'completed' : record.status === 'in_progress' ? 'in_progress' : 'pending';
    return [{ step: record.content.trim(), status }];
  });
  return plan.length > 0 ? plan : [];
}

interface ActiveZcodePrompt {
  turnId: string;
  completed: boolean;
  finalContent: string;
  processContent: string;
  latestUsage: ZcodeUsage | null;
  cancelRequested: boolean;
  started: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  rejectStall: (error: Error) => void;
  promise: Promise<void>;
}

export interface ZcodeAdapterOptions {
  getAvailability?: () => EngineAvailability;
  requestTimeoutMs?: number;
  cancelConfirmationTimeoutMs?: number;
  promptIdleTimeoutMs?: number;
  diagnostic?: (message: string) => void;
  inspectLocalHealth?: () => Promise<EngineLocalHealth>;
  listModels?: () => Promise<EngineModelCatalog>;
  manager?: typeof zcodeProcessManager;
}

export class ZcodeAdapter implements EngineAdapter {
  readonly id = 'zcode' as const;
  readonly descriptor = ENGINE_CATALOG.zcode;
  private readonly getCurrentAvailability: () => EngineAvailability;
  private readonly requestTimeoutMs: number;
  private readonly cancelConfirmationTimeoutMs: number;
  private readonly promptIdleTimeoutMs: number;
  private readonly diagnostic: (message: string) => void;
  private readonly listModelsImpl: () => Promise<EngineModelCatalog>;
  private readonly manager: typeof zcodeProcessManager;
  private cachedCatalog: EngineModelCatalog | null = null;
  private discoveryInFlight: Promise<EngineModelCatalog> | null = null;
  private modelProviders = new Map<string, string>();
  readonly health;
  readonly concurrency = {
    resolveResource: (_context: EngineConcurrencyContext) => validateEngineConcurrencyResource({
      resourceKey: 'zcode:default',
      providerKey: null,
      label: this.descriptor.label,
      defaultMaxActiveTurns: 4,
    }),
  };
  readonly interactions = zcodeInteractionAdapter;
  // 恢复快照协议未实现：resume 声明会让重启后的会话永久停留在"恢复中"
  // （zcode adapter 不产生 recovery_snapshot，runtime 无超时兜底）。
  // 在补齐恢复协议前按 codebuddy/opencode 口径声明 interrupt，重启即明确收尾。
  readonly recovery = { restartMode: 'interrupt' as const };

  constructor(options: ZcodeAdapterOptions = {}) {
    this.manager = options.manager ?? zcodeProcessManager;
    this.getCurrentAvailability = options.getAvailability ?? (() => {
      const installed = resolveZcodeAppServerEntry() !== null;
      return installed
        ? { available: true, code: 'AVAILABLE' }
        : { available: false, code: 'ZCODE_NOT_INSTALLED', message: '未检测到 ZCode 桌面应用' };
    });
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.cancelConfirmationTimeoutMs = options.cancelConfirmationTimeoutMs ?? DEFAULT_CANCEL_CONFIRMATION_TIMEOUT_MS;
    this.promptIdleTimeoutMs = options.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.listModelsImpl = options.listModels ?? (async () => {
      if (this.cachedCatalog) return this.cachedCatalog;
      return this.discoverCatalog();
    });
    this.health = {
      inspectLocal: options.inspectLocalHealth ?? (async () => {
        const availability = this.getCurrentAvailability();
        return createUncheckedEngineHealth({
          engineId: this.id,
          available: availability.available,
          code: availability.code,
          message: availability.message || (availability.available ? 'ZCode 可用' : '未检测到 ZCode 桌面应用'),
          process: 'on_demand',
        });
      }),
    };
  }

  readonly availability = { getCurrent: () => this.getCurrentAvailability() };
  readonly diagnostics = { classify: mapZcodeError };
  readonly runtime = { connect: (options: EngineConnectionOptions) => this.connect(options) };
  readonly models = { listModels: () => this.listModelsImpl() };
  readonly sessions = { forkSession: (externalSessionId: string, cwd: string, target: { kind: 'latest' } | { kind: 'turn'; turnIndex: number },mayDispatch?:()=>Promise<boolean>) => this.forkSession(externalSessionId, cwd, target,mayDispatch) };

  /**
   * session/fork 建立继承历史的新会话:latest 取引擎最新检查点,turn 按第 N 轮 user 输入
   * 锚定该轮 assistant 回复。子会话由 ZCode 持久化,Relay 只返回其外部 ID。
   */
  private async forkSession(externalSessionId: string, cwd: string, target: { kind: 'latest' } | { kind: 'turn'; turnIndex: number },mayDispatch?:()=>Promise<boolean>): Promise<{ forkedSessionId: string; targetMessageId?: string }> {
    const transport = this.manager.createDiscoveryTransport(cwd);
    let requestId = 0;
    const pending = new Map<string, {
      resolve: (value: RecordValue) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }>();
    const request = (method: string, params: RecordValue, timeoutMs = 30_000): Promise<RecordValue> => {
      const id = `zfk-${++requestId}`;
      return new Promise<RecordValue>((resolve, reject) => {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 请求超时（${timeoutMs}ms）`));
        }, timeoutMs) : null;
        timer?.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          transport.send({ id, method, params });
        } catch (error) {
          if (timer) clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };
    const offMessage = transport.onMessage((message) => {
      // 同 discoverCatalog:session/fork 期间 app-server 可能发反向请求,必须应答。
      if (message.method && message.id !== undefined && message.id !== null) {
        try {
          transport.send({ id: message.id, result: message.method === 'session/requestRuntimePreferences'
            ? {
              nativeSearchEnhancementsEnabled: false,
              memoryEnabled: false,
              askUserQuestionAutoResolutionEnabled: false,
            }
            : {} });
        } catch {}
        return;
      }
      if (message.id === undefined || message.id === null) return;
      const key = String(message.id);
      const entry = pending.get(key);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(key);
      if (message.error) {
        const text = typeof message.error.message === 'string' ? message.error.message : 'ZCode 请求失败';
        entry.reject(Object.assign(new Error(text), { rpcCode: message.error.code }));
      } else {
        entry.resolve((message.result ?? {}) as RecordValue);
      }
    });
    const waitForOpen = () => new Promise<void>((resolve, reject) => {
      if (transport.state === 'open') return resolve();
      const offOpen = transport.onOpen(() => { cleanup(); resolve(); });
      const offError = transport.onError((error) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); });
      const offClose = transport.onClose(() => { cleanup(); reject(new Error('ZCode fork 传输已关闭')); });
      const cleanup = () => { offOpen(); offError(); offClose(); };
    });
    try {
      await waitForOpen();
      if(mayDispatch&&!await mayDispatch())throw new Error('FORK_AUTHORITY_CHANGED');
      const result = await request('session/fork', {
        sessionId: externalSessionId,
        target: target.kind === 'latest'
          ? { kind: 'latestCheckpoint' }
          : { kind: 'turn', turnIndex: target.turnIndex },
      }, 60_000);
      const forkedSessionId = typeof result?.forkedSessionId === 'string' ? result.forkedSessionId : null;
      if (!forkedSessionId) throw new Error('ZCode 未返回 forkedSessionId');
      return {
        forkedSessionId,
        ...(typeof result?.targetMessageId === 'string' ? { targetMessageId: result.targetMessageId } : {}),
      };
    } finally {
      offMessage();
      for (const [, entry] of pending) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error('ZCode fork 已取消'));
      }
      pending.clear();
      await transport.closeAndWait(true);
    }
  }

  /** 供 adapter 内部缓存 create/resume 观察到的模型目录。 */
  private captureCatalog(catalog: EngineModelCatalog): void {
    if (catalog.models.length > 0) this.cachedCatalog = catalog;
  }

  /** 上游 provider 可能对模型强制要求显式推理等级;偏好为空时以模型目录默认等级兜底。 */
  private defaultReasoningFor(modelId: string | null): string | null {
    if (!modelId) return null;
    const model = this.cachedCatalog?.models.find((candidate) => candidate.id === modelId);
    return model?.reasoning.defaultOptionId ?? null;
  }

  /**
   * 模型目录尚未被会话观察时主动探测：启动一个独立 app-server 传输(不绑定全局单进程
   * entry，避免污染真实会话的工作区绑定与空闲回收)，session/create 拿 settings.model.available
   * 并缓存，使「选择引擎」即可加载模型，不必等首条消息。对齐 opencode discoverOpenCodeModels
   * 的独立传输 + finally 清理 + 单飞模式。
   */
  private async discoverCatalog(cwd: string = process.cwd()): Promise<EngineModelCatalog> {
    if (this.discoveryInFlight) return this.discoveryInFlight;
    this.discoveryInFlight = (async () => {
      const transport = this.manager.createDiscoveryTransport(cwd);
      let requestId = 0;
      const pending = new Map<string, {
        resolve: (value: RecordValue) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout> | null;
      }>();
      const request = (method: string, params: RecordValue, timeoutMs = 30_000): Promise<RecordValue> => {
        const id = `zmd-${++requestId}`;
        return new Promise<RecordValue>((resolve, reject) => {
          const timer = timeoutMs > 0 ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} 请求超时（${timeoutMs}ms）`));
          }, timeoutMs) : null;
          timer?.unref?.();
          pending.set(id, { resolve, reject, timer });
          try {
            transport.send({ id, method, params });
          } catch (error) {
            if (timer) clearTimeout(timer);
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      };
      const offMessage = transport.onMessage((message) => {
        // app-server 在 session/create 期间会发反向请求;不应答(如 session/requestRuntimePreferences)
        // 会让它等引擎应答直到超时,create 永不返回,前端模型列表卡在加载中。
        if (message.method && message.id !== undefined && message.id !== null) {
          try {
            transport.send({ id: message.id, result: message.method === 'session/requestRuntimePreferences'
              ? {
                nativeSearchEnhancementsEnabled: false,
                memoryEnabled: false,
                askUserQuestionAutoResolutionEnabled: false,
              }
              : {} });
          } catch {}
          return;
        }
        if (message.id === undefined || message.id === null) return;
        const key = String(message.id);
        const entry = pending.get(key);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        pending.delete(key);
        if (message.error) {
          const text = typeof message.error.message === 'string' ? message.error.message : 'ZCode 请求失败';
          entry.reject(Object.assign(new Error(text), { rpcCode: message.error.code }));
        } else {
          entry.resolve((message.result ?? {}) as RecordValue);
        }
      });
      const waitForOpen = () => new Promise<void>((resolve, reject) => {
        if (transport.state === 'open') return resolve();
        const offOpen = transport.onOpen(() => { cleanup(); resolve(); });
        const offError = transport.onError((error) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); });
        const offClose = transport.onClose(() => { cleanup(); reject(new Error('ZCode 模型发现传输已关闭')); });
        const cleanup = () => { offOpen(); offError(); offClose(); };
      });
      try {
        await waitForOpen();
        const result = await request('session/create', {
          workspace: { workspacePath: cwd, workspaceKey: cwd },
          mode: 'build',
        });
        const catalog = parseZcodeModelCatalog(result);
        this.captureCatalog(catalog);
        return catalog;
      } finally {
        offMessage();
        for (const [, entry] of pending) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(new Error('ZCode 模型发现已取消'));
        }
        pending.clear();
        void transport.closeAndWait(true).catch(() => undefined);
      }
    })()
      .then((catalog) => { this.discoveryInFlight = null; return catalog; }, (error) => { this.discoveryInFlight = null; throw error; });
    return this.discoveryInFlight;
  }

  private connect(options: EngineConnectionOptions): EngineConnection {
    if (!options.cwd) throw new Error('ZCode 会话缺少项目目录');
    let closed = false;
    let sequence = 0;
    let externalSessionId = options.externalSessionId;
    let readyPromise: Promise<void>;
    let activePrompt: ActiveZcodePrompt | null = null;
    /** send 受理后 activePrompt 会被 finally 清空;终态 turn.completed 用它投影 message_complete。 */
    let lastPrompt: ActiveZcodePrompt | null = null;
    let currentModelId: string | null = null;
    let currentReasoningLevel: string | null = null;
    /** turn.completed 不带 contextWindow;从 create/resume result 与 session.updated 事件跟踪。 */
    let lastObservedContextWindow: number | null = null;
    /**
     * ZCode 自动压缩对 app-server 客户端零协议事件(仅内部日志),唯一可见信号是
     * 上下文占用(totalTokens)骤降。跟踪最近观测值,骤降超阈值判定发生了一次压缩。
     * 压缩通知需要幂等身份(threadId+turnId)供服务端去重计数,压缩标识用观测 token 数锚定。
     */
    let lastContextTokens: number | null = null;
    /** 最后一步模型请求的单步用量(session.updated);turn.completed 的 usage 是回合累计计费口径。 */
    let lastStepUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number } | null = null;
    let activeRequestCount = 0;
    const pendingRequests = new Map<string | number, {
      resolve: (value: RecordValue) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }>();

    const emitEnvelope = createEngineEventEmitter({ engineId: this.id, emit: options.onEvent });
    const emit = (event: EngineEvent, source: EngineEventSource = 'realtime', eventId?: string) => {
      if (closed) return;
      emitEnvelope(event, {
        source,
        ...(eventId ? { eventId } : {}),
        ...(externalSessionId ? { externalSessionId } : {}),
        ...('turnId' in event && typeof event.turnId === 'string' ? { externalTurnId: event.turnId } : {}),
      });
    };
    const emitError = (error: unknown, source: EngineEventSource = 'realtime') => {
      emit({ type: 'error', diagnostic: mapZcodeError(error) }, source);
    };

    const transport = this.manager.acquire(options.sessionId, options.cwd);
    const touchProcess = () => this.manager.touch(options.cwd);

    const request = (method: string, params: RecordValue, timeoutMs: number = this.requestTimeoutMs): Promise<RecordValue> => {
      // id 由 transport 进程级发号:多会话共享进程时 id 全进程唯一,应答不会命中其他连接的 pending 表。
      const id = transport.nextRequestId();
      activeRequestCount += 1;
      const effectiveTimeout = timeoutMs > 0 ? timeoutMs : null;
      return new Promise<RecordValue>((resolve, reject) => {
        const timer = effectiveTimeout === null ? null : setTimeout(() => {
          pendingRequests.delete(id);
          activeRequestCount -= 1;
          reject(new Error(`${method} 请求超时（${effectiveTimeout}ms）`));
        }, effectiveTimeout);
        timer?.unref?.();
        pendingRequests.set(id, { resolve, reject, timer });
        try {
          transport.send({ id, method, params });
        } catch (error) {
          if (timer) clearTimeout(timer);
          pendingRequests.delete(id);
          activeRequestCount -= 1;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    const refreshPromptActivity = () => {
      const prompt = activePrompt;
      if (!prompt?.started) return;
      if (prompt.idleTimer) clearTimeout(prompt.idleTimer);
      prompt.idleTimer = setTimeout(() => {
        prompt.rejectStall(new ZcodePromptStalledError(this.promptIdleTimeoutMs));
      }, this.promptIdleTimeoutMs);
      prompt.idleTimer.unref?.();
    };

    const offTransportMessage = transport.onMessage((message) => {
      if (message.method && message.id !== undefined && message.id !== null) {
        // 服务器反向请求:runtime preferences 必答,其余透传给交互层或回空对象。
        // 共享进程的多个连接都会收到广播,只有第一个看到的连接应答并去重。
        // 授权/用户输入类反向请求 params 带 sessionId(实测 fixtures):与本连接会话
        // 不符时直接跳过,由会话归属连接认领,修复授权卡片串到无关会话。
        const messageParams = message.params && typeof message.params === 'object' ? message.params as RecordValue : {};
        const messageSessionId = typeof messageParams.sessionId === 'string' ? messageParams.sessionId : undefined;
        if (messageSessionId && externalSessionId && messageSessionId !== externalSessionId) return;
        // 连接就绪前无法判定会话归属:带 sessionId 的授权/用户输入请求不应答、不去重,
        // 留给归属连接处理;提前去重会让未就绪连接吞掉请求,归属连接永远无法认领。
        if (!externalSessionId && messageSessionId
          && (message.method === 'interaction/requestPermission' || message.method === 'session/request_user_input')) return;
        let answered = answeredServerRequests.get(transport as unknown as object);
        if (!answered) {
          answered = new Set();
          answeredServerRequests.set(transport as unknown as object, answered);
        }
        if (answered.has(message.id)) return;
        answered.add(message.id);
        if (message.method === 'session/requestRuntimePreferences') {
          transport.send({ id: message.id, result: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
          } });
          return;
        }
        touchProcess();
        refreshPromptActivity();
        if (message.method === 'interaction/requestPermission' || message.method === 'session/request_user_input') {
          emit({
            type: 'server_request',
            requestId: message.id,
            method: message.method,
            params: messageParams,
          }, 'realtime', typeof message.id === 'string' ? message.id : undefined);
          return;
        }
        transport.send({ id: message.id, result: {} });
        emit({ type: 'system_notice', noticeType: 'warning', title: 'ZCode 请求不受支持', message: String(message.method) });
        return;
      }
      if (message.id !== undefined && message.id !== null) {
        const entry = pendingRequests.get(message.id);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        pendingRequests.delete(message.id);
        activeRequestCount -= 1;
        if (message.error) {
          const errorText = typeof message.error.message === 'string' ? message.error.message : 'ZCode 请求失败';
          entry.reject(Object.assign(new Error(errorText), { rpcCode: message.error.code }));
        } else {
          entry.resolve((message.result ?? {}) as RecordValue);
        }
        return;
      }
      if (message.method === 'session/event') {
        touchProcess();
        refreshPromptActivity();
        handleEvent(message.params as RecordValue);
      }
    });

    const handleEvent = (params: RecordValue) => {
      if (!params || params.sessionId !== externalSessionId) return;
      const type = typeof params.type === 'string' ? params.type : '';
      const payload = params.payload && typeof params.payload === 'object' ? params.payload as RecordValue : {};
      const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
      const eventId = typeof params.eventId === 'string' ? params.eventId : undefined;
      // Subscribe/resume may replay old events while a new prompt is still being prepared.
      if(activePrompt&&!activePrompt.started&&['session.updated','model.streaming','tool.updated','turn.completed'].includes(type))return;
      // session.updated(模型每步流结束)携带权威 contextWindow 与单步上下文占用,供终态
      // token_usage 投影与压缩检测。占用较上次观测骤降过半(且上次至少 5 万 token,排除正常
      // 波动)判定 ZCode 在后台自动压缩了一次上下文,投影 context_compaction 通知驱动前端计数。
      if (type === 'session.updated') {
        if (Number.isFinite(Number(payload.contextWindow)) && Number(payload.contextWindow) > 0) {
          lastObservedContextWindow = Number(payload.contextWindow);
        }
        const stepUsage = payload.usage && typeof payload.usage === 'object' ? payload.usage as RecordValue : {};
        const observed = Number(stepUsage.totalTokens);
        if (Number.isFinite(observed) && observed > 0) {
          if (lastContextTokens !== null && observed < lastContextTokens * 0.5 && lastContextTokens >= 50_000) {
            emit({
              type: 'system_notice',
              noticeType: 'context_compaction',
              title: '已整理上下文',
              message: `ZCode 已自动压缩较早的上下文（${Math.round(lastContextTokens).toLocaleString()} → ${Math.round(observed).toLocaleString()} Tokens）。`,
              contextCompaction: {
                threadId: externalSessionId!,
                turnId: `zcode-compact:${Math.round(lastContextTokens)}->${Math.round(observed)}`,
              },
            }, 'realtime', eventId);
          }
          lastContextTokens = observed;
          // 记录最后一步的单步用量,终态投影用真实上下文占用而非回合累计。
          lastStepUsage = {
            inputTokens: Number(stepUsage.inputTokens ?? 0),
            cachedInputTokens: Number(stepUsage.cacheReadTokens ?? 0),
            outputTokens: Number(stepUsage.outputTokens ?? 0),
            reasoningOutputTokens: Number(stepUsage.reasoningTokens ?? 0),
          };
        }
      }
      if (type === 'model.streaming') {
        const kind = typeof payload.kind === 'string' ? payload.kind : '';
        const assistantMessageId = typeof payload.assistantMessageId === 'string' ? payload.assistantMessageId : stableId(options.sessionId, 'msg', ++sequence);
        if (kind === 'text_delta' && typeof payload.delta === 'string' && payload.delta) {
          const prompt=activePrompt??lastPrompt;if(!prompt?.started||prompt.completed)return;
          prompt.finalContent += payload.delta;
          emit({ type: 'delta', itemId: assistantMessageId, content: payload.delta, phase: 'final_answer' }, 'realtime', eventId);
          return;
        }
        if (kind === 'reasoning_delta' && typeof payload.delta === 'string' && payload.delta) {
          const prompt=activePrompt??lastPrompt;if(!prompt?.started||prompt.completed)return;
          prompt.processContent += payload.delta;
          emit({ type: 'delta', itemId: `${assistantMessageId}:commentary`, content: payload.delta, phase: 'commentary' }, 'realtime', eventId);
          return;
        }
        if (kind === 'tool_call') {
          const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : stableId(options.sessionId, 'tool', ++sequence);
          const toolName = typeof payload.toolName === 'string' ? payload.toolName : undefined;
          // TodoWrite 承载任务计划:映射为统一 plan item(与 codex turn/plan/updated 同型),工具卡本身不重复展示。
          if (toolName && /^(?:todo_?write|todowrite)$/i.test(toolName)) {
            const plan = parseZcodeTodoPlan(payload.input && typeof payload.input === 'object' ? (payload.input as RecordValue).todos : undefined);
            if (plan) {
              emit({
                type: 'item_complete',
                item: { id: `relay-plan:${toolCallId}`, type: 'plan', status: 'completed', plan },
              }, 'realtime', eventId);
              return;
            }
          }
          const item: EngineTurnItem = {
            id: toolCallId,
            type: 'dynamicToolCall',
            status: 'in_progress',
            details: {
              title: toolName,
              toolName,
              input: payload.input && typeof payload.input === 'object' ? payload.input : undefined,
            },
          };
          emit({ type: 'item_start', item }, 'realtime', eventId);
          return;
        }
        return;
      }
      if (type === 'tool.updated') {
        const kind = typeof payload.kind === 'string' ? payload.kind : '';
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : stableId(options.sessionId, 'tool', ++sequence);
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : undefined;
        if (kind === 'scheduled' || kind === 'started') {
          if (toolName && /^(?:todo_?write|todowrite)$/i.test(toolName)) return;
          const item: EngineTurnItem = {
            id: toolCallId,
            type: 'dynamicToolCall',
            status: 'in_progress',
            details: { toolName },
          };
          emit({ type: 'item_start', item }, 'realtime', eventId);
          return;
        }
        if (kind === 'result') {
          const result = payload.result && typeof payload.result === 'object' ? payload.result as RecordValue : {};
          if (toolName && /^(?:todo_?write|todowrite)$/i.test(toolName)) {
            // result.content 是 {oldTodos, todos, summary} 的 JSON 字符串;取最新 todos 投影计划卡片。
            let todos: unknown = undefined;
            if (typeof result.content === 'string') {
              try { todos = JSON.parse(result.content)?.todos; } catch {}
            } else if (result.content && typeof result.content === 'object') {
              todos = (result.content as RecordValue).todos;
            }
            const plan = parseZcodeTodoPlan(todos);
            if (plan) {
              emit({
                type: 'item_complete',
                item: { id: `relay-plan:${toolCallId}`, type: 'plan', status: 'completed', plan },
              }, 'realtime', eventId);
              return;
            }
          }
          const item: EngineTurnItem = {
            id: toolCallId,
            type: 'dynamicToolCall',
            status: 'completed',
            details: {
              toolName,
              output: typeof result.content === 'string' ? result.content : undefined,
              success: result.success !== false,
            },
          };
          emit({ type: 'item_complete', item }, 'realtime', eventId);
          return;
        }
        if (kind === 'tool_error') {
          if (toolName && /^(?:todo_?write|todowrite)$/i.test(toolName)) return;
          const item: EngineTurnItem = {
            id: toolCallId,
            type: 'dynamicToolCall',
            status: 'completed',
            details: {
              toolName,
              success: false,
            },
          };
          emit({ type: 'item_complete', item }, 'realtime', eventId);
        }
        return;
      }
      if (type === 'permission.requested' || type === 'permission.resolved' || type === 'session.titleUpdated' || type === 'session.updated' || type === 'streamRecovery.updated') {
        // 权限决策通知由反向请求通道承载;标题/会话投影/恢复锚点事件 Relay 不消费。
        return;
      }
      if (type === 'turn.completed') {
        const prompt=activePrompt??lastPrompt;if(prompt?.completed)return;
        const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as RecordValue : {};
        // turn.completed 的 usage 是整回合累计计费口径(每步全量 input 重复计入,长回合远超窗口),
        // 不能当作上下文占用;上下文占用以最后一步 session.updated 的单步用量为准。
        // outputTokens 是逐次请求的真实产出,累计口径对 output 仍有意义,保留累计值。
        const step = lastStepUsage;
        const latestUsage: ZcodeUsage = {
          inputTokens: Number(usage.inputTokens ?? 0),
          cachedInputTokens: Number(usage.cacheReadTokens ?? 0),
          outputTokens: Number(usage.outputTokens ?? 0),
          reasoningOutputTokens: Number(usage.reasoningTokens ?? 0),
          totalTokens: Number(usage.totalTokens ?? Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0)),
          modelContextWindow: lastObservedContextWindow,
        };
        const contextUsage: ZcodeUsage = step
          ? {
            inputTokens: step.inputTokens,
            cachedInputTokens: step.cachedInputTokens,
            outputTokens: Number(usage.outputTokens ?? 0),
            reasoningOutputTokens: Number(usage.reasoningTokens ?? 0),
            totalTokens: step.inputTokens + Number(usage.outputTokens ?? 0),
            modelContextWindow: lastObservedContextWindow,
          }
          : latestUsage;
        // 上下文占用跟踪与会话级 token_usage 用真实单步口径;message_complete 的
        // usage(供 turnOutputUsage 增量)保持累计计费口径不变。
        if (contextUsage.totalTokens > 0) {
          if (lastContextTokens !== null && contextUsage.totalTokens < lastContextTokens * 0.5 && lastContextTokens >= 50_000) {
            emit({
              type: 'system_notice',
              noticeType: 'context_compaction',
              title: '已整理上下文',
              message: `ZCode 已自动压缩较早的上下文（${Math.round(lastContextTokens).toLocaleString()} → ${contextUsage.totalTokens.toLocaleString()} Tokens）。`,
              contextCompaction: {
                threadId: externalSessionId!,
                turnId: `zcode-compact:${Math.round(lastContextTokens)}->${Math.round(contextUsage.totalTokens)}`,
              },
            }, 'request_response', eventId);
          }
          lastContextTokens = contextUsage.totalTokens;
        }
        if (activePrompt) activePrompt.latestUsage = latestUsage;
        emit({ type: 'token_usage', usage: contextUsage }, 'request_response', eventId);
        const content = typeof payload.response === 'string' ? payload.response : '';
        // session/send 受理应答早于 turn.completed;activePrompt 可能在 finally 里已被清空,
        // 终态改用最近的回合上下文投影,保证 message_complete 不丢。
        if (prompt?.started) {
          prompt.completed=true;
          emit({
            type: 'message_complete',
            turnId: prompt.turnId,
            content: content || prompt.finalContent,
            ...(prompt.processContent ? { processContent: prompt.processContent } : {}),
            usage: {
              promptTokens: latestUsage.inputTokens,
              completionTokens: latestUsage.outputTokens,
              totalTokens: latestUsage.totalTokens,
            },
          }, 'request_response', eventId);
        }
        if(lastPrompt===prompt)lastPrompt = null;
        return;
      }
      // turn.started 无需独立事件;模型请求 started/completed 噪声忽略,provider_request_sent 由 send 时发出。
    };

    const closeConnection = (notifyRuntimeLater: boolean) => {
      if (closed) return;
      closed = true;
      offTransportMessage();
      for (const [, entry] of pendingRequests) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error('ZCode app-server 连接已断开'));
      }
      pendingRequests.clear();
      activeRequestCount = 0;
      this.manager.release(options.sessionId);
      if (notifyRuntimeLater) setTimeout(() => options.onClosed(), 0);
    };

    transport.onError((error) => emitError(error, 'process_exit'));
    transport.onClose(() => { if (!closed) closeConnection(true); });

    const waitForOpen = () => new Promise<void>((resolve, reject) => {
      if (transport.state === 'open') return resolve();
      if (transport.state === 'closed') return reject(new Error('ZCode app-server transport 已关闭'));
      const offOpen = transport.onOpen(() => { cleanup(); resolve(); });
      const offError = transport.onError((error) => { cleanup(); reject(error); });
      const offClose = transport.onClose(() => { cleanup(); reject(new Error('ZCode app-server transport 已关闭')); });
      const cleanup = () => { offOpen(); offError(); offClose(); };
    });

    readyPromise = (async () => {
      await waitForOpen();
      options.onPerformanceMilestone?.('transport_opened');
      const params: RecordValue = externalSessionId
        ? { sessionId: externalSessionId, workspace: { workspacePath: options.cwd, workspaceKey: options.cwd } }
        : { workspace: { workspacePath: options.cwd, workspaceKey: options.cwd }, mode: 'build' };
      const result = await request(externalSessionId ? 'session/resume' : 'session/create', params);
      const sessionId = result?.projection?.sessionId && result.projection.sessionId !== 'unknown'
        ? result.projection.sessionId
        : result?.session?.sessionId ?? null;
      if (!sessionId) throw new Error('ZCode 未返回 sessionId');
      externalSessionId = sessionId;
      // 订阅事件流:不订阅则 send 后收不到任何 session/event(流式与终态都依赖它)。
      await request('session/subscribe', { sessionId: externalSessionId, deliveryKind: 'desktop-continuous' });
      options.onPerformanceMilestone?.('external_session_ready');
      try { await options.onSessionReady(externalSessionId!); }
      catch { throw new Error('ZCode 外部会话标识保存失败'); }
      if (closed) throw new Error('ZCode 连接已失效');
      const catalog = parseZcodeModelCatalog(result);
      this.modelProviders = new Map((Array.isArray(result?.settings?.model?.available) ? result.settings.model.available : []).flatMap((entry: RecordValue) => {
        const modelId = entry?.ref?.modelId;
        const providerId = entry?.ref?.providerId;
        return (typeof modelId === 'string' && typeof providerId === 'string') ? [[modelId, providerId]] : [];
      }));
      this.captureCatalog(catalog);
      const current = result?.settings?.model?.current ?? result?.settings?.model?.available?.find?.((model: RecordValue) => model?.isDefault)?.ref ?? null;
      if (current?.modelId) {
        currentModelId = String(current.modelId);
        // create/resume 观察到的生效等级回填状态,后续 setModel 的变更判断以它为基线。
        const observedLevel = typeof current?.options?.reasoningLevel === 'string' ? current.options.reasoningLevel.trim() : '';
        if (observedLevel) currentReasoningLevel = observedLevel;
        emit({ type: 'model_info', model: currentModelId, modelProvider: 'ZCode', ...(current?.options?.reasoningLevel ? { reasoningEffort: String(current.options.reasoningLevel) } : {}) });
      }
      const currentEntry = (Array.isArray(result?.settings?.model?.available) ? result.settings.model.available : [])
        .find?.((model: RecordValue) => model?.ref?.modelId === current?.modelId);
      if (Number.isFinite(Number(currentEntry?.contextWindow)) && Number(currentEntry?.contextWindow) > 0) {
        lastObservedContextWindow = Number(currentEntry.contextWindow);
      }
    })();
    readyPromise.catch((error) => emitError(error));

    const send = (content: string, turnOptions?: EngineTurnOptions) => {
      if (activePrompt || lastPrompt?.started&&!lastPrompt.completed) {
        emit({ type: 'error', diagnostic: {
          code: 'ZCODE_PROVIDER_ERROR', phase: 'send', retryable: false,
          userMessage: 'ZCode 会话已有任务正在执行', providerClass: 'unknown',
        } });
        return;
      }
      emit({ type: 'request_forwarded' }, 'local');
      let rejectStall!: (error: Error) => void;
      const stall = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
      const prompt: ActiveZcodePrompt = {
        turnId: `zcode-turn:${randomUUID()}`,
        completed: false,
        finalContent: '',
        processContent: '',
        latestUsage: null,
        cancelRequested: false,
        started: false,
        idleTimer: null,
        rejectStall,
        promise: Promise.resolve(),
      };
      activePrompt = prompt;
      const task = readyPromise.then(async () => {
        if (closed || activePrompt !== prompt || prompt.cancelRequested) return;
        try {
          const desiredModelId = turnOptions
            ? turnOptions.preferences.modelId ?? currentModelId
            : currentModelId;
          // 偏好为空不等于"跟随 provider 默认":上游可能要求显式等级(如 glm-5.3-flash),
          // 用模型目录 defaultOptionId 兜底,确保 setModel 始终下发 reasoningLevel。
          const desiredReasoning = turnOptions?.preferences.reasoningEffort
            ?? currentReasoningLevel
            ?? this.defaultReasoningFor(desiredModelId);
          const modelChanged = desiredModelId && desiredModelId !== currentModelId;
          const reasoningChanged = desiredReasoning && desiredReasoning !== currentReasoningLevel;
          if (modelChanged || (desiredModelId && reasoningChanged)) {
            const result = await request('session/setModel', {
              sessionId: externalSessionId,
              model: {
                providerId: this.modelProviders.get(desiredModelId!) ?? (desiredModelId!.includes('/') ? desiredModelId!.split('/')[0] : undefined),
                modelId: desiredModelId,
                ...(desiredReasoning ? { options: { reasoningLevel: desiredReasoning } } : {}),
              },
            });
            if (closed || activePrompt !== prompt || prompt.cancelRequested) return;
            currentModelId = desiredModelId!;
            currentReasoningLevel = desiredReasoning ?? currentReasoningLevel;
            void result;
          }
          if (currentModelId) {
            emit({ type: 'model_info', model: currentModelId, modelProvider: 'ZCode', ...(currentReasoningLevel ? { reasoningEffort: currentReasoningLevel } : {}) });
          }
          if (closed || activePrompt !== prompt || prompt.cancelRequested) return;
          prompt.started = true;
          lastStepUsage=null;
          refreshPromptActivity();
          options.onPerformanceMilestone?.('provider_request_sent');
          emit({ type: 'turn_start', turnId: prompt.turnId });
          await request('session/send', { sessionId: externalSessionId!, content }, 0);
          options.onInputAccepted?.(prompt.turnId, content);
          // 终态由 turn.completed 事件承载;send 应答只代表受理。timeoutMs<=0 视为不限时。
        } catch (error) {
          if (!prompt.cancelRequested) {
            if (error instanceof ZcodePromptStalledError) emitError(error);
            else emitError(error);
          }
        } finally {
          if (prompt.idleTimer) clearTimeout(prompt.idleTimer);
          prompt.idleTimer = null;
        }
      }).catch((error) => {
        if (!prompt.cancelRequested) emitError(error);
      }).finally(() => {
        if (activePrompt === prompt) activePrompt = null;
        // turn.completed 晚于 send 受理应答;保留回合上下文供终态投影。
        if(prompt.started&&!prompt.completed)lastPrompt = prompt;
        else if(lastPrompt===prompt)lastPrompt=null;
      });
      prompt.promise = task;
    };

    return {
      send,
      cancel: async () => {
        const preparing = activePrompt;
        if (preparing && !preparing.started) {
          preparing.cancelRequested = true;
          await preparing.promise;
          return;
        }
        await readyPromise;
        // send 受理后 activePrompt 已被 finally 清空,而 zcode 侧回合仍在跑;
        // 按 activePrompt 判断会跳过 session/stop,导致"中断后再发送报 A prompt is already running"。
        // 协议对空闲会话 stop 无害(返回 {}),只要外部会话存在就发送。
        const prompt = activePrompt;
        if (prompt) prompt.cancelRequested = true;
        if (!externalSessionId) return;
        try {
          await request('session/stop', { sessionId: externalSessionId }, this.cancelConfirmationTimeoutMs);
        } catch (error) {
          try{this.diagnostic(mapZcodeError(error, { phase: 'cancel' }).code ?? '');}catch{/* Diagnostic only. */}
          throw new Error('ZCODE_CANCEL_UNCONFIRMED');
        }
      },
      respondToInteraction: (requestId, result) => {
        transport.send({ id: requestId, result: result as RecordValue });
        // 不发 server_request_resolved：本地回显会先于用户决定记账被路由到
        // resolved_elsewhere 分支，把刚点的授权误标成"由引擎侧结束"。
      },
      close: () => {
        if (closed) return;
        closeConnection(false);
      },
    };
  }
}
