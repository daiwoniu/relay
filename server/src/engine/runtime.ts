import type { InteractionResolvedAction, MessageModelInfoDto, TokenUsageDto } from '../contracts/index.js';
import type { ProcessTimelineEntry } from '../process-timeline.js';
import type {
  EngineConnection,
  EngineEvent,
  EngineTurnItem,
} from './adapter.js';
import type { EngineEventEnvelope } from './events.js';
import type { EngineInteractionRequest, NormalizedInteraction } from './interactions.js';
import type { EngineId } from './types.js';
import type { EngineTurnFactSink } from './turn-fact-sink.js';
import type { EnginePerformanceObserver } from './performance-observability.js';
import { closePerformanceObservation, observeEnginePerformanceEvent } from './runtime-performance.js';

export type RuntimeTurnItem = EngineTurnItem;

export interface TurnModelSnapshot {
  preferences: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null };
  displayNames: Record<string, string>;
  modelDefaults: Record<string, { reasoningEffort?: string; serviceTier?: string | null }>;
  defaultModelId: string | null;
  modelInfo: MessageModelInfoDto | null;
}

export interface SessionRuntime {
  sessionId: string;
  projectId: string | null;
  engine: EngineId;
  engineConnection: EngineConnection | null;
  engineConnectionId: string | null;
  turnStartTime: number | null;
  currentTurnId: string | null;
  turnItems: RuntimeTurnItem[];
  processTimeline: ProcessTimelineEntry[];
  currentContent: string;
  commentaryContent: string;
  finalAnswerContent: string;
  lastFinalAnswerItemId: string | null;
  isRunning: boolean;
  isStopping: boolean;
  interruptPromise: Promise<void> | null;
  requestForwarded: boolean;
  interactionCancelRequested: boolean;
  modelInfo: Extract<EngineEvent, { type: 'model_info' }> | null;
  turnModelSnapshot: TurnModelSnapshot | null;
  latestTokenUsage: TokenUsageDto | null;
  tokenUsage: TokenUsageDto | null;
  pendingInteractions: Map<string, {
    request: EngineInteractionRequest;
    interaction: NormalizedInteraction;
    standalone: boolean;
    manualReview?: true;
    createdAt: number;
    connectionId: string | null;
  }>;
  settledInteractionIds: Set<string>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  /** 独立授权卡片合并窗计时器：窗内的多张卡合并落库为同一条 assistant 消息。 */
  standaloneInteractionTimer: ReturnType<typeof setTimeout> | null;
  /** 合并窗内累积的独立授权卡片，落库时一起写入同一条消息的 items。 */
  standaloneInteractionItems: RuntimeTurnItem[];
  isRecovering: boolean;
  recoveryPreviousStatus: 'pending' | 'processing' | 'awaiting_action' | 'stopping' | null;
  recoveryInteractionTimer: ReturnType<typeof setTimeout> | null;
  attemptId: string | null;
  resourceKey: string | null;
  leaseToken: string | null;
  requestedByUserId: string | null;
  observeEngineEvent: ((event: EngineEventEnvelope) => void) | null;
  turnFactSink: EngineTurnFactSink | null;
  performanceObservation: EnginePerformanceObserver | null;
}

export function createSessionRuntimeState(input: {
  sessionId: string;
  projectId: string | null;
  engine: EngineId;
  observeEngineEvent?: (event: EngineEventEnvelope) => void;
  turnFactSink?: EngineTurnFactSink;
}): SessionRuntime {
  return {
    ...input,
    engineConnection: null,
    engineConnectionId: null,
    turnStartTime: null,
    currentTurnId: null,
    turnItems: [],
    processTimeline: [],
    currentContent: '',
    commentaryContent: '',
    finalAnswerContent: '',
    lastFinalAnswerItemId: null,
    isRunning: false,
    isStopping: false,
    interruptPromise: null,
    requestForwarded: false,
    interactionCancelRequested: false,
    modelInfo: null,
    turnModelSnapshot: null,
    latestTokenUsage: null,
    tokenUsage: null,
    pendingInteractions: new Map(),
    settledInteractionIds: new Set(),
    cleanupTimer: null,
    standaloneInteractionTimer: null,
    standaloneInteractionItems: [],
    isRecovering: false,
    recoveryPreviousStatus: null,
    recoveryInteractionTimer: null,
    attemptId: null,
    resourceKey: null,
    leaseToken: null,
    requestedByUserId: null,
    observeEngineEvent: input.observeEngineEvent ?? null,
    turnFactSink: input.turnFactSink ?? null,
    performanceObservation: null,
  };
}

