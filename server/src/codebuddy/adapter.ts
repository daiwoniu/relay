import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { JsonRpcEnvelope } from '../engine/transports/transport.js';
import { CODEBUDDY_CLIENT_CAPABILITIES } from './capabilities.js';
import { codeBuddyProcessManager, createFeishuCodeBuddyTransport, type CodeBuddyProcessManager } from './process-manager.js';
import {
  AcpInitializeResultSchema,
  AcpPromptResultSchema,
  AcpSessionResultSchema,
  AcpSessionUpdateSchema,
  isHistoryUpdate,
} from './acp-schema.js';
import { classifyCodeBuddyCapacityMetadata, CodeBuddyPromptStalledError, mapCodeBuddyError } from './errors.js';
import { validateEngineConcurrencyResource, type EngineConcurrencyContext } from '../engine/concurrency/types.js';
import { discoverCodeBuddyModels, parseCodeBuddyModelCatalog } from './model-catalog.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import { createAcpInteractionAdapter } from '../engine/acp/interactions.js';

const DEFAULT_CANCEL_CONFIRMATION_TIMEOUT_MS = 10_000;
export const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 20 * 60_000;

type RecordValue = Record<string, any>;
type CodeBuddyUsage = Extract<EngineEvent, { type: 'token_usage' }>['usage'];

export const codeBuddyInteractionAdapter: EngineInteractionAdapter = createAcpInteractionAdapter({
  toolNameFromMeta: (meta) => typeof meta['codebuddy.ai/toolName'] === 'string' ? meta['codebuddy.ai/toolName'] : undefined,
});

interface ActiveCodeBuddyPrompt {
  turnId: string;
  finalContent: string;
  finalItemId: string | null;
  processContent: string;
  latestUsage: CodeBuddyUsage | null;
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
  return `codebuddy:${createHash('sha256').update(`${sessionId}:${kind}:${sequence}`).digest('hex').slice(0, 20)}`;
}

function toolItem(update: RecordValue, fallbackId: string): EngineTurnItem {
  const status = update.status === 'completed' || update.status === 'failed'
    ? 'completed'
    : 'in_progress';
  return {
    id: typeof update.toolCallId === 'string' ? update.toolCallId : fallbackId,
    type: 'dynamicToolCall',
    status,
    details: {
      title: typeof update.title === 'string' ? update.title : undefined,
      kind: typeof update.kind === 'string' ? update.kind : undefined,
      toolName: typeof update._meta?.['codebuddy.ai/toolName'] === 'string'
        ? update._meta['codebuddy.ai/toolName'] : undefined,
      input: update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : undefined,
      output: textContent(update.content) || undefined,
    },
  };
}

export interface CodeBuddyAdapterOptions {
  manager?: CodeBuddyProcessManager;
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

export class CodeBuddyAdapter implements EngineAdapter {
  readonly supportsFeishuIsolation = true;
  readonly id = 'codebuddy' as const;
  readonly descriptor = ENGINE_CATALOG.codebuddy;
  private readonly manager: CodeBuddyProcessManager;
  private readonly getCurrentAvailability: () => EngineAvailability;
  private readonly requestTimeoutMs: number;
  private readonly cancelConfirmationTimeoutMs: number;
  private readonly promptIdleTimeoutMs: number;
  private readonly diagnostic: (message: string) => void;
  private readonly listModelsImpl: () => Promise<EngineModelCatalog>;
  private readonly onModelCatalog: (catalog: EngineModelCatalog) => void;
  private defaultModelId: string | null = null;
  private defaultReasoningEffort: string | null = null;
  readonly health;
  readonly concurrency = {
    resolveResource: (_context: EngineConcurrencyContext) => validateEngineConcurrencyResource({
      resourceKey: 'codebuddy:default',
      providerKey: null,
      label: this.descriptor.label,
      defaultMaxActiveTurns: 4,
    }),
  };
  readonly interactions = codeBuddyInteractionAdapter;
  readonly recovery = { restartMode: 'interrupt' as const };

  constructor(options: CodeBuddyAdapterOptions = {}) {
    this.manager = options.manager ?? codeBuddyProcessManager;
    this.getCurrentAvailability = options.getAvailability ?? (() => ({
      available: false,
      code: 'CODEBUDDY_NOT_READY',
      message: 'CodeBuddy 尚未通过认证与 ACP readiness 检查',
    }));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.cancelConfirmationTimeoutMs = options.cancelConfirmationTimeoutMs ?? DEFAULT_CANCEL_CONFIRMATION_TIMEOUT_MS;
    this.promptIdleTimeoutMs = options.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.listModelsImpl = options.listModels
      ?? (() => discoverCodeBuddyModels(this.manager, options.modelDiscoveryCwd ?? process.cwd()));
    this.onModelCatalog = options.onModelCatalog ?? (() => undefined);
    this.health = {
      inspectLocal: options.inspectLocalHealth ?? (async () => {
        const availability = this.getCurrentAvailability();
        return createUncheckedEngineHealth({
          engineId: this.id,
          available: availability.available,
          code: availability.code,
          message: availability.message || (availability.available ? 'CodeBuddy 可用' : 'CodeBuddy 不可用'),
          process: 'on_demand',
        });
      }),
    };
  }

