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
import { JsonRpcCore } from '../engine/json-rpc/core.js';
import { sanitizeEngineErrorMessage } from '../engine/diagnostics.js';
import { OPENCODE_CLIENT_CAPABILITIES } from './capabilities.js';
import { openCodeProcessManager, type OpenCodeProcessManager } from './process-manager.js';
import {
  AcpInitializeResultSchema,
  AcpPromptResultSchema,
  AcpSessionResultSchema,
  AcpSessionUpdateSchema,
} from './acp-schema.js';
import { classifyOpenCodeCapacityMetadata, mapOpenCodeError, OpenCodePromptStalledError } from './errors.js';
import { validateEngineConcurrencyResource, type EngineConcurrencyContext } from '../engine/concurrency/types.js';
import { discoverOpenCodeModels, parseOpenCodeModelCatalog } from './model-catalog.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import { createAcpInteractionAdapter } from '../engine/acp/interactions.js';

const DEFAULT_CANCEL_CONFIRMATION_TIMEOUT_MS = 10_000;
export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 20 * 60_000;

type RecordValue = Record<string, any>;
type OpenCodeUsage = Extract<EngineEvent, { type: 'token_usage' }>['usage'];

export const openCodeInteractionAdapter: EngineInteractionAdapter = createAcpInteractionAdapter({
  toolKindMapping: (kind) => kind === 'execute' ? 'command' : kind === 'edit' ? 'file' : 'permissions',
});

interface ActiveOpenCodePrompt {
  turnId: string;
  finalContent: string;
  finalItemId: string | null;
  processContent: string;
  latestUsage: OpenCodeUsage | null;
  cancelRequested: boolean;
  started: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  rejectStall: (error: Error) => void;
  promise: Promise<void>;
}

function textContent(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as RecordValue;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (Array.isArray(record.content)) return record.content.map(textContent).join('');
  if (record.content && typeof record.content === 'object') return textContent(record.content);
  return '';
}

function stableId(sessionId: string, kind: string, sequence: number): string {
  return `opencode:${createHash('sha256').update(`${sessionId}:${kind}:${sequence}`).digest('hex').slice(0, 20)}`;
}

function toolItem(update: RecordValue, fallbackId: string): EngineTurnItem {
  const status = update.status === 'completed' || update.status === 'failed'
    ? 'completed'
    : 'in_progress';
  const rawInput = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : undefined;
  const title = typeof update.title === 'string' ? update.title : undefined;
  return {
    id: typeof update.toolCallId === 'string' ? update.toolCallId : fallbackId,
    type: 'dynamicToolCall',
    status,
    details: {
      // Keep the common process-item field names used by the frontend. ACP's
      // `title` is the human label, while the actual tool identity is carried
      // separately by OpenCode in the title/kind pair.
      title,
      toolName: typeof update.kind === 'string' ? update.kind : title,
      kind: typeof update.kind === 'string' ? update.kind : undefined,
      input: rawInput,
      arguments: rawInput,
      output: textContent(update.content) || undefined,
      ...(status === 'completed' ? { success: update.status !== 'failed' } : {}),
    },
  };
}

export interface OpenCodeAdapterOptions {
  manager?: OpenCodeProcessManager;
  getAvailability?: () => EngineAvailability;
  requestTimeoutMs?: number;
  cancelConfirmationTimeoutMs?: number;
  promptIdleTimeoutMs?: number;
  diagnostic?: (message: string) => void;
  inspectLocalHealth?: () => Promise<EngineLocalHealth>;
  listModels?: () => Promise<EngineModelCatalog>;
  modelDiscoveryCwd?: string;
  onModelCatalog?: (catalog: EngineModelCatalog) => void;
}