export function prepareClaimedSessionRuntime(
  runtime: SessionRuntime,
  input: {
    projectId: string | null;
    attemptId: string;
    resourceKey: string;
    leaseToken: string;
    requestedByUserId: string;
    claimedAt: number;
    preferences?: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null };
    displayNames?: Record<string, string>;
    modelDefaults?: Record<string, { reasoningEffort?: string; serviceTier?: string | null }>;
    defaultModelId?: string | null;
  },
): void {
  runtime.projectId = input.projectId;
  runtime.attemptId = input.attemptId;
  runtime.resourceKey = input.resourceKey;
  runtime.leaseToken = input.leaseToken;
  runtime.requestedByUserId = input.requestedByUserId;
  runtime.turnStartTime = input.claimedAt;
  runtime.currentTurnId = null;
  runtime.turnItems = [];
  runtime.processTimeline = [];
  runtime.currentContent = '';
  runtime.commentaryContent = '';
  runtime.finalAnswerContent = '';
  runtime.lastFinalAnswerItemId = null;
  runtime.isRunning = true;
  runtime.isStopping = false;
  runtime.requestForwarded = false;
  runtime.interactionCancelRequested = false;
  runtime.latestTokenUsage = null;
  runtime.tokenUsage = null;
  runtime.isRecovering = false;
  runtime.recoveryPreviousStatus = null;
  runtime.turnModelSnapshot = {
    preferences: input.preferences ?? { modelId: null, reasoningEffort: null },
    displayNames: input.displayNames ?? {},
    modelDefaults: input.modelDefaults ?? {},
    defaultModelId: input.defaultModelId ?? null,
    modelInfo: null,
  };
}

export function resolveTurnStartPreferences(runtime: SessionRuntime): TurnModelSnapshot['preferences'] {
  const snapshot = runtime.turnModelSnapshot;
  if (!snapshot) return { modelId: null, reasoningEffort: null, serviceTier: null };
  if (runtime.engine !== 'codex') return snapshot.preferences;
  const modelId = snapshot.preferences.modelId ?? snapshot.defaultModelId;
  const defaults = modelId ? snapshot.modelDefaults[modelId] : undefined;
  return {
    modelId,
    reasoningEffort: snapshot.preferences.reasoningEffort ?? defaults?.reasoningEffort ?? null,
    serviceTier: snapshot.preferences.serviceTier ?? defaults?.serviceTier ?? null,
  };
}

export function updateTurnModelSnapshot(
  runtime: SessionRuntime,
  model: Extract<EngineEvent, { type: 'model_info' }>,
): void {
  if (!runtime.turnModelSnapshot) return;
  const requestedId = runtime.turnModelSnapshot.preferences.modelId;
  const defaults = runtime.turnModelSnapshot.modelDefaults[model.model];
  const reasoningEffort = model.reasoningEffort
    || (requestedId === model.model ? runtime.turnModelSnapshot.preferences.reasoningEffort : null)
    || defaults?.reasoningEffort;
  const resolvedPreferences = resolveTurnStartPreferences(runtime);
  const hasTierSnapshot = runtime.engine === 'codex' && (
    Boolean(runtime.turnModelSnapshot.preferences.serviceTier)
    || Boolean(resolvedPreferences.modelId && runtime.turnModelSnapshot.modelDefaults[resolvedPreferences.modelId])
  );
  runtime.turnModelSnapshot.modelInfo = {
    engineId: runtime.engine,
    ...(requestedId ? {
      requested: {
        id: requestedId,
        ...(runtime.turnModelSnapshot.displayNames[requestedId]
          ? { displayName: runtime.turnModelSnapshot.displayNames[requestedId] }
          : {}),
        ...(runtime.turnModelSnapshot.preferences.reasoningEffort
          ? { reasoningEffort: runtime.turnModelSnapshot.preferences.reasoningEffort }
          : {}),
      },
    } : {}),
    effective: {
      id: model.model,
      displayName: runtime.turnModelSnapshot.displayNames[model.model] || model.model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(model.modelProvider ? { provider: model.modelProvider } : {}),
    },
    ...(runtime.engine === 'codex' ? { serviceTier: runtime.turnModelSnapshot.preferences.serviceTier ?? null } : {}),
    ...(hasTierSnapshot ? { resolvedServiceTier: resolvedPreferences.serviceTier ?? null } : {}),
    rerouted: Boolean(requestedId && requestedId !== model.model),
  };
}

export function clearTurnModelSnapshot(runtime: SessionRuntime): void {
  runtime.turnModelSnapshot = null;
}

