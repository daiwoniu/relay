import type { RelayWSMessage } from './protocol.js';
import { reportRuntimeFault } from '../system/runtime-diagnostics.js';
import type { EngineTurnOptions } from '../engine/adapter.js';
import { JsonRpcCore } from '../engine/json-rpc/core.js';
import { WebSocketJsonRpcTransport, WebSocketTransportParseError } from '../engine/transports/websocket.js';
import { parseRelayFileChangeReport, RELAY_FILE_CHANGE_REPORT_TOOL } from '../messages/file-change-report.js';
import { loadRecoveryTurn, resolveRecoveryTurn, type RecoveryTurnStatus } from './turn-recovery.js';
import { resolveCodexEndpoint } from './endpoint.js';
import { steerCodexTurn } from './client-steer.js';
import { presentRetryNotice } from './client-retry-notice.js';
import {
  appendAgentMessageDelta,
  appendAgentMessageItemText,
  buildAgentMessageGapDiagnostic,
  buildCompletedMessageContent,
  ensureAgentMessage,
  getAgentMessagePhase,
  rebuildAgentMessageBuffers,
  setAgentMessageText,
  type AgentMessagePhase,
  type AgentMessageState,
} from './client-agent-messages.js';
import { buildThreadOpenRequest, isArchivedThreadError, isNotificationForActiveThread } from './client-thread.js';
import {
  retireTurn,
  extractAsyncAgentMessageNotification,
  isStaleTurnNotification,
  itemLeavesNonRetryableTrace,
  extractPlanUpdate,
  presentWarningNotification,
  presentModelReroutedNotice,
  extractThreadTokenUsage,
  extractTurnFailure,
  extractTurnId,
} from './client-turn-facts.js';
import {
  CodexRpcError,
  getTurnStartRetryDelay,
  getFinalTurnStartCapacityFailure,
  jitterDelay,
} from './client-turn-retry.js';
export { RELAY_FILE_CHANGE_REPORT_TOOL } from '../messages/file-change-report.js';
export {
  appendAgentMessageItemText,
  buildAgentMessageGapDiagnostic,
  buildCompletedMessageContent,
  getAgentMessagePhase,
} from './client-agent-messages.js';
export type { AgentMessageGapDiagnostic } from './client-agent-messages.js';
export { buildThreadOpenRequest, isArchivedThreadError, isNotificationForActiveThread } from './client-thread.js';
export type { ThreadOpenRequest } from './client-thread.js';
export {
  extractThreadTokenUsage,
  extractTurnFailure,
  extractTurnId,
} from './client-turn-facts.js';
const DEFAULT_RPC_TIMEOUT_MS = 15_000, DEFAULT_THREAD_START_TIMEOUT_MS = 30_000;
const TURN_COMPLETION_OVERLOAD_BACKOFF_MS = [2_000, 5_000, 10_000] as const;

function isRunningUnderTests(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.some((argument) => /\.test\.[cm]?[jt]s$/.test(argument));
}
function logCodexRuntimeFailure(message: string, details?: unknown): void {
  if (isRunningUnderTests()) return;
  console.error(`[Codex] ${message}`);
  if (process.env.RELAY_VERBOSE_LOGS === '1' && details !== undefined) console.error(details);
}
function logCodexVerbose(message: string, details?: unknown): void {
  if (process.env.RELAY_VERBOSE_LOGS !== '1' || isRunningUnderTests()) return;
  console.log(`[Codex] ${message}`);
  if (details !== undefined) console.log(details);
}

export class CodexRpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} 请求超时（${timeoutMs}ms）`);
    this.name = 'CodexRpcTimeoutError';
  }
}

export interface CodexHandshakeStageEvent {
  stage: 'connection' | 'initialize' | 'config/read' | 'config/get' | 'thread/start' | 'thread/resume';
  outcome: 'completed' | 'failed';
  durationMs: number;
  timeoutMs?: number;
  error?: string;
}

class TurnStartRetryCancelledError extends Error {
  constructor() {
    super('turn/start retry cancelled');
    this.name = 'TurnStartRetryCancelledError';
  }
}

// ── JSON-RPC primitives ──────────────────────────────────────────────

function sendRequest(
  session: CodexSession,
  method: string,
  params: Record<string, any> = {},
  options: { onSent?: () => void; timeoutMs?: number } = {},
): Promise<any> {
  return session.rpc.request(method, params, options);
}

function sendNotification(session: CodexSession, method: string, params: Record<string, any> = {}) {
  session.rpc.notify(method, params);
}

function sendServerRequestResult(session: CodexSession, id: string | number, result: unknown): void {
  session.rpc.respond(id, result);
}

function sendServerRequestError(session: CodexSession, id: string | number, message: string): void {
  session.rpc.respondError(id, -32601, message);
}

// ── Debug: 存储最近一次 Codex 握手结果 ────────────────────────────────
let lastDebugInfo: {
  initResult: any;
  configResult: any;
  threadResult: any;
  model: string;
  timestamp: number;
} | null = null;

export function getDebugInfo() {
  return lastDebugInfo;
}

function isUnknownRpcMethodError(error: unknown, method: string): boolean {
  if (!(error instanceof CodexRpcError)) return false;
  if (error.rpcCode === -32601) return true;
  const escapedMethod = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:unknown variant|method not found).*${escapedMethod}`, 'i').test(error.message);
}

// ── Session state ────────────────────────────────────────────────────