  readonly availability = { getCurrent: () => this.getCurrentAvailability() };
  readonly diagnostics = {
    classify: mapCodeBuddyError,
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
    this.defaultReasoningEffort = defaultModel?.reasoning.defaultOptionId ?? this.defaultReasoningEffort;
  }

  private connect(options: EngineConnectionOptions): EngineConnection {
    const isolated = options.executionScope === 'feishu';
    if (isolated && options.externalSessionId) throw new Error('FEISHU_ENGINE_CANNOT_RESUME');
    const workspace = isolated ? mkdtempSync(join(tmpdir(), 'relay-feishu-codebuddy-')) : null;
    const releaseWorkspace = () => {
      if (workspace) {
        try { rmdirSync(workspace); } catch { /* Keep any unexpected engine files for diagnosis. */ }
      }
    };
    const cwd = workspace ?? options.cwd;
    if (!cwd) throw new Error('CodeBuddy 会话缺少项目目录');
    let transport;
    try {
      transport = isolated ? createFeishuCodeBuddyTransport(cwd) : this.manager.getOrCreate(options.sessionId, cwd);
    } catch (error) {
      releaseWorkspace();
      throw error;
    }
    const rpc = new JsonRpcCore(transport, { defaultTimeoutMs: this.requestTimeoutMs });
    let externalSessionId = options.externalSessionId;
    let closed = false;
    let sequence = 0;
    let replaying = Boolean(externalSessionId);
    let activePrompt: ActiveCodeBuddyPrompt | null = null;
    let forceShutdownRequested = false;
    let baselineModelId: string | null = null;
    let baselineReasoningEffort: string | null = null;
    let currentModelId: string | null = null;
    let currentReasoningEffort: string | null = null;
    const modelReasoningSupport = new Map<string, boolean>();

    const emitEnvelope = createEngineEventEmitter({ engineId: this.id, emit: options.onEvent });
    const emit = (event: EngineEvent, source: EngineEventSource = 'realtime') => {
      if (!closed) emitEnvelope(event, {
        source,
        ...(externalSessionId ? { externalSessionId } : {}),
        ...('turnId' in event && typeof event.turnId === 'string' ? { externalTurnId: event.turnId } : {}),
      });
    };
    const emitError = (error: unknown, source: EngineEventSource = 'realtime') => {
      const mapped = mapCodeBuddyError(error);
      emit({ type: 'error', diagnostic: mapped }, source);
    };
    const refreshPromptActivity = () => {
      const prompt = activePrompt;
      if (!prompt?.started) return;
      if (prompt.idleTimer) clearTimeout(prompt.idleTimer);
      prompt.idleTimer = setTimeout(() => {
        prompt.rejectStall(new CodeBuddyPromptStalledError(this.promptIdleTimeoutMs));
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
      if (!isolated) void this.manager.release(options.sessionId, transport).catch((error) => this.diagnostic(mapCodeBuddyError(error, { phase: 'close' }).code ?? ''));
      if (notifyRuntimeLater) setTimeout(() => options.onClosed(), 0);
    };
    const waitForOpen = () => new Promise<void>((resolve, reject) => {
      if (transport.state === 'open') return resolve();
      if (transport.state === 'closed') return reject(new Error('CodeBuddy ACP transport 已关闭'));
      const offOpen = transport.onOpen(() => { cleanup(); resolve(); });
      const offError = transport.onError((error) => { cleanup(); reject(error); });
      const offClose = transport.onClose(() => { cleanup(); reject(new Error('CodeBuddy ACP transport 已关闭')); });
      const cleanup = () => { offOpen(); offError(); offClose(); };
    });

    const handleUpdate = (params: unknown) => {
      const parsed = AcpSessionUpdateSchema.safeParse(params);
      if (!parsed.success || parsed.data.sessionId !== externalSessionId) return;
      const update = parsed.data.update as RecordValue;
      this.manager.touch(options.sessionId);
      refreshPromptActivity();
      if (replaying || isHistoryUpdate(params) || isHistoryUpdate(update)) return;
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
        const inputTokens = Number(usage?.prompt_tokens ?? update.used ?? 0);
        const outputTokens = Number(usage?.completion_tokens ?? 0);
        const latestUsage = {
          inputTokens,
          cachedInputTokens: Number(usage?.prompt_cache_hit_tokens ?? usage?.cached_tokens ?? 0),
          outputTokens,
          reasoningOutputTokens: Number(usage?.completion_thinking_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? 0),
          totalTokens: Number(usage?.total_tokens ?? inputTokens + outputTokens),
          modelContextWindow: Number.isFinite(Number(update.size)) ? Number(update.size) : null,
        };
        if (activePrompt) activePrompt.latestUsage = latestUsage;
        emit({ type: 'token_usage', usage: latestUsage });
        return;
      }
      if (kind === 'config_option_update') {
        const optionsList = Array.isArray(update.configOptions) ? update.configOptions : [];
        const model = optionsList.find((entry: any) => entry?.category === 'model');
        const reasoning = optionsList.find((entry: any) => entry?.category === 'thought_level');
        const modelValue = model?.currentValue;
        const reasoningValue = reasoning?.currentValue;
        if (typeof modelValue === 'string' && modelValue.length > 0) currentModelId = modelValue;
        if (typeof reasoningValue === 'string' && reasoningValue.length > 0) currentReasoningEffort = reasoningValue;
        if (typeof modelValue === 'string' && modelValue.length > 0) emit({
          type: 'model_info',
          model: modelValue,
          modelProvider: 'CodeBuddy',
          ...(typeof reasoningValue === 'string' && reasoningValue.length > 0 ? { reasoningEffort: reasoningValue } : {}),
        });
      }
    };

    rpc.onNotification((message) => {
      if (message.method === 'session/update') handleUpdate(message.params);
      else if (message.method === 'codebuddy.ai/memberEvent') {
        this.manager.touch(options.sessionId);
        refreshPromptActivity();
        const params = (message.params && typeof message.params === 'object' ? message.params : {}) as RecordValue;
        const item: EngineTurnItem = {
          id: typeof params.memberId === 'string' ? `codebuddy-member:${params.memberId}` : stableId(options.sessionId, 'member', ++sequence),
          type: 'collabAgentToolCall',
          status: params.status === 'completed' ? 'completed' : 'in_progress',
          details: { agentName: params.name, agentPath: params.path, summary: params.summary },
        };
        emit(item.status === 'completed' ? { type: 'item_complete', item } : { type: 'item_start', item });
      }
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
      rpc.respondError(message.id!, -32601, `Relay 不支持 CodeBuddy 客户端请求：${message.method}`);
      emit({ type: 'system_notice', noticeType: 'warning', title: 'CodeBuddy 请求不受支持', message: String(message.method) });
    });
    transport.onError((error) => emitError(error, 'process_exit'));
    transport.onClose(() => { releaseWorkspace(); if (!closed) { closed = true; options.onClosed(); } });

    const ready = (async () => {
      await waitForOpen();
      options.onPerformanceMilestone?.('transport_opened');
      const initialized = AcpInitializeResultSchema.parse(await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: CODEBUDDY_CLIENT_CAPABILITIES,
        clientInfo: { name: 'relay', version: '1.0.0' },
      }));
      if (initialized.protocolVersion !== 1) throw new Error('CodeBuddy ACP 协议版本不兼容');
      options.onPerformanceMilestone?.('protocol_initialized');
      const result = AcpSessionResultSchema.parse(await rpc.request(
        externalSessionId ? 'session/load' : 'session/new',
        externalSessionId
          ? { sessionId: externalSessionId, cwd, mcpServers: [] }
          : { cwd, mcpServers: [] },
      ));
      if (!externalSessionId) externalSessionId = result.sessionId ?? null;
      if (!externalSessionId) throw new Error('CodeBuddy 未返回 sessionId');
      options.onPerformanceMilestone?.('external_session_ready');
      try { await options.onSessionReady(externalSessionId); }
      catch { throw new Error('CodeBuddy 外部会话标识保存失败'); }
      if (closed) throw new Error('CodeBuddy 连接已失效');
      replaying = false;
      const modelId = result.models?.currentModelId;
      const model = result.models?.availableModels?.find((entry) => entry.modelId === modelId);
      currentModelId = modelId ?? null;
      const observedReasoningEffort = result.configOptions
        ?.find((entry) => entry.category === 'thought_level' || entry.id === 'thought_level')
        ?.currentValue;
      currentReasoningEffort = typeof observedReasoningEffort === 'string' ? observedReasoningEffort : null;
      const observedCatalog = parseCodeBuddyModelCatalog(result);
      if (!options.externalSessionId) this.captureCatalogDefaults(observedCatalog);
      baselineModelId = this.defaultModelId ?? currentModelId;
      baselineReasoningEffort = this.defaultReasoningEffort ?? currentReasoningEffort;
      for (const availableModel of result.models?.availableModels ?? []) {
        modelReasoningSupport.set(availableModel.modelId, availableModel._meta?.supportsReasoning !== false);
      }
      if (modelId) emit({ type: 'model_info', model: model?.name || modelId, modelProvider: 'CodeBuddy' });
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
      emit({ type: 'request_forwarded' }, 'local');
      if (activePrompt) {
        emit({ type: 'error', diagnostic: {
          code: 'CODEBUDDY_PROVIDER_ERROR', phase: 'send', retryable: false,
          userMessage: 'CodeBuddy 会话已有任务正在执行', providerClass: 'unknown',
        } });
        return;
      }
      let rejectStall!: (error: Error) => void;
      const stall = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
      const prompt: ActiveCodeBuddyPrompt = {
        turnId: `codebuddy-turn:${randomUUID()}`,
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
          const supportsReasoning = !desiredModelId || modelReasoningSupport.get(desiredModelId) !== false;
          const desiredReasoningEffort = turnOptions && supportsReasoning
            ? turnOptions.preferences.reasoningEffort ?? baselineReasoningEffort
            : currentReasoningEffort;
          if (desiredReasoningEffort && desiredReasoningEffort !== currentReasoningEffort) {
            await rpc.request('session/set_config_option', {
              sessionId: externalSessionId,
              configId: 'thought_level',
              value: desiredReasoningEffort,
            });
            if (closed || activePrompt !== prompt || prompt.cancelRequested) return;
            currentReasoningEffort = desiredReasoningEffort;
          }
          if (currentModelId) emit({
            type: 'model_info',
            model: currentModelId,
            modelProvider: 'CodeBuddy',
            ...(currentReasoningEffort ? { reasoningEffort: currentReasoningEffort } : {}),
          });
          if (closed || activePrompt !== prompt || prompt.cancelRequested) return;
          prompt.started = true;
          refreshPromptActivity();
          options.onPerformanceMilestone?.('provider_request_sent');
          emit({ type: 'turn_start', turnId: prompt.turnId });
          const result = AcpPromptResultSchema.parse(await Promise.race([rpc.request('session/prompt', {
            sessionId: externalSessionId,
            prompt: [{ type: 'text', text: content }],
          }, { timeoutMs: null }), stall]));
          const outcome = result._meta?.['codebuddy.ai/outcome'];
          options.onInputAccepted?.(prompt.turnId, content);
          const cancelReason = result._meta?.['codebuddy.ai/cancelReason'];
          emit({ type: 'turn_complete', turnId: prompt.turnId }, 'request_response');
          if (result.stopReason === 'cancelled' || cancelReason) {
            if (!prompt.cancelRequested) {
              emit({ type: 'error', diagnostic: mapCodeBuddyError(new Error(cancelReason || 'CodeBuddy 回合已取消'), { phase: 'cancel' }) }, 'request_response');
            }
          } else if (!prompt.finalContent.trim()) {
            // 只有“没产出最终回复”才判失败；businessFailed/outcome 只是软标记，不当硬闸门
            const capacity = classifyCodeBuddyCapacityMetadata(result._meta);
            const businessFailed = result._meta?.['codebuddy.ai/businessFailed'];
            const softFail = Boolean(businessFailed) || (typeof outcome === 'string' && outcome !== 'SUCCESS');
            // 引擎 refusal/softFail 时会通过 codebuddy.ai/errorMessage 带回服务端错误原文，优先展示
            const reason = [
              result._meta?.['codebuddy.ai/errorMessage'],
              outcome,
              result._meta?.['codebuddy.ai/finishReason'],
            ]
              .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
              .filter((value, index, list) => list.indexOf(value) === index)
              .join(' · ');
            emit({ type: 'error', diagnostic: {
              code: softFail ? undefined : 'CODEBUDDY_FINAL_ANSWER_MISSING',
              phase: softFail ? 'provider' : 'stream',
              retryable: softFail,
              userMessage: softFail ? 'CodeBuddy 服务执行失败' : '未生成最终回复',
              providerClass: capacity?.providerClass || 'unknown',
              ...(reason && softFail ? { originalMessage: sanitizeEngineErrorMessage(reason) } : {}),
              ...(capacity?.retryAfterMs !== undefined ? { retryAfterMs: capacity.retryAfterMs } : {}),
            } }, 'request_response');
          } else {
            // 有最终回复 → 正常交付，businessFailed/outcome 不阻断（官方：不据此丢弃内容）
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
            if (error instanceof CodeBuddyPromptStalledError) forceShutdownRequested = true;
            emitError(error);
            if (error instanceof CodeBuddyPromptStalledError) closeTransport(true, false);
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
          throw new Error('CODEBUDDY_CANCEL_UNCONFIRMED');
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