export type RuntimeInteractionDecision =
  | {
      resolvedAction: Exclude<InteractionResolvedAction, 'resolved_elsewhere'>;
      source: 'user';
      decidedAt: number;
      decidedByDeviceId?: string | null;
      decidedByDeviceType?: string | null;
    }
  | { resolvedAction: 'resolved_elsewhere'; source: 'resolved_elsewhere'; decidedAt: number }
  | { resolvedAction: 'accept'; source: 'session_trust' | 'project_trust'; expiresAt: number | null; decidedAt: number };

export function isProviderResolvedInteraction(item: RuntimeTurnItem): boolean {
  return item.type === 'interaction' && item.status === 'completed'
    && (item.details as Record<string, unknown> | undefined)?.resolvedAction === 'resolved_elsewhere';
}

function rememberSettledInteraction(runtime: SessionRuntime, interactionId: string): void {
  runtime.settledInteractionIds.add(interactionId);
  if (runtime.settledInteractionIds.size <= 512) return;
  const oldest = runtime.settledInteractionIds.values().next().value;
  if (oldest) runtime.settledInteractionIds.delete(oldest);
}

export function completeRuntimeInteraction(
  runtime: SessionRuntime,
  interactionId: string,
  decision: RuntimeInteractionDecision,
  reconcileConfirmedResponse = false,
): RuntimeTurnItem | null {
  const index = runtime.turnItems.findIndex((item) => item.id === interactionId);
  if (index < 0) return null;
  const existing = runtime.turnItems[index]!;
  if (existing.status === 'completed' && !(reconcileConfirmedResponse && decision.source === 'user'
    && isProviderResolvedInteraction(existing))) return existing;
  const trustSource = decision.source === 'session_trust' || decision.source === 'project_trust';
  const completed: RuntimeTurnItem = {
    ...existing,
    status: 'completed',
    details: {
      ...(existing.details as Record<string, unknown> || {}),
      resolvedAction: decision.resolvedAction,
      decisionSource: decision.source,
      effectiveScope: decision.source === 'session_trust' ? 'session' : decision.source === 'project_trust' ? 'project' : null,
      trustExpiresAt: trustSource ? decision.expiresAt : null,
      decidedAt: decision.decidedAt,
      decidedByDeviceId: 'decidedByDeviceId' in decision ? decision.decidedByDeviceId ?? null : null,
      decidedByDeviceType: 'decidedByDeviceType' in decision ? decision.decidedByDeviceType ?? null : null,
    },
  };
  runtime.turnItems[index] = completed;
  rememberSettledInteraction(runtime, interactionId);
  return completed;
}

export function attachEngineConnection(
  runtime: SessionRuntime,
  connection: EngineConnection,
  connectionId: string,
): void {
  runtime.settledInteractionIds.clear();
  runtime.engineConnection = connection;
  runtime.engineConnectionId = connectionId;
}

/**
 * 清理归属于某个引擎连接的待处理授权，返回被清理的交互 id 供调用方广播失效。
 * 连接断开后这些请求已不可能被引擎处理，留在内存里既无意义也可能串到后续连接。
 */
export function clearPendingInteractionsForConnection(runtime: SessionRuntime, connectionId: string | null): string[] {
  if (!connectionId) return [];
  const cleared: string[] = [];
  for (const [interactionId, pending] of runtime.pendingInteractions) {
    if (pending.connectionId === connectionId) cleared.push(interactionId);
  }
  for (const interactionId of cleared) runtime.pendingInteractions.delete(interactionId);
  return cleared;
}

export function disconnectEngineConnection(runtime: SessionRuntime): void | Promise<void> {
  closePerformanceObservation(runtime);
  const connection = runtime.engineConnection;
  runtime.engineConnection = null;
  runtime.engineConnectionId = null;
  return connection?.close();
}

export function routeEngineEvent(
  runtime: SessionRuntime,
  connectionId: string,
  event: EngineEventEnvelope,
  handler: (event: EngineEventEnvelope) => void,
): boolean {
  if (runtime.engineConnectionId !== connectionId) return false;
  if (runtime.engine !== event.engineId) return false;
  observeEnginePerformanceEvent(runtime, event.payload);
  try {
    runtime.observeEngineEvent?.(event);
  } catch {
    // Observer 只用于后续事实迁移观察，不能中断现有运行链路。
  }
  if (runtime.attemptId) {
    try {
      runtime.turnFactSink?.record(event, {
        sessionId: runtime.sessionId,
        attemptId: runtime.attemptId,
        connectionId,
        engineId: runtime.engine,
        userStopRequested: runtime.isStopping,
      });
    } catch {
      // 事实写入失败不能中断现有运行链路，终态投影会保留活动态供重启恢复。
    }
  }
  handler(event);
  return true;
}

export function shouldRetainSessionRuntime(runtime: SessionRuntime, subscriberCount: number): boolean {
  return runtime.isRunning || subscriberCount > 0;
}