export class OpenCodeAdapter implements EngineAdapter {
  readonly id = 'opencode' as const;
  readonly descriptor = ENGINE_CATALOG.opencode;
  private readonly manager: OpenCodeProcessManager;
  private readonly getCurrentAvailability: () => EngineAvailability;
  private readonly requestTimeoutMs: number;
  private readonly cancelConfirmationTimeoutMs: number;
  private readonly promptIdleTimeoutMs: number;
  private readonly diagnostic: (message: string) => void;
  private readonly listModelsImpl: () => Promise<EngineModelCatalog>;
  private readonly onModelCatalog: (catalog: EngineModelCatalog) => void;
  private defaultModelId: string | null = null;
  readonly health;
  readonly concurrency = {
    resolveResource: (_context: EngineConcurrencyContext) => validateEngineConcurrencyResource({
      resourceKey: 'opencode:default',
      providerKey: null,
      label: this.descriptor.label,
      defaultMaxActiveTurns: 4,
    }),
  };
  readonly interactions = openCodeInteractionAdapter;
  readonly recovery = { restartMode: 'interrupt' as const };

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.manager = options.manager ?? openCodeProcessManager;
    this.getCurrentAvailability = options.getAvailability ?? (() => ({
      available: false,
      code: 'OPENCODE_NOT_READY',
      message: 'OpenCode 尚未通过 ACP readiness 检查',
    }));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.cancelConfirmationTimeoutMs = options.cancelConfirmationTimeoutMs ?? DEFAULT_CANCEL_CONFIRMATION_TIMEOUT_MS;
    this.promptIdleTimeoutMs = options.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.listModelsImpl = options.listModels
      ?? (() => discoverOpenCodeModels(this.manager, options.modelDiscoveryCwd ?? process.cwd()));
    this.onModelCatalog = options.onModelCatalog ?? (() => undefined);
    this.health = {
      inspectLocal: options.inspectLocalHealth ?? (async () => {
        const availability = this.getCurrentAvailability();
        return createUncheckedEngineHealth({
          engineId: this.id,
          available: availability.available,
          code: availability.code,
          message: availability.message || (availability.available ? 'OpenCode 可用' : 'OpenCode 不可用'),
          process: 'on_demand',
        });
      }),
    };
  }

  readonly availability = { getCurrent: () => this.getCurrentAvailability() };
  readonly diagnostics = {
    classify: mapOpenCodeError,
  };
  readonly runtime = { connect: (options: EngineConnectionOptions) => this.connect(options) };
  readonly models = { listModels: async () => {
    const catalog = await this.listModelsImpl();
    this.captureCatalogDefaults(catalog);
    return catalog;
  } };

  private captureCatalogDefaults(catalog: EngineModelCatalog): void {
    const defaultModel = catalog.models.find((model) => model.isDefault);
    this.defaultModelId = defaultModel?.id ?? this.defaultModelId;
  }

  private connect(options: EngineConnectionOptions): EngineConnection {
    if (!options.cwd) throw new Error('OpenCode 会话缺少项目目录');
    const transport = this.manager.getOrCreate(options.sessionId, options.cwd);
    const rpc = new JsonRpcCore(transport, { defaultTimeoutMs: this.requestTimeoutMs });
    let externalSessionId = options.externalSessionId;
    let closed = false;
    let sequence = 0;
    let replaying = Boolean(externalSessionId);
    let activePrompt: ActiveOpenCodePrompt | null = null;
    let forceShutdownRequested = false;
    let baselineModelId: string | null = null;
    let currentModelId: string | null = null;

    const emitEnvelope = createEngineEventEmitter({ engineId: this.id, emit: options.onEvent });
    const emit = (event: EngineEvent, source: EngineEventSource = 'realtime') => {
      if (!closed) emitEnvelope(event, {
        source,
        ...(externalSessionId ? { externalSessionId } : {}),
        ...('turnId' in event && typeof event.turnId === 'string' ? { externalTurnId: event.turnId } : {}),
      });
    };
    const emitError = (error: unknown, source: EngineEventSource = 'realtime') => {
      const mapped = mapOpenCodeError(error);
      emit({ type: 'error', diagnostic: mapped }, source);
    };
    const refreshPromptActivity = () => {
      const prompt = activePrompt;
      if (!prompt?.started) return;
      if (prompt.idleTimer) clearTimeout(prompt.idleTimer);
      prompt.idleTimer = setTimeout(() => {
        prompt.rejectStall(new OpenCodePromptStalledError(this.promptIdleTimeoutMs));
      }, this.promptIdleTimeoutMs);
      prompt.idleTimer.unref?.();
    };
    const closeTransport = (force: boolean, notifyRuntimeLater: boolean) => {
      if (closed) return;
      forceShutdownRequested ||= force;
      closed = true;
      rpc.rejectAll();
      if (forceShutdownRequested) transport.terminate();
      else transport.close();
      void this.manager.release(options.sessionId, transport).catch((error) => this.diagnostic(mapOpenCodeError(error, { phase: 'close' }).code ?? ''));
      if (notifyRuntimeLater) setTimeout(() => options.onClosed(), 0);
    };
    const waitForOpen = () => new Promise<void>((resolve, reject) => {
      if (transport.state === 'open') return resolve();
      if (transport.state === 'closed') return reject(new Error('OpenCode ACP transport 已关闭'));
      const offOpen = transport.onOpen(() => { cleanup(); resolve(); });
      const offError = transport.onError((error) => { cleanup(); reject(error); });
      const offClose = transport.onClose(() => { cleanup(); reject(new Error('OpenCode ACP transport 已关闭')); });
      const cleanup = () => { offOpen(); offError(); offClose(); };
    });

    const handleUpdate = (params: unknown) => {
      const parsed = AcpSessionUpdateSchema.safeParse(params);
      if (!parsed.success || parsed.data.sessionId !== externalSessionId) return;
      const update = parsed.data.update as RecordValue;
      this.manager.touch(options.sessionId);
      refreshPromptActivity();
      if (replaying) return;
      const kind = update.sessionUpdate;
      const itemId = typeof update.messageId === 'string'
        ? update.messageId
        : stableId(options.sessionId, kind, ++sequence);
      if (kind === 'agent_message_chunk') {
        const content = textContent(update.content);
        if (activePrompt) {
          activePrompt.finalContent += content;
          activePrompt.finalItemId = itemId;
        }
        emit({ type: 'delta', itemId, content, phase: 'final_answer' });
        return;
      }
      if (kind === 'agent_thought_chunk') {
        const content = textContent(update.content);
        if (activePrompt) activePrompt.processContent += content;
        emit({ type: 'delta', itemId: `${itemId}:commentary`, content, phase: 'commentary' });
        return;
      }
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const item = toolItem(update, stableId(options.sessionId, kind, ++sequence));
        emit(item.status === 'completed' ? { type: 'item_complete', item } : { type: 'item_start', item });
        return;
      }
      if (kind === 'usage_update') {
        const usage = update._meta?.usage;
        const inputTokens = Number(usage?.inputTokens ?? update.used ?? 0);
        const outputTokens = Number(usage?.outputTokens ?? 0);
        const latestUsage = {
          inputTokens,
          cachedInputTokens: 0,
          outputTokens,
          reasoningOutputTokens: 0,
          totalTokens: Number(usage?.totalTokens ?? inputTokens + outputTokens),
          modelContextWindow: Number.isFinite(Number(update.size)) ? Number(update.size) : null,
        };
        if (activePrompt) activePrompt.latestUsage = latestUsage;
        emit({ type: 'token_usage', usage: latestUsage });
        return;
      }
      if (kind === 'config_option_update') {
        const optionsList = Array.isArray(update.configOptions) ? update.configOptions : [];
        const model = optionsList.find((entry: any) => entry?.category === 'model' || entry?.id === 'model');
        const modelValue = model?.currentValue;
        if (typeof modelValue === 'string' && modelValue.length > 0) {
          currentModelId = modelValue;
          emit({ type: 'model_info', model: modelValue, modelProvider: 'OpenCode' });
        }
      }
    };

    rpc.onNotification((message) => {
      if (message.method === 'session/update') handleUpdate(message.params);
    });
    rpc.onServerRequest((message) => {
      this.manager.touch(options.sessionId);
      refreshPromptActivity();
      if (message.method === 'session/request_permission' || message.method === 'session/request_user_input') {
        emit({
          type: 'server_request',
          requestId: message.id!,
          method: message.method,
          params: (message.params && typeof message.params === 'object' ? message.params : {}) as RecordValue,
        });
        return;
      }
      rpc.respondError(message.id!, -32601, `Relay 不支持 OpenCode 客户端请求：${message.method}`);
      emit({ type: 'system_notice', noticeType: 'warning', title: 'OpenCode 请求不受支持', message: String(message.method) });
    });
    transport.onError((error) => emitError(error, 'process_exit'));
    transport.onClose(() => { if (!closed) { closed = true; options.onClosed(); } });

    const ready = (async () => {
      await waitForOpen();
      options.onPerformanceMilestone?.('transport_opened');
      const initialized = AcpInitializeResultSchema.parse(await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: OPENCODE_CLIENT_CAPABILITIES,
        clientInfo: { name: 'relay', version: '1.0.0' },
      }));
      if (initialized.protocolVersion !== 1) throw new Error('OpenCode ACP 协议版本不兼容');
      options.onPerformanceMilestone?.('protocol_initialized');
      const result = AcpSessionResultSchema.parse(await rpc.request(
        externalSessionId ? 'session/load' : 'session/new',
        externalSessionId
          ? { sessionId: externalSessionId, cwd: options.cwd, mcpServers: [] }
          : { cwd: options.cwd, mcpServers: [] },
      ));
      if (!externalSessionId) externalSessionId = result.sessionId ?? null;
      if (!externalSessionId) throw new Error('OpenCode 未返回 sessionId');
      options.onPerformanceMilestone?.('external_session_ready');
      try { await options.onSessionReady(externalSessionId); }
      catch { throw new Error('OpenCode 外部会话标识保存失败'); }
      if (closed) throw new Error('OpenCode 连接已失效');
      replaying = false;
      const modelOption = result.configOptions
        ?.find((entry) => entry.id === 'model' || entry.category === 'model');
      const modelId = typeof modelOption?.currentValue === 'string' && modelOption.currentValue.length > 0
        ? modelOption.currentValue
        : undefined;
      currentModelId = modelId ?? null;
      const observedCatalog = parseOpenCodeModelCatalog(result);
      if (!options.externalSessionId) this.captureCatalogDefaults(observedCatalog);
      baselineModelId = this.defaultModelId ?? currentModelId;
      if (modelId) emit({ type: 'model_info', model: modelId, modelProvider: 'OpenCode' });
      if (!options.externalSessionId || this.defaultModelId) {
        this.onModelCatalog(this.defaultModelId
          ? {
            ...observedCatalog,
            models: observedCatalog.models.map((entry) => ({
              ...entry, isDefault: entry.id === this.defaultModelId,
            })),
          }
          : observedCatalog);
      }
    })();
    ready.catch(emitError);

    const send = (content: string, turnOptions?: EngineTurnOptions) => {
      if (activePrompt) {
        emit({ type: 'error', diagnostic: {
          code: 'OPENCODE_PROVIDER_ERROR', phase: 'send', retryable: false,
          userMessage: 'OpenCode 会话已有任务正在执行', providerClass: 'unknown',
        } });
        return;
      }
      emit({ type: 'request_forwarded' }, 'local');
      let rejectStall!: (error: Error) => void;
      const stall = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
      const prompt: ActiveOpenCodePrompt = {
        turnId: `opencode-turn:${randomUUID()}`,
        finalContent: '',
        finalItemId: null,
        processContent: '',
        latestUsage: null,
        cancelRequested: false,
        started: false,
        idleTimer: null,
        rejectStall,
        promise: Promise.resolve(),
      };
      activePrompt = prompt;
      const task = ready.then(async () => {
        if (closed || activePrompt !== prompt || prompt.cancelRequested) return;
        this.manager.setBusy(options.sessionId, true);
        try {
          const desiredModelId = turnOptions
            ? turnOptions.preferences.modelId ?? baselineModelId
            : currentModelId;
          if (desiredModelId && desiredModelId !== currentModelId) {
            const result = await rpc.request('session/set_model', {
              sessionId: externalSessionId,
              modelId: desiredModelId,
            });
            if (closed || activePrompt !== prompt || prompt.cancelRequested) return;
            currentModelId = typeof (result as RecordValue)?.modelId === 'string'
              ? String((result as RecordValue).modelId)
              : desiredModelId;
          }
          if (currentModelId) emit({ type: 'model_info', model: currentModelId, modelProvider: 'OpenCode' });
          if (closed || activePrompt !== prompt || prompt.cancelRequested) return;
          prompt.started = true;
          refreshPromptActivity();
          options.onPerformanceMilestone?.('provider_request_sent');
          emit({ type: 'turn_start', turnId: prompt.turnId });
          const result = AcpPromptResultSchema.parse(await Promise.race([rpc.request('session/prompt', {
            sessionId: externalSessionId,
            prompt: [{ type: 'text', text: content }],
          }, { timeoutMs: null }), stall]));
          options.onInputAccepted?.(prompt.turnId, content);
          emit({ type: 'turn_complete', turnId: prompt.turnId }, 'request_response');
          if (result.stopReason === 'cancelled') {
            if (!prompt.cancelRequested) {
              emit({ type: 'error', diagnostic: mapOpenCodeError(new Error('OpenCode 回合已取消'), { phase: 'cancel' }) }, 'request_response');
            }
          } else if (!prompt.finalContent.trim()) {
            const capacity = classifyOpenCodeCapacityMetadata(result._meta);
            // 空正文时 stopReason（refusal/max_tokens 等）是唯一的失败线索，拼进原文供界面展示
            const reason = result.stopReason?.trim() || '';
            emit({ type: 'error', diagnostic: {
              code: 'OPENCODE_FINAL_ANSWER_MISSING',
              phase: 'stream',
              retryable: true,
              userMessage: '未生成最终回复',
              providerClass: capacity?.providerClass || 'unknown',
              ...(reason ? { originalMessage: sanitizeEngineErrorMessage(`未生成最终回复（stopReason: ${reason}）`) } : {}),
              ...(capacity?.retryAfterMs !== undefined ? { retryAfterMs: capacity.retryAfterMs } : {}),
            } }, 'request_response');
          } else {
            emit({
              type: 'message_complete',
              turnId: prompt.turnId,
              content: prompt.finalContent,
              ...(prompt.processContent ? { processContent: prompt.processContent } : {}),
              ...(prompt.finalItemId ? { finalAnswerItemId: prompt.finalItemId } : {}),
              ...(prompt.latestUsage ? { usage: {
                promptTokens: prompt.latestUsage.inputTokens,
                completionTokens: prompt.latestUsage.outputTokens,
                totalTokens: prompt.latestUsage.totalTokens,
              } } : {}),
            }, 'request_response');
          }
        } catch (error) {
          if (!prompt.cancelRequested) {
            if (error instanceof OpenCodePromptStalledError) forceShutdownRequested = true;
            emitError(error);
            if (error instanceof OpenCodePromptStalledError) closeTransport(true, false);
          }
        } finally {
          if (prompt.idleTimer) clearTimeout(prompt.idleTimer);
          prompt.idleTimer = null;
          this.manager.setBusy(options.sessionId, false);
        }
      }).catch((error) => {
        if (!prompt.cancelRequested) emitError(error);
      }).finally(() => {
        if (activePrompt === prompt) activePrompt = null;
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
        await ready;
        const prompt = activePrompt;
        if (!prompt) return;
        prompt.cancelRequested = true;
        rpc.notify('session/cancel', { sessionId: externalSessionId });
        let timer: ReturnType<typeof setTimeout> | null = null;
        const confirmed = await Promise.race([
          prompt.promise.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), this.cancelConfirmationTimeoutMs);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!confirmed) {
          closeTransport(true, true);
          await prompt.promise.catch(() => undefined);
          throw new Error('OPENCODE_CANCEL_UNCONFIRMED');
        }
      },
      respondToInteraction: (requestId, result) => {
        rpc.respond(requestId, result);
        // 不发 server_request_resolved：本地回显会把刚点的授权误标成 resolved_elsewhere。
      },
      close: () => {
        if (closed) return;
        closeTransport(false, false);
      },
    };
  }
}