interface CodexSession extends AgentMessageState {
  retryNoticeCount: number;
  onInputAccepted?: CodexConnectionOptions['onInputAccepted'];
  transport: WebSocketJsonRpcTransport;
  rpc: JsonRpcCore;
  frontendCallback: (msg: RelayWSMessage) => void;
  threadId: string | null;
  initialized: boolean;
  sendQueue: Array<{ content: string; options?: EngineTurnOptions }>;
  agentMessagePhases: Map<string, AgentMessagePhase>;
  lastAgentMessageItemId: string | null;
  lastCommentaryItemId: string | null;
  lastFinalAnswerItemId: string | null;
  currentTurnId: string | null;
  currentItemId: string | null;
  turnStartedEmitted: boolean;
  turnReadyPromise: Promise<string> | null;
  resolveTurnReady: ((turnId: string) => void) | null;
  rejectTurnReady: ((error: Error) => void) | null;
  interruptedTurnIds: Set<string>;
  retiredTurnIds: Set<string>;
  recoveryPending: boolean;
  recoveryReadyPromise: Promise<void> | null;
  resolveRecoveryReady: (() => void) | null;
  recoveredTurnStatus: RecoveryTurnStatus | 'unavailable' | null;
  recoveryNotifications: Array<{ method: string; params?: any }>;
  recoveryDeltaSkipChars: Map<string, number>;
  retrySleep: (delayMs: number) => Promise<void>;
  retryRandom: () => number;
  turnStartGeneration: number;
  turnStartRetryPending: boolean;
  completionOverloadRetryPending: boolean;
  completionOverloadRetryCount: number;
  turnInputContent: string | null;
  turnInputOptions: EngineTurnOptions | null;
  turnHasExecutionTrace: boolean;
  lastAgentDeltaAt: Map<string, number>;
  warnedAgentDeltaGaps: Set<string>;
  baselineModelInfo: {
    model: string;
    platformOs?: string;
    modelProvider?: string;
    reasoningEffort?: string;
  } | null;
}

export interface CodexConnection {
  send: (content: string, options?: EngineTurnOptions) => void;
  steer: (input: { content: string; messageId: string; expectedTurnId: string }) => Promise<'accepted' | 'turn_changed' | 'unsupported'>;
  interrupt: () => Promise<void>;
  respondToServerRequest: (requestId: string | number, result: unknown) => void;
  close: () => Promise<void>;
}

export interface CodexConnectionOptions {
  cwd?: string;
  threadId?: string | null;
  onThreadReady?: (threadId: string) => unknown;
  onInputAccepted?: (turnId: string, content: string) => void;
  onConnectionClosed?: () => void;
  wsUrl?: string;
  rpcTimeoutMs?: number;
  threadStartTimeoutMs?: number;
  onHandshakeStage?: (event: CodexHandshakeStageEvent) => void;
  recoverTurnId?: string | null;
  recoverStartedAt?: number | null;
  retrySleep?: (delayMs: number) => Promise<void>;
  retryRandom?: () => number;
  initialTurnOptions?: EngineTurnOptions;
}

// ── Public API ───────────────────────────────────────────────────────

export function createCodexConnection(
  onMessage: (msg: RelayWSMessage) => void,
  options: CodexConnectionOptions = {}
): CodexConnection {
  const {
    cwd,
    threadId: savedThreadId,
    onThreadReady,
    onConnectionClosed,
    wsUrl = resolveCodexEndpoint().wsUrl,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    threadStartTimeoutMs = Math.max(DEFAULT_THREAD_START_TIMEOUT_MS, rpcTimeoutMs),
    onHandshakeStage,
    recoverTurnId,
    recoverStartedAt,
    retrySleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    retryRandom = Math.random,
    initialTurnOptions,
  } = options;
  const verboseLogs = process.env.RELAY_VERBOSE_LOGS === '1';
  const logVerbose = (...args: unknown[]) => {
    if (verboseLogs) console.log(...args);
  };
  const reportHandshakeStage = (event: CodexHandshakeStageEvent) => {
    if (onHandshakeStage) {
      onHandshakeStage(event);
      return;
    }
    if (isRunningUnderTests()) return;
    if (event.outcome === 'failed') console.warn('[Codex] 握手阶段失败:', event);
    else logVerbose('[Codex] 握手阶段耗时:', event);
  };
  const runHandshakeStage = async <T>(
    stage: CodexHandshakeStageEvent['stage'],
    timeoutMs: number,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      const result = await operation();
      reportHandshakeStage({
        stage,
        outcome: 'completed',
        durationMs: Date.now() - startedAt,
        timeoutMs,
      });
      return result;
    } catch (error) {
      reportHandshakeStage({
        stage,
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
        timeoutMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const shouldRecoverTurn = recoverTurnId !== undefined || recoverStartedAt !== undefined;
  const connectionStartedAt = Date.now();
  const connectionTimeoutMs = Math.max(1_000, rpcTimeoutMs);
  const transport = new WebSocketJsonRpcTransport(wsUrl);
  const rpc = new JsonRpcCore(transport, {
    defaultTimeoutMs: rpcTimeoutMs,
    createRemoteError: (error) => new CodexRpcError(
      error.message || 'Codex RPC error',
      typeof error.code === 'number' ? error.code : null,
      error.data,
    ),
    createTimeoutError: (method, timeoutMs) => new CodexRpcTimeoutError(method, timeoutMs),
    createConnectionClosedError: () => new CodexRpcError('Codex 连接已断开', null, undefined),
  });
  let connectionStageReported = false;
  const reportConnectionStage = (outcome: 'completed' | 'failed', error?: string) => {
    if (outcome === 'failed') reportRuntimeFault(error === '连接 Codex app-server 超时' ? 'CODEX_CONNECTION_TIMEOUT' : 'CODEX_CONNECTION_ERROR');
    if (connectionStageReported) return;
    connectionStageReported = true;
    reportHandshakeStage({
      stage: 'connection',
      outcome,
      durationMs: Date.now() - connectionStartedAt,
      timeoutMs: connectionTimeoutMs,
      ...(error ? { error } : {}),
    });
  };
  let resolveRecoveryReady: (() => void) | null = null;
  const recoveryReadyPromise = shouldRecoverTurn
    ? new Promise<void>((resolve) => { resolveRecoveryReady = resolve; })
    : null;
  let connectionTimer: ReturnType<typeof setTimeout>;

  const session: CodexSession = {
    retryNoticeCount: 0,
    transport,
    rpc,
    frontendCallback: onMessage,
    onInputAccepted: options.onInputAccepted,
    threadId: null,
    initialized: false,
    sendQueue: [],
    buffer: '',
    commentaryBuffer: '',
    finalAnswerBuffer: '',
    agentMessages: new Map(),
    agentMessageOrder: [],
    agentMessagePhases: new Map(),
    lastAgentMessageItemId: null,
    lastCommentaryItemId: null,
    lastFinalAnswerItemId: null,
    currentTurnId: null,
    currentItemId: null,
    turnStartedEmitted: false,
    turnReadyPromise: null,
    resolveTurnReady: null,
    rejectTurnReady: null,
    interruptedTurnIds: new Set(),
    retiredTurnIds: new Set(),
    recoveryPending: shouldRecoverTurn,
    recoveryReadyPromise,
    resolveRecoveryReady,
    recoveredTurnStatus: null,
    recoveryNotifications: [],
    recoveryDeltaSkipChars: new Map(),
    retrySleep,
    retryRandom,
    turnStartGeneration: 0,
    turnStartRetryPending: false,
    completionOverloadRetryPending: false,
    completionOverloadRetryCount: 0,
    turnInputContent: null,
    turnInputOptions: null,
    turnHasExecutionTrace: false,
    lastAgentDeltaAt: new Map(),
    warnedAgentDeltaGaps: new Set(),
    baselineModelInfo: null,
  };

  rpc.onServerRequest((message) => handleServerRequest(session, message as any));
  rpc.onNotification((message) => {
    if (session.recoveryPending) {
      session.recoveryNotifications.push(message as any);
      return;
    }
    handleNotification(session, message as any);
  });
  rpc.onUnknownMessage((message) => {
    console.warn('[Codex] Unknown message format:', JSON.stringify(message).slice(0, 200));
  });

  connectionTimer = setTimeout(() => {
    if (transport.state !== 'connecting') return;
    session.frontendCallback({
      type: 'error',
      message: '连接 Codex app-server 超时',
      code: 'CODEX_CONNECTION_TIMEOUT',
    });
    reportConnectionStage('failed', '连接 Codex app-server 超时');
    transport.terminate();
  }, connectionTimeoutMs);
  transport.onOpen(async () => {
    clearTimeout(connectionTimer);
    reportConnectionStage('completed');
    logVerbose('[Codex] 已连接 app-server，开始握手');
    try {
      // Step 1: initialize
      const initResult = await runHandshakeStage('initialize', rpcTimeoutMs, () => sendRequest(session, 'initialize', {
        clientInfo: {
          name: 'relay',
          title: 'Relay Browser Client',
          version: '1.0.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      }));
      logVerbose('[Codex] initialize 完成');
      logVerbose('[Codex] initialize 原始结果:', JSON.stringify(initResult, null, 2));

      // 提取所有可能的模型相关字段
      const modelFields: Record<string, any> = {};
      if (initResult) {
        for (const key of Object.keys(initResult)) {
          if (key.toLowerCase().includes('model') || key === 'serverInfo' || key === 'capabilities') {
            modelFields[key] = initResult[key];
          }
        }
      }
      logVerbose('[Codex] initialize 模型字段:', JSON.stringify(modelFields, null, 2));

      // Step 2: initialized notification
      sendNotification(session, 'initialized', {});

      // Step 3: 尝试从多个来源获取模型名
      let model = initResult?.serverInfo?.model
        || initResult?.model
        || initResult?.serverInfo?.name
        || '';

      // 优先使用当前 app-server 协议；旧版本明确不支持时才回退 config/get。
      let configResult: any = null;
      try {
        configResult = await runHandshakeStage(
          'config/read',
          rpcTimeoutMs,
          () => sendRequest(session, 'config/read', { includeLayers: false }),
        );
        logVerbose('[Codex] config/read 原始结果:', JSON.stringify(configResult, null, 2));
      } catch (error: any) {
        if (isUnknownRpcMethodError(error, 'config/read')) {
          logVerbose('[Codex] config/read 不受支持，回退 config/get');
          try {
            configResult = await runHandshakeStage(
              'config/get',
              rpcTimeoutMs,
              () => sendRequest(session, 'config/get', {}),
            );
            logVerbose('[Codex] config/get 原始结果:', JSON.stringify(configResult, null, 2));
          } catch (fallbackError: any) {
            logVerbose('[Codex] config/get 不可用:', fallbackError.message);
          }
        } else {
          logVerbose('[Codex] config/read 不可用:', error.message);
        }
      }

      const effectiveConfig = configResult?.config || configResult;
      if (effectiveConfig?.model) {
        model = effectiveConfig.model;
      } else if (effectiveConfig?.modelInfo?.name) {
        model = effectiveConfig.modelInfo.name;
      } else if (effectiveConfig?.modelInfo?.id) {
        model = effectiveConfig.modelInfo.id;
      }

      // Step 4: 首次创建 thread；已有记录则从磁盘恢复并继续上下文
      const threadOpenRequest = buildThreadOpenRequest(savedThreadId, cwd, initialTurnOptions?.preferences.modelId);
      let threadResult: any;
      try {
        const timeoutMs = threadOpenRequest.method === 'thread/start' ? threadStartTimeoutMs : rpcTimeoutMs;
        threadResult = await runHandshakeStage(
          threadOpenRequest.method,
          timeoutMs,
          () => sendRequest(session, threadOpenRequest.method, threadOpenRequest.params, { timeoutMs }),
        );
      } catch (err: any) {
        if (threadOpenRequest.method === 'thread/resume') {
          throw new Error(`恢复 Codex 会话失败 (${savedThreadId}): ${err.message}`);
        }
        throw err;
      }
      logVerbose('[Codex] thread 原始结果:', JSON.stringify(threadResult, null, 2));
      session.threadId = typeof threadResult?.thread?.id === 'string' && threadResult.thread.id
        ? threadResult.thread.id
        : null;
      if (!session.threadId) throw new Error('Codex thread 响应缺少有效 ID');
      if (session.threadId && onThreadReady) {
        try {
          await onThreadReady(session.threadId);
        } catch {
          throw new Error('Codex 外部会话标识保存失败');
        }
      }
      if (transport.state !== 'open') throw new Error('Codex 连接已失效');

      if (shouldRecoverTurn) {
        try {
          const recoveryTurn = await loadRecoveryTurn(
            (method, params) => sendRequest(session, method, params),
            session.threadId,
            recoverTurnId,
            recoverStartedAt,
          );
          const recovered = resolveRecoveryTurn({
            status: threadResult.thread.status,
            turns: [recoveryTurn],
          }, recoveryTurn.id);
          const agentItems = recovered.turn.items.filter((item) => item.type === 'agentMessage');
          session.currentTurnId = recovered.turn.id;
          for (const item of agentItems) {
            const phase = getAgentMessagePhase(item.phase);
            if (phase) session.agentMessagePhases.set(item.id, phase);
            setAgentMessageText(
              session,
              item.id,
              typeof item.text === 'string' ? item.text : '',
              phase,
            );
          }
          rebuildAgentMessageBuffers(session);
          session.lastAgentMessageItemId = agentItems.at(-1)?.id || null;
          session.lastCommentaryItemId = agentItems.filter((item) => item.phase === 'commentary').at(-1)?.id || null;
          session.lastFinalAnswerItemId = agentItems.filter((item) => item.phase === 'final_answer').at(-1)?.id || null;
          const queuedNotifications = session.recoveryNotifications.splice(0);
          if (recovered.turn.status === 'inProgress') {
            for (const item of agentItems) {
              if (typeof item.text !== 'string' || !item.text) continue;
              const queuedText = queuedNotifications
                .filter((notification) => notification.method === 'item/agentMessage/delta' && notification.params?.itemId === item.id)
                .map((notification) => typeof notification.params?.delta === 'string' ? notification.params.delta : '')
                .join('');
              for (let length = queuedText.length; length > 0; length -= 1) {
                if (item.text.endsWith(queuedText.slice(0, length))) {
                  session.recoveryDeltaSkipChars.set(item.id, length);
                  break;
                }
              }
            }
          }
          session.recoveryPending = false;
          session.recoveredTurnStatus = recovered.turn.status;
          session.frontendCallback({
            type: 'recovery_snapshot',
            turnId: recovered.turn.id,
            status: recovered.turn.status,
            content: recovered.content,
            ...(recovered.processContent ? { processContent: recovered.processContent } : {}),
            ...(recovered.finalAnswerItemId ? { finalAnswerItemId: recovered.finalAnswerItemId } : {}),
            ...(recovered.processTimeline.length ? { processTimeline: recovered.processTimeline } : {}),
            items: recovered.items as any[],
            waitingOnInteraction: recovered.waitingOnInteraction,
            durationMs: recovered.turn.durationMs,
            error: extractTurnFailure({ turn: recovered.turn }),
          });
          session.resolveRecoveryReady?.();
          session.resolveRecoveryReady = null;
          if (recovered.turn.status === 'inProgress') {
            for (const notification of queuedNotifications) handleNotification(session, notification);
          }
          session.recoveryDeltaSkipChars.clear();
        } catch (error: any) {
          session.recoveryPending = false;
          session.recoveredTurnStatus = 'unavailable';
          session.recoveryNotifications = [];
          session.recoveryDeltaSkipChars.clear();
          session.frontendCallback({
            type: 'error',
            message: `恢复重启前任务失败：${error.message}`,
            code: error.code || (isArchivedThreadError(error) ? 'CODEX_THREAD_ARCHIVED' : 'RESTART_RECOVERY_FAILED'),
          });
          session.resolveRecoveryReady?.();
          session.resolveRecoveryReady = null;
        }
      }

      // 从 thread 结果中提取模型名（如果还没找到）
      if (!model) {
        model = threadResult?.thread?.model
          || threadResult?.model
          || threadResult?.thread?.modelInfo?.name
          || 'codex';
      }

      logVerbose(`[Codex] 会话已${threadOpenRequest.method === 'thread/resume' ? '恢复' : '创建'} · 模型 ${model}`);
      logVerbose('[Codex] 模型来源诊断:', JSON.stringify({
        model,
        fromInit: initResult?.serverInfo?.model || initResult?.model || initResult?.serverInfo?.name || null,
        fromConfig: effectiveConfig?.model || effectiveConfig?.modelInfo?.name || effectiveConfig?.modelInfo?.id || null,
        fromThread: threadResult?.thread?.model || threadResult?.model || threadResult?.thread?.modelInfo?.name || null,
      }, null, 2));

      // 提取额外模型属性
      const platformOs = initResult?.platformOs || initResult?.serverInfo?.platformOs || '';
      const modelProvider = threadResult?.thread?.modelProvider || threadResult?.modelProvider || effectiveConfig?.model_provider || effectiveConfig?.modelProvider || '';
      const reasoningEffort = threadResult?.thread?.reasoningEffort || threadResult?.reasoningEffort || effectiveConfig?.model_reasoning_effort || effectiveConfig?.reasoningEffort || '';

      session.baselineModelInfo = {
        model,
        ...(platformOs ? { platformOs } : {}),
        ...(modelProvider ? { modelProvider } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
      session.frontendCallback({ type: 'model_info', ...session.baselineModelInfo });

      // 保存调试信息
      lastDebugInfo = {
        initResult,
        configResult,
        threadResult,
        model,
        timestamp: Date.now(),
      };

      // Drain any queued messages
      if (transport.state !== 'open') throw new Error('Codex 连接已失效');
      session.initialized = true;
      for (const queued of session.sendQueue) {
        startTurn(session, queued.content, queued.options);
      }
      session.sendQueue = [];
    } catch (err: any) {
      logCodexRuntimeFailure(`握手失败：${err.message}`);
      const threadArchived = isArchivedThreadError(err);
      session.frontendCallback({
        type: 'error',
        message: threadArchived
          ? '该会话已在 ChatGPT/Codex 中归档，请在会话菜单中选择“取消归档”后重试。'
          : `Codex 初始化失败: ${err.message}`,
        code: threadArchived ? 'CODEX_THREAD_ARCHIVED' : 'CODEX_INIT_FAILED',
      });
      // 清理所有待发送消息和回调，防止泄漏
      session.sendQueue = [];
      session.rpc.rejectAll(new CodexRpcError('Codex 初始化失败', null, undefined));
      session.initialized = false;
      session.recoveryPending = false;
      session.recoveredTurnStatus = 'unavailable';
      session.resolveRecoveryReady?.();
      session.resolveRecoveryReady = null;
      transport.close();
    }
  });

  transport.onClose(() => {
    clearTimeout(connectionTimer);
    logVerbose('[Codex] 连接已关闭');
    session.sendQueue = [];
    session.initialized = false;
    session.recoveryPending = false;
    session.recoveredTurnStatus = 'unavailable';
    session.resolveRecoveryReady?.();
    session.resolveRecoveryReady = null;
    onConnectionClosed?.();
  });

  transport.onError((err) => {
    if (err instanceof WebSocketTransportParseError) {
      logCodexRuntimeFailure('收到无法解析的协议消息', err.preview);
      return;
    }
    clearTimeout(connectionTimer);
    reportConnectionStage('failed', err.message);
    logCodexRuntimeFailure(`连接异常：${err.message}`);
    session.frontendCallback({
      type: 'error',
      message: 'Codex 连接异常，请检查 app-server 是否已启动',
      code: 'CODEX_CONNECTION_ERROR',
    });
    session.rpc.rejectAll(new CodexRpcError('Codex 连接异常', null, undefined));
    session.sendQueue = [];
  });

  return {
    send: (content: string, options?: EngineTurnOptions) => {
      if (transport.state === 'closed' || transport.state === 'closing') {
        session.frontendCallback({
          type: 'error',
          message: 'Codex 连接已断开',
          code: 'CODEX_NOT_CONNECTED',
        });
        return;
      }
      // CONNECTING or OPEN but not yet initialized → queue
      if (!session.initialized || !session.threadId) {
        session.sendQueue.push({ content, options });
        return;
      }
      startTurn(session, content, options);
    },
    steer: (input) => steerCodexTurn(session, input),
    interrupt: () => interruptTurn(session),
    respondToServerRequest: (requestId, result) => {
      if (transport.state !== 'open') throw new Error('Codex 连接不可用');
      sendServerRequestResult(session, requestId, result);
    },
    close: () => transport.closeAndWait(),
  };
}

// ── Turn control ─────────────────────────────────────────────────────

function resetTurnState(
  session: CodexSession,
  options: { preserveCompletionRetry?: boolean } = {},
): void {
  retireTurn(session.retiredTurnIds, session.currentTurnId);
  session.turnStartGeneration += 1;
  session.retryNoticeCount = 0;
  session.currentTurnId = null;
  session.currentItemId = null;
  session.turnStartedEmitted = false;
  session.turnReadyPromise = null;
  session.resolveTurnReady = null;
  session.rejectTurnReady = null;
  session.buffer = '';
  session.commentaryBuffer = '';
  session.finalAnswerBuffer = '';
  session.agentMessages.clear();
  session.agentMessageOrder = [];
  session.agentMessagePhases.clear();
  session.turnStartRetryPending = false;
  session.completionOverloadRetryPending = false;
  session.turnHasExecutionTrace = false;
  if (!options.preserveCompletionRetry) {
    session.completionOverloadRetryCount = 0;
    session.turnInputContent = null;
    session.turnInputOptions = null;
  }
  session.lastAgentDeltaAt.clear();
  session.warnedAgentDeltaGaps.clear();
  session.lastAgentMessageItemId = null;
  session.lastCommentaryItemId = null;
  session.lastFinalAnswerItemId = null;
}

function markTurnStarted(session: CodexSession, turnId: string): void {
  session.currentTurnId = turnId;
  session.resolveTurnReady?.(turnId);
  session.resolveTurnReady = null;
  session.rejectTurnReady = null;
  if (session.turnStartedEmitted) return;
  session.turnStartedEmitted = true;
  session.frontendCallback({ type: 'turn_start', turnId });
}

async function sendTurnStartWithRetry(
  session: CodexSession,
  content: string,
  generation: number,
  options?: EngineTurnOptions,
): Promise<any> {
  let retryCount = 0;
  let requestForwarded = false;
  while (true) {
    if (session.turnStartGeneration !== generation) throw new TurnStartRetryCancelledError();
    try {
      const result = await sendRequest(
        session,
        'turn/start',
        {
          threadId: session.threadId,
          input: [{ type: 'text', text: content }],
          ...(options?.preferences.modelId ? { model: options.preferences.modelId } : {}),
          ...(options?.preferences.reasoningEffort ? { effort: options.preferences.reasoningEffort } : {}),
          ...(options?.preferences.serviceTier ? { serviceTierForTurn: options.preferences.serviceTier } : {}),
        },
        {
          onSent: () => {
            if (requestForwarded) return;
            requestForwarded = true;
            session.frontendCallback({ type: 'request_forwarded' });
          },
        },
      );
      const acceptedTurnId = extractTurnId(result);
      if (acceptedTurnId) session.onInputAccepted?.(acceptedTurnId, content);
      if (session.turnStartGeneration !== generation) throw new TurnStartRetryCancelledError();
      return result;
    } catch (error) {
      if (session.turnStartGeneration !== generation) throw new TurnStartRetryCancelledError();
      if (session.currentTurnId || session.turnStartedEmitted) {
        logCodexVerbose('回合已开始，忽略迟到的 turn/start RPC 失败', {
          turnId: session.currentTurnId,
          message: error instanceof Error ? error.message : String(error),
        });
        return { turn: { id: session.currentTurnId } };
      }
      const retry = getTurnStartRetryDelay(error, retryCount, session.retryRandom);
      if (!retry) throw error;
      session.frontendCallback({ type: 'capacity_observation', observation: { type: 'request_retry' } });
      logCodexVerbose(`发送暂时不可用，${retry.delayMs}ms 后进行第 ${retryCount + 2} 次尝试`, {
        attempt: retryCount + 2,
        reason: retry.reason,
        rpcCode: error instanceof CodexRpcError ? error.rpcCode : null,
        httpStatus: retry.httpStatus,
        delayMs: retry.delayMs,
      });
      session.turnStartRetryPending = true;
      try {
        await session.retrySleep(retry.delayMs);
      } finally {
        if (session.turnStartGeneration === generation) session.turnStartRetryPending = false;
      }
      if (session.turnStartGeneration !== generation) throw new TurnStartRetryCancelledError();
      if (session.currentTurnId || session.turnStartedEmitted) {
        return { turn: { id: session.currentTurnId } };
      }
      retryCount += 1;
    }
  }
}

function scheduleCompletionOverloadRetry(
  session: CodexSession,
  turnId: string,
  failure: { message: string; code: string },
): boolean {
  const retryIndex = session.completionOverloadRetryCount;
  const content = session.turnInputContent;
  const turnOptions = session.turnInputOptions;
  if (
    failure.code !== 'CODEX_SERVER_OVERLOADED'
    || session.turnHasExecutionTrace
    || !content
    || retryIndex >= TURN_COMPLETION_OVERLOAD_BACKOFF_MS.length
  ) {
    return false;
  }

  const delayMs = jitterDelay(TURN_COMPLETION_OVERLOAD_BACKOFF_MS[retryIndex], session.retryRandom);
  session.frontendCallback({ type: 'capacity_observation', observation: { type: 'completion_retry' } });
  session.completionOverloadRetryCount += 1;
  resetTurnState(session, { preserveCompletionRetry: true });
  session.completionOverloadRetryPending = true;
  const generation = session.turnStartGeneration;
  logCodexVerbose(`完成阶段暂时过载，${delayMs}ms 后进行第 ${session.completionOverloadRetryCount + 1} 次尝试`, {
    attempt: session.completionOverloadRetryCount + 1,
    reason: 'server_overloaded',
    delayMs,
  });

  void session.retrySleep(delayMs).then(() => {
    if (session.turnStartGeneration !== generation || !session.completionOverloadRetryPending) return;
    session.completionOverloadRetryPending = false;
    startTurnAttempt(session, content, turnOptions ?? undefined, true);
  }).catch((error) => {
    if (session.turnStartGeneration !== generation) return;
    logCodexRuntimeFailure(`完成阶段重试等待失败：${error instanceof Error ? error.message : String(error)}`, error);
    session.frontendCallback({ type: 'turn_complete', turnId });
    session.frontendCallback({ type: 'error', ...failure });
    resetTurnState(session);
  });
  return true;
}

function startTurnAttempt(
  session: CodexSession,
  content: string,
  options: EngineTurnOptions | undefined,
  preserveCompletionRetry: boolean,
): void {
  resetTurnState(session, { preserveCompletionRetry });
  session.turnInputContent = content;
  session.turnInputOptions = options ?? null;
  const turnStartGeneration = session.turnStartGeneration;
  session.recoveredTurnStatus = null;
  session.turnReadyPromise = new Promise<string>((resolve, reject) => {
    session.resolveTurnReady = resolve;
    session.rejectTurnReady = reject;
  });
  void session.turnReadyPromise.catch(() => {});
  const selectedModel = options?.preferences.modelId;
  const turnModelInfo = selectedModel
    ? {
        model: selectedModel,
        ...(session.baselineModelInfo?.platformOs ? { platformOs: session.baselineModelInfo.platformOs } : {}),
        ...(session.baselineModelInfo?.modelProvider ? { modelProvider: session.baselineModelInfo.modelProvider } : {}),
        ...(options?.preferences.reasoningEffort ? { reasoningEffort: options.preferences.reasoningEffort } : {}),
      }
    : session.baselineModelInfo;
  if (turnModelInfo) {
    session.frontendCallback({ type: 'model_info', ...turnModelInfo });
  }

  sendTurnStartWithRetry(session, content, turnStartGeneration, options).then((result) => {
    const turnId = extractTurnId(result);
    if (turnId) markTurnStarted(session, turnId);
  }).catch((err) => {
    if (err instanceof TurnStartRetryCancelledError) return;
    session.rejectTurnReady?.(err);
    session.resolveTurnReady = null;
    session.rejectTurnReady = null;
    logCodexRuntimeFailure(`发送失败：${err.message}`, err);
    const threadArchived = isArchivedThreadError(err);
    const capacityFailure = getFinalTurnStartCapacityFailure(err);
    session.frontendCallback({
      type: 'error',
      message: threadArchived
        ? '该会话已在 ChatGPT/Codex 中归档，请在会话菜单中选择“取消归档”后重试。'
        : `发送消息失败: ${err.message}`,
      code: threadArchived ? 'CODEX_THREAD_ARCHIVED' : capacityFailure?.code || 'CODEX_TURN_ERROR',
      ...(capacityFailure?.retryAfterMs !== undefined ? { retryAfterMs: capacityFailure.retryAfterMs } : {}),
    });
    resetTurnState(session);
  });
}

function startTurn(session: CodexSession, content: string, options?: EngineTurnOptions): void {
  session.completionOverloadRetryCount = 0;
  session.turnInputContent = content;
  session.turnInputOptions = options ?? null;
  startTurnAttempt(session, content, options, false);
}

async function interruptTurn(session: CodexSession): Promise<void> {
  if (session.completionOverloadRetryPending) {
    resetTurnState(session);
    return;
  }
  if (session.sendQueue.length > 0 && !session.turnReadyPromise) {
    session.sendQueue = [];
    return;
  }

  if (session.recoveryReadyPromise) await session.recoveryReadyPromise;
  if (session.recoveredTurnStatus && session.recoveredTurnStatus !== 'inProgress') return;

  if (!session.currentTurnId && session.turnReadyPromise && session.turnStartRetryPending) {
    const error = new TurnStartRetryCancelledError();
    session.rejectTurnReady?.(error);
    resetTurnState(session);
    return;
  }

  let turnId = session.currentTurnId;
  if (!turnId && session.turnReadyPromise) turnId = await session.turnReadyPromise;
  if (session.recoveredTurnStatus === 'inProgress' && (!turnId || !session.threadId)) {
    throw new Error('Codex 恢复回合标识尚未就绪');
  }
  if (!turnId || !session.threadId) return;

  session.interruptedTurnIds.add(turnId);
  try {
    await sendRequest(session, 'turn/interrupt', {
      threadId: session.threadId,
      turnId,
    });
    resetTurnState(session);
  } catch (error) {
    session.interruptedTurnIds.delete(turnId);
    throw error;
  }
}

function handleServerRequest(
  session: CodexSession,
  request: { id: string | number; method: string; params?: Record<string, any> },
): void {
  const { id, method, params = {} } = request;
  // 无需用户感知的客户端基础能力直接完成。
  if (method === 'currentTime/read') {
    sendServerRequestResult(session, id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    return;
  }
  if (method === 'item/tool/call') {
    if (session.currentTurnId) session.turnHasExecutionTrace = true;
    if (params.namespace === null && params.tool === RELAY_FILE_CHANGE_REPORT_TOOL) {
      const report = parseRelayFileChangeReport(params.arguments);
      if (report) {
        sendServerRequestResult(session, id, {
          contentItems: [{
            type: 'inputText',
            text: `已登记 ${report.reportedFileChanges.length} 个文件变更。`,
          }],
          success: true,
        });
      } else {
        sendServerRequestResult(session, id, {
          contentItems: [{ type: 'inputText', text: '文件变更报告格式无效，未登记。' }],
          success: false,
        });
      }
      return;
    }
    sendServerRequestResult(session, id, { contentItems: [], success: false });
    session.frontendCallback({
      type: 'system_notice',
      noticeType: 'warning',
      title: '客户端工具不可用',
      message: '当前 Relay 客户端未提供该动态工具，已向 Codex 返回未执行。',
      details: { tool: params.tool, namespace: params.namespace },
    });
    return;
  }
  if (method === 'account/chatgptAuthTokens/refresh' || method === 'attestation/generate') {
    sendServerRequestError(session, id, `Relay 暂不支持客户端能力：${method}`);
    session.frontendCallback({
      type: 'system_notice',
      noticeType: 'warning',
      title: '客户端能力不可用',
      message: method === 'account/chatgptAuthTokens/refresh'
        ? 'Codex 请求客户端刷新登录凭据，但当前 Relay 无法提供。'
        : 'Codex 请求生成客户端证明，但当前 Relay 无法提供。',
      details: { capability: method },
    });
    return;
  }

  const interactiveMethods = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
    'execCommandApproval',
    'applyPatchApproval',
  ]);
  if (!interactiveMethods.has(method)) {
    sendServerRequestError(session, id, `Relay 无法处理未知客户端请求：${method}`);
    session.frontendCallback({
      type: 'system_notice',
      noticeType: 'warning',
      title: '无法处理客户端请求',
      message: `Relay 已拒绝未知请求 ${method}，避免任务无限等待。`,
    });
    return;
  }

  if (session.currentTurnId) session.turnHasExecutionTrace = true;
  session.frontendCallback({ type: 'server_request', requestId: id, method, params });
}

// ── Notification handler ─────────────────────────────────────────────

function handleNotification(session: CodexSession, notification: { method: string; params?: any }) {
  const { method, params = {} } = notification;

  // app-server 会在同一连接上广播子代理线程事件。除跨线程 request ID
  // 解析外，只允许当前 Relay 会话绑定的根线程更新回复缓冲区和任务生命周期。
  if (method !== 'serverRequest/resolved' && !isNotificationForActiveThread(session.threadId, params.threadId)) {
    return;
  }

  // Out-of-band messages never rebuild the active turn's message buffers.
  const asyncMessage = extractAsyncAgentMessageNotification(method, params);
  if (asyncMessage) { session.frontendCallback(asyncMessage); return; }
  if (isStaleTurnNotification(method, params, session.currentTurnId, session.retiredTurnIds)) {
    if (method === 'turn/completed') session.interruptedTurnIds.delete(extractTurnId(params)!);
    return;
  }

  switch (method) {
    case 'error': {
      if (params.willRetry === true && session.currentTurnId && params.turnId === session.currentTurnId) {
        session.frontendCallback(presentRetryNotice(params, ++session.retryNoticeCount));
      }
      break;
    }
    case 'turn/started': {
      const turnId = extractTurnId(params);
      if (turnId) markTurnStarted(session, turnId);
      break;
    }

    case 'turn/completed': {
      if (process.env.RELAY_VERBOSE_LOGS === '1') {
        console.log('[Codex] turn/completed 原始参数:', JSON.stringify(params, null, 2));
      }
      const turnId = extractTurnId(params) || session.currentTurnId;
      // Cancel intent is not a stopped fact: a natural completion/failure can win the RPC race.
      if (turnId && session.interruptedTurnIds.delete(turnId) && params.turn?.status === 'interrupted') {
        resetTurnState(session);
        break;
      }
      // 提取 token 用量
      const usage = params.usage || params.tokenUsage || params.token_usage || null;
      const completedContent = buildCompletedMessageContent(session);
      const turnFailure = extractTurnFailure(params);
      if (turnFailure && scheduleCompletionOverloadRetry(session, turnId || '', turnFailure)) break;
      session.frontendCallback({ type: 'turn_complete', turnId: turnId || '' });
      if (turnFailure) {
        session.frontendCallback({ type: 'error', ...turnFailure });
      } else if (completedContent.content.trim()) {
        session.frontendCallback({
          type: 'message_complete',
          turnId: turnId || '',
          ...completedContent,
          usage,
        });
      } else {
        session.frontendCallback({
          type: 'error',
          message: '未生成最终回复',
          code: 'FINAL_ANSWER_MISSING',
        });
      }
      resetTurnState(session);
      break;
    }

    case 'turn/plan/updated': {
      const update = extractPlanUpdate(params, session.currentTurnId, session.threadId);
      if (update) session.frontendCallback(update);
      break;
    }

    case 'item/started': {
      if (itemLeavesNonRetryableTrace(params.item)) session.turnHasExecutionTrace = true;
      const itemId = typeof params.item?.id === 'string' ? params.item.id : null;
      const phase = getAgentMessagePhase(params.item?.phase);
      if (itemId && phase) {
        session.agentMessagePhases.set(itemId, phase);
        ensureAgentMessage(session, itemId, phase);
      }
      session.frontendCallback({
        type: 'item_start',
        item: params.item,
      });
      break;
    }

    case 'item/completed': {
      if (itemLeavesNonRetryableTrace(params.item)) session.turnHasExecutionTrace = true;
      const itemId = typeof params.item?.id === 'string' ? params.item.id : null;
      const phase = getAgentMessagePhase(params.item?.phase);
      if (itemId && phase) session.agentMessagePhases.set(itemId, phase);
      if (params.item?.type === 'agentMessage' && itemId) {
        const resolvedPhase = phase || session.agentMessagePhases.get(itemId) || null;
        const message = ensureAgentMessage(session, itemId, resolvedPhase);
        if (typeof params.item.text === 'string' && params.item.text.length > 0) {
          message.text = params.item.text;
        }
        rebuildAgentMessageBuffers(session);
      }
      session.frontendCallback({
        type: 'item_complete',
        item: params.item,
        threadId: params.threadId,
        turnId: params.turnId,
      });
      break;
    }

    case 'item/agentMessage/delta': {
      session.turnHasExecutionTrace = true;
      const { delta, itemId, phase } = params;
      session.currentItemId = itemId;
      const normalizedItemId = typeof itemId === 'string' ? itemId : null;
      const resolvedPhase = getAgentMessagePhase(phase)
        || (normalizedItemId ? session.agentMessagePhases.get(normalizedItemId) || null : null);
      let rawDelta = typeof delta === 'string' ? delta : '';
      const skipChars = normalizedItemId ? session.recoveryDeltaSkipChars.get(normalizedItemId) || 0 : 0;
      if (skipChars > 0) {
        const consumed = Math.min(skipChars, rawDelta.length);
        rawDelta = rawDelta.slice(consumed);
        session.recoveryDeltaSkipChars.set(normalizedItemId!, skipChars - consumed);
        if (!rawDelta) break;
      }
      if (rawDelta.length > 0) session.turnHasExecutionTrace = true;
      if (normalizedItemId) {
        appendAgentMessageDelta(session, normalizedItemId, rawDelta, resolvedPhase);
        const currentAt = Date.now();
        const diagnostic = buildAgentMessageGapDiagnostic(
          normalizedItemId,
          resolvedPhase,
          session.lastAgentDeltaAt.get(normalizedItemId) ?? null,
          currentAt,
          rawDelta.length,
          session.agentMessages.get(normalizedItemId)?.text.length || 0,
        );
        session.lastAgentDeltaAt.set(normalizedItemId, currentAt);
        if (diagnostic && !session.warnedAgentDeltaGaps.has(normalizedItemId)) {
          session.warnedAgentDeltaGaps.add(normalizedItemId);
          console.warn('[Codex] agentMessage delta resumed after long gap:', diagnostic);
        }
      }

      // 实时路径继续增量追加；只有 completed 权威校正和恢复快照才完整重建。
      const complete = appendAgentMessageItemText(
        session.buffer,
        rawDelta,
        normalizedItemId,
        session.lastAgentMessageItemId,
      );
      session.buffer = complete.text;
      session.lastAgentMessageItemId = complete.itemId;

      let routedContent = rawDelta;
      if (resolvedPhase === 'commentary') {
        const commentary = appendAgentMessageItemText(
          session.commentaryBuffer,
          rawDelta,
          normalizedItemId,
          session.lastCommentaryItemId,
        );
        session.commentaryBuffer = commentary.text;
        session.lastCommentaryItemId = commentary.itemId;
        routedContent = commentary.appended;
      } else if (resolvedPhase === 'final_answer') {
        const finalAnswer = appendAgentMessageItemText(
          session.finalAnswerBuffer,
          rawDelta,
          normalizedItemId,
          session.lastFinalAnswerItemId,
        );
        session.finalAnswerBuffer = finalAnswer.text;
        session.lastFinalAnswerItemId = finalAnswer.itemId;
        routedContent = finalAnswer.appended;
      }
      session.frontendCallback({
        type: 'delta',
        itemId,
        content: routedContent,
        ...(resolvedPhase ? { phase: resolvedPhase } : {}),
      });
      break;
    }

    case 'serverRequest/resolved': {
      if (params.requestId !== undefined) {
        session.frontendCallback({ type: 'server_request_resolved', requestId: params.requestId });
      }
      break;
    }

    case 'thread/tokenUsage/updated': {
      const usage = extractThreadTokenUsage(params);
      if (usage) session.frontendCallback({ type: 'token_usage', usage });
      break;
    }

    case 'model/rerouted': {
      const effectiveModel = typeof params.toModel === 'string' ? params.toModel.trim() : '';
      if (effectiveModel) {
        session.frontendCallback({
          type: 'model_info',
          model: effectiveModel,
          ...(session.baselineModelInfo?.modelProvider
            ? { modelProvider: session.baselineModelInfo.modelProvider }
            : {}),
          ...(session.turnInputOptions?.preferences.reasoningEffort
            ? { reasoningEffort: session.turnInputOptions.preferences.reasoningEffort }
            : {}),
        });
      }
      session.frontendCallback(presentModelReroutedNotice(params));
      break;
    }

    case 'thread/compacted': {
      session.frontendCallback({
        type: 'system_notice',
        noticeType: 'context_compaction',
        title: '已整理上下文',
        message: '为继续处理长会话，Codex 已压缩较早的上下文。',
        contextCompaction: { threadId: params.threadId, turnId: params.turnId },
      });
      break;
    }

    case 'warning':
    case 'guardianWarning':
    case 'configWarning':
    case 'deprecationNotice': {
      session.frontendCallback(presentWarningNotification(method, params));
      break;
    }

    // Ignore other notifications silently (progressive enhancement)
    default:
      break;
  }
}
