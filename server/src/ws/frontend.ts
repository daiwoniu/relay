import { v4 as uuid } from 'uuid';
import { WebSocketServer, WebSocket as WSClient } from 'ws';
import { createConnectionDiagnostics } from './connection-diagnostics.js';
import { buildRuntimeAssistantSnapshot } from './frontend-terminal-snapshot.js';
import { listSessionReadReceipts } from '../db/session-attention.js';
import { handleSessionRead } from './session-read.js';
import type { EngineAdapter, EngineEvent } from '../engine/adapter.js';
import { getTerminalCapacityFailure } from '../engine/diagnostics.js';
import { writeSessionTerminalLog } from '../engine/session-observability.js';
import { defaultEngineSystem } from '../engine/default-system.js';
import { getDB } from '../db/index.js';
import { createSessionHostContextDelivery } from '../db/session-host-context.js';
import { listSessionFollowups } from '../db/session-followups.js';
import { DatabaseEngineConcurrencyRepository } from '../engine/concurrency/repository.js';
import { ProviderTurnScheduler } from '../engine/concurrency/scheduler.js';
import { getQueueEntryBySessionInDatabase, markLeaseRunningInDatabase } from '../db/engine-concurrency.js';
import type { RecoverableSessionRecord } from '../db/queries-recovery.js';
import { EngineRegistryError } from '../engine/registry.js';
import { engineStatusService } from '../system/engine-status.js';
import { startupDiagnostics } from '../system/startup-diagnostics.js';
import {
  attachEngineConnection,
  createSessionRuntimeState,
  clearPendingInteractionsForConnection,
  disconnectEngineConnection,
  prepareClaimedSessionRuntime,
  resolveTurnStartPreferences,
  routeEngineEvent,
  shouldRetainSessionRuntime,
  updateTurnModelSnapshot,
  completeRuntimeInteraction,
  type RuntimeTurnItem,
  type SessionRuntime,
} from '../engine/runtime.js';
import {
  RELAY_PROTOCOL_VERSION,
  type SendCommand,
  type RespondInteractionCommand,
  type SessionStatus,
  type FrontendEvent,
  type PendingApprovalDto,
  type TokenUsageDto,
  type EngineConcurrencyDto,
  type TurnQueueSnapshotDto,
} from '../contracts/index.js';
import {
  classifySessionTitleMessage,
  generateSessionTitle,
  shouldUpdateAutomaticSessionTitle,
} from '../session-title.js';
import { serializeMessageMetadata } from '../message-metadata.js';
import { authenticateCookieSession } from '../auth/middleware.js';
import { projectService } from '../services/projects.js';
import { sessionService } from '../services/sessions.js';
import { TurnAdmissionError, TurnAdmissionService } from '../services/turn-admission.js';
import { prepareWorkspaceTaskLink } from './frontend-workspace-task.js';
import { createFrontendFollowups, hasBlockingSessionFollowups, presentSessionFollowup, validateAsyncQuestionSend } from './frontend-followups.js';
import type { EffectiveApprovalTrust } from '../services/approval-trust.js';
import { createEngineConcurrencyApi } from '../services/engine-concurrency-api.js';
import { deletionState } from '../services/deletion-state.js';
import { presentMessage, presentProcessItem } from '../messages/presenter.js';
import { appendAsyncQuestionItem } from './frontend-async-questions.js';
import { collectChangedFiles, hasIncompleteChangedFilesReport } from '../messages/changed-files.js';
import { prepareMessageAttachments } from '../messages/message-attachments.js';
import { QueuedTurnDispatcher } from './queued-turn-dispatch.js';
import {
  appendNarrativeDelta,
  insertOperationReference,
  takeFinalAnswerFromTimeline,
  type ProcessTimelineEntry,
} from '../process-timeline.js';
import { requestRuntimeInterrupt } from './runtime-interrupt.js';
import { accumulateTurnOutputUsage } from '../token-usage-accumulator.js';
import type { EngineTerminalProjectionResult } from '../db/queries.js';
import { createEngineTurnFactSink } from '../engine/turn-fact-sink.js';
import { arbitrateTerminalDecision } from '../engine/terminal-arbitrator.js';
import { beginTurnPerformanceObservation, ensureConnectionPerformanceObservation, finishPerformanceObservation, markPerformanceMilestone, observeSessionReady } from '../engine/runtime-performance.js';
import type { EngineTerminalDecision } from '../engine/turn-facts.js';
import {
  createEngineTerminalProjectionService,
  publishEngineTerminalProjectionSafely,
  type EngineTerminalProjectionInput,
  type EngineTerminalProjectionSnapshot,
} from '../services/engine-terminal-projection.js';
import { getEngineTerminalDecisionInDatabase, listEngineTurnFactsInDatabase } from '../db/engine-turn-facts.js';
import {
  addFrontendClient, broadcastActorFrontendEvent, broadcastAuthenticatedFrontendEvent, broadcastFrontendEvent,
  broadcastProjectDelete, broadcastProjectUpdate, broadcastSessionDelete,
  broadcastSessionUpdate, broadcastSidebarOrderUpdate, broadcastUserFrontendEvent, broadcastSessionResourceEvent as broadcastSessionResourceEventToClients,
  deleteFrontendClient, getClientSubscribedSessionIds, getSessionSubscriberCount, isClientAuthenticated,
  mergeSessionEventRecipients, removeClientSubscription, sendFrontendEvent, setClientContext, setClientDevice, setClientResourceScope, setClientSubscription,
  type FrontendClient,
} from './frontend-client-hub.js';
import { buildInteractionResponse, createScopedInteractionId, getPendingApprovalResolution, isTurnCancellingInteractionResponse, shouldFinalizeAsUserCancelled } from './frontend-interactions.js';
import { routeIncomingApproval } from './frontend-approval-routing.js';
import { authorizeFrontendClientSession } from './frontend-client-authorization.js';
import { canManageOwnedResource } from '../auth/authorization.js';
import { resetSessionRuntime } from './frontend-runtime-reset.js';
import { auditSessionAdminAction, auditSessionAdminActionSync, beginSessionAdminAudit } from './frontend-admin-audit.js';
import {
  getEngineMaintenanceSendError, getServiceRecoverySendError, resolveInterruptFailureStatus,
  resolveRecoveryInProgressStatus, resolveSessionStatusForVisibility, updateAutomaticTitleBestEffort,
  resolveInteractionSessionStatus, presentRuntimeSession,
} from './frontend-runtime-policy.js';
import { buildFailedSendMessages, buildFailedSendUserContent, type RejectedSendInput } from './frontend-send-failures.js';
import {
  buildRuntimeSyncState,
  buildRuntimeOnlySyncState,
  getPendingApproval as getPendingApprovalFromRuntimes,
  listPendingApprovals as listPendingApprovalsFromRuntimes,
} from './frontend-session-sync.js';
import { reconcileRecoveredConcurrency } from './frontend-concurrency-recovery.js';
import { persistContextCompactionCountSafely, persistContextCompactionItemSafely } from './context-compaction.js';
import { buildRuntimeMessageMetadata, EnginePreferencesValidationError, getPersistedEnginePreferences, loadTurnModelCatalogSnapshot, resolveSendEnginePreferences, validateSendEnginePreferences } from './frontend-model-selection.js';
import { createFrontendOriginContext, createMessageOriginForClient } from '../message-origin.js';
import {
  VISIBLE_ITEM_TYPES,
  getEngineDisplayName,
  getEngineErrorPrefix,
  getErrorMessage,
  getRuntimeExecutionStage,
  parseFrontendMessage,
  presentUsage,
  upsertTurnItem,
} from './frontend-protocol.js';
export { buildFailedSendMessages, buildFailedSendUserContent } from './frontend-send-failures.js';
export { buildInteractionResponse, createInteractionItem, getPendingApprovalResolution, isTurnCancellingInteractionResponse, normalizeInteractionOrFallback, shouldFinalizeAsUserCancelled } from './frontend-interactions.js';
export { getEngineMaintenanceSendError, getServiceRecoverySendError, resolveInterruptFailureStatus, resolveRecoveryInProgressStatus, resolveSessionStatusForVisibility, updateAutomaticTitleBestEffort } from './frontend-runtime-policy.js';
export { broadcastAuthenticatedFrontendEvent, broadcastProjectDelete, broadcastProjectUpdate, broadcastSessionDelete, broadcastSessionDeletionProgress, broadcastSessionUpdate, broadcastSidebarOrderUpdate, broadcastUserFrontendEvent, mergeSessionEventRecipients } from './frontend-client-hub.js';
export { parseFrontendMessage, upsertTurnItem } from './frontend-protocol.js';
const runtimes = new Map<string, SessionRuntime>(), engineTurnFactSink = createEngineTurnFactSink();
const engineTerminalProjection = createEngineTerminalProjectionService();
const { registry: engineRegistry } = defaultEngineSystem;
function broadcastEngineConcurrency(resourceKey: string): void { broadcastActorFrontendEvent((actor) => ({ type: 'engine_concurrency_updated', concurrency: engineConcurrencyApi.getSnapshot(resourceKey, { id: actor.userId, role: actor.role }) })); }
const engineConcurrencyApi = createEngineConcurrencyApi({
  registry: engineRegistry, getDb: getDB,
  broadcast: broadcastEngineConcurrency,
  drain: (resourceKey) => getTurnScheduler().drain(resourceKey),
});
let turnAdmissionService: TurnAdmissionService | null = null, turnScheduler: ProviderTurnScheduler | null = null;
const followups = createFrontendFollowups({
  runtimeOf: (sessionId) => {
    const runtime = runtimes.get(sessionId);
    const queue = getTurnQueueSnapshot(sessionId);
    return runtime || queue ? { isRunning: Boolean(runtime?.isRunning || queue), turnId: runtime?.isRunning ? runtime.currentTurnId : null,
      ...(runtime?.isRunning && !runtime.isStopping && !runtime.isRecovering && runtime.pendingInteractions.size === 0 && runtime.engineConnection?.steer ? { steer: runtime.engineConnection.steer } : {}) } : null;
  }, admission: () => getTurnAdmissionService(), drain: (key) => getTurnScheduler().drain(key), queueSnapshot: getTurnQueueSnapshot,
  changed: (record) => {
    const ownerId = sessionService.getRecord(record.sessionId)?.owner_user_id;
    if (ownerId) broadcastUserFrontendEvent(ownerId, { type: 'session_followup_updated', sessionId: record.sessionId, followup: presentSessionFollowup(record) });
  },
});
const resolveManualApprovalTrust = (_ownerUserId: string, _sessionId: string): EffectiveApprovalTrust => ({ trusted: false, source: 'manual', effectiveScope: null, expiresAt: null, sessionOverridesProject: false, diagnostic: 'scope_unavailable' });
let resolveApprovalTrust = resolveManualApprovalTrust;
function getTurnAdmissionService(): TurnAdmissionService {
  return turnAdmissionService ??= new TurnAdmissionService(getDB());
}
function getTurnScheduler(): ProviderTurnScheduler {
  if (turnScheduler) return turnScheduler;
  const repository = new DatabaseEngineConcurrencyRepository(getDB(), (resourceKey) => {
    for (const adapter of engineRegistry.list()) {
      const resource = adapter.concurrency?.resolveResource({ sessionId: 'default', projectId: 'default' });
      if (resource?.resourceKey === resourceKey) return resource.defaultMaxActiveTurns;
    }
    throw new Error(`未知引擎并发资源：${resourceKey}`);
  });
  const dispatcher = new QueuedTurnDispatcher({
    loadUserMessage: (sessionId, messageId) => sessionService.getMessageRecord(sessionId, messageId) || null,
    startTurn: async ({ claim, content }) => {
      const runtime = getOrCreateRuntime(claim.queue.sessionId);
      if (runtime.isRunning && runtime.attemptId !== claim.queue.attemptId) {
        throw new Error('会话 runtime 已被其他 attempt 占用');
      }
      const session = sessionService.getRecord(claim.queue.sessionId);
      const preferences = getPersistedEnginePreferences(session);
      const modelCatalogSnapshot = await loadTurnModelCatalogSnapshot(claim.queue.engineId, preferences);
      prepareClaimedSessionRuntime(runtime, {
        projectId: session?.project_id || null,
        attemptId: claim.queue.attemptId,
        resourceKey: claim.queue.resourceKey,
        leaseToken: claim.lease.leaseToken,
        requestedByUserId: claim.queue.requestedByUserId,
        claimedAt: claim.queue.claimedAt || Date.now(),
        preferences, ...modelCatalogSnapshot,
      });
      beginTurnPerformanceObservation(runtime, { engine: claim.queue.engineId, existingSession: Boolean(session?.engine_session_id), connectionReused: Boolean(runtime.engineConnection), recovery: false, startedAt: claim.queue.claimedAt || Date.now() });
      sessionService.setActiveTurnUsage(runtime.sessionId, null);
      sessionService.setActiveTurn(runtime.sessionId, null, runtime.turnStartTime);
      broadcastSessionUpdate(sessionService.require(runtime.sessionId));
      broadcastFrontendEvent({ type: 'turn_queue_started', sessionId: runtime.sessionId, queueId: claim.queue.id });
      broadcastFrontendEvent({ type: 'turn_queue_updated', sessionId: runtime.sessionId, queue: getTurnQueueSnapshot(runtime.sessionId) });
      ensureEngineConnection(runtime);
      runtime.engineConnection!.send(content, { preferences: resolveTurnStartPreferences(runtime) });
    },
    failTurn: (claim, error) => {
      const runtime = getOrCreateRuntime(claim.queue.sessionId);
      const session = sessionService.getRecord(claim.queue.sessionId);
      prepareClaimedSessionRuntime(runtime, {
        projectId: session?.project_id || null,
        attemptId: claim.queue.attemptId,
        resourceKey: claim.queue.resourceKey,
        leaseToken: claim.lease.leaseToken,
        requestedByUserId: claim.queue.requestedByUserId,
        claimedAt: claim.queue.claimedAt || Date.now(),
        preferences: getPersistedEnginePreferences(session),
      });
      const code = error instanceof EngineRegistryError ? error.code : 'TASK_START_FAILED';
      recordRuntimeEngineError(runtime, code);
      failRuntime(runtime, getErrorMessage(error, '启动任务失败'), code);
    },
  });
  return turnScheduler = new ProviderTurnScheduler({
    repository,
    dispatcher,
    onResourceChanged: broadcastEngineConcurrency,
  });
}
export function drainEngineResource(resourceKey: string): Promise<void> { return getTurnScheduler().drain(resourceKey); }
export function getTurnQueueSnapshot(sessionId: string): TurnQueueSnapshotDto | null { return engineConcurrencyApi.getQueueSnapshot(sessionId); }
export function listEngineConcurrencySnapshots(actor: { id: string; role: 'admin' | 'member' }): EngineConcurrencyDto[] {
  return engineConcurrencyApi.listSnapshots(actor);
}
export function updateEngineConcurrency(resourceKey: string, maxActiveTurns: number, userId: string): EngineConcurrencyDto {
  return engineConcurrencyApi.update(resourceKey, maxActiveTurns, userId);
}
const configuredRecoveryInteractionTimeoutMs = Number(process.env.RELAY_RECOVERY_INTERACTION_TIMEOUT_MS || 15_000);
const RECOVERY_INTERACTION_TIMEOUT_MS = Number.isFinite(configuredRecoveryInteractionTimeoutMs)
  && configuredRecoveryInteractionTimeoutMs > 0
  ? configuredRecoveryInteractionTimeoutMs
  : 15_000;
export function registerEngineAdapter(adapter: EngineAdapter): void {
  engineRegistry.register(adapter);
}
export function listPendingApprovals(): PendingApprovalDto[] {
  return listPendingApprovalsFromRuntimes(runtimes.values());
}

export function getPendingApproval(sessionId: string, interactionId: string): PendingApprovalDto | null {
  return getPendingApprovalFromRuntimes(runtimes.values(), sessionId, interactionId);
}

function collectRuntimeChangedFiles(runtime: SessionRuntime, items: RuntimeTurnItem[] = runtime.turnItems) {
  const projectPath = runtime.projectId ? projectService.get(runtime.projectId)?.path : undefined;
  return collectChangedFiles(items, projectPath);
}

function collectRuntimeChangedFilesMetadata(runtime: SessionRuntime, items: RuntimeTurnItem[] = runtime.turnItems) {
  const projectPath = runtime.projectId ? projectService.get(runtime.projectId)?.path : undefined;
  const changedFiles = collectRuntimeChangedFiles(runtime, items);
  return {
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(hasIncompleteChangedFilesReport(items, projectPath) ? { changedFilesIncomplete: true as const } : {}),
  };
}

function setSessionStatus(sessionId: string, status: SessionStatus): void {
  broadcastSessionUpdate(presentRuntimeSession(sessionService.updateRuntimeStatus(sessionId, status), runtimes.get(sessionId)));
}

function withRuntimeTerminalFact(
  runtime: SessionRuntime,
  record: (context: {
    sessionId: string;
    attemptId: string;
    connectionId: string;
    engineId: SessionRuntime['engine'];
    userStopRequested: boolean;
  }) => void,
): void {
  if (!runtime.attemptId) return;
  try {
    record({
      sessionId: runtime.sessionId,
      attemptId: runtime.attemptId,
      connectionId: runtime.engineConnectionId || 'disconnected',
      engineId: runtime.engine,
      userStopRequested: runtime.isStopping,
    });
  } catch {
    // 合成事实仍遵循 shadow error policy，不能改变 legacy 终态路径。
  }
}

function recordRuntimeEngineError(runtime: SessionRuntime, code: string): void {
  withRuntimeTerminalFact(runtime, (context) => runtime.turnFactSink?.recordEngineError(context, code));
}

function recordRuntimeRecoveryFailed(runtime: SessionRuntime, code: string): void {
  withRuntimeTerminalFact(runtime, (context) => runtime.turnFactSink?.recordRecoveryFailed(context, code));
}

function recordRuntimeRecoveryInterrupted(runtime: SessionRuntime, code: string): void {
  withRuntimeTerminalFact(runtime, (context) => runtime.turnFactSink?.recordRecoveryInterrupted(context, code));
}

function clearRuntimeState(runtime: SessionRuntime): void {
  resetSessionRuntime(runtime, (interactionId) => {
    broadcastSessionResourceEvent(runtime.sessionId, {
      type: 'pending_approval_resolved',
      sessionId: runtime.sessionId,
      interactionId,
      resolvedAction: 'invalidated',
    });
  });
}

function disconnectRuntime(runtime: SessionRuntime): void | Promise<void> {
  const invalidated = clearPendingInteractionsForConnection(runtime, runtime.engineConnectionId);
  const closing=disconnectEngineConnection(runtime);
  for (const interactionId of invalidated) {
    broadcastSessionResourceEvent(runtime.sessionId, {
      type: 'pending_approval_resolved',
      sessionId: runtime.sessionId,
      interactionId,
      resolvedAction: 'invalidated',
    });
  }
  return closing;
}
function scheduleRuntimeCleanup(runtime: SessionRuntime): void {
  if (runtime.cleanupTimer) clearTimeout(runtime.cleanupTimer);
  if (shouldRetainSessionRuntime(runtime, getSessionSubscriberCount(runtime.sessionId))) return;

  runtime.cleanupTimer = setTimeout(() => {
    if (shouldRetainSessionRuntime(runtime, getSessionSubscriberCount(runtime.sessionId))) return;
    disconnectRuntime(runtime);
    runtimes.delete(runtime.sessionId);
  }, 5000);
}

function getOrCreateRuntime(sessionId: string): SessionRuntime {
  const existing = runtimes.get(sessionId);
  if (existing) {
    if (existing.cleanupTimer) {
      clearTimeout(existing.cleanupTimer);
      existing.cleanupTimer = null;
    }
    return existing;
  }

  const relaySession = sessionService.getRecord(sessionId);
  if (!relaySession) throw new Error('会话不存在');
  if (!relaySession.engine) throw new Error('会话尚未绑定 AI 引擎');

  const runtime = createSessionRuntimeState({
    sessionId,
    projectId: relaySession.project_id,
    engine: relaySession.engine,
    turnFactSink: engineTurnFactSink,
  });
  runtime.observeEngineEvent = (event) => {
    if (event.payload.type !== 'capacity_observation' || !runtime.resourceKey || !runtime.attemptId) return;
    void getTurnScheduler().onCapacityRetry(runtime.resourceKey, runtime.attemptId, event.payload.observation.type)
      .catch(() => undefined);
  };
  runtimes.set(sessionId, runtime);
  return runtime;
}

function removeSubscription(client: FrontendClient, sessionId: string): void {
  if (!removeClientSubscription(client, sessionId)) return;

  const runtime = runtimes.get(sessionId);
  if (runtime) scheduleRuntimeCleanup(runtime);
}

function authorizeClientSession(client: FrontendClient, sessionId: string): boolean {
  return authorizeFrontendClientSession(client, sessionId, (actor, id) => sessionService.requireForActor(actor, id));
}

function broadcastSessionResourceEvent(sessionId: string, event: FrontendEvent): void {
  const ownerUserId = sessionService.getRecord(sessionId)?.owner_user_id;
  if (ownerUserId) broadcastSessionResourceEventToClients(sessionId, ownerUserId, event);
}
function listPendingApprovalsForClient(client: FrontendClient): PendingApprovalDto[] { const approvals = listPendingApprovalsFromRuntimes(runtimes.values(), client.actor); return client.actor.role !== 'admin' || client.resourceScope === 'all' ? approvals : approvals.filter((approval) => client.activeSubscriptionSessionId === approval.sessionId); }
function subscribe(client: FrontendClient, sessionId: string, active = true, includeMessages = true): void {
  if (!authorizeClientSession(client, sessionId)) return;
  const relaySession = sessionService.getRecord(sessionId);
  if (!relaySession) {
    sendFrontendEvent(client.ws, {
      type: 'error',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      message: '会话不存在',
      code: 'SESSION_NOT_FOUND',
      sessionId,
    });
    return;
  }

  setClientSubscription(client, sessionId, active);

  const runtime = runtimes.get(sessionId);
  const queue = getTurnQueueSnapshot(sessionId);
  const current = sessionService.get(sessionId);
  if (current) sendFrontendEvent(client.ws, { type: 'session_updated', sessionId, snapshot: true, session: presentRuntimeSession(current, runtime) });
  sendFrontendEvent(client.ws, active && includeMessages
    ? buildRuntimeSyncState(sessionId, runtime, queue) : buildRuntimeOnlySyncState(sessionId, runtime, queue));
  if (relaySession.owner_user_id === client.userId) sendFrontendEvent(client.ws, { type: 'session_followup_snapshot',
    sessionId, followups: listSessionFollowups(getDB(), sessionId).map(presentSessionFollowup) });
  if (runtime?.modelInfo) {
    sendFrontendEvent(client.ws, { ...runtime.modelInfo, type: 'model_info', sessionId });
  }
  const currentTurnUsage = runtime?.isRunning ? runtime.latestTokenUsage : null;
  const tokenUsage = currentTurnUsage || sessionService.getTokenUsage(sessionId);
  if (tokenUsage) {
    sendFrontendEvent(client.ws, {
      type: 'token_usage',
      sessionId,
      usage: tokenUsage,
      ...(currentTurnUsage ? {
        currentTurn: true,
        ...(runtime?.tokenUsage ? { turnOutputUsage: runtime.tokenUsage } : {}),
      } : {}),
    });
  }
}

function broadcastRuntimeSyncState(runtime: SessionRuntime): void {
  broadcastFrontendEvent(buildRuntimeSyncState(runtime.sessionId, runtime, getTurnQueueSnapshot(runtime.sessionId)));
}


function projectEngineTerminal(
  runtime: SessionRuntime,
  snapshot: EngineTerminalProjectionSnapshot,
): EngineTerminalProjectionResult | null {
  if (!runtime.attemptId) return null;
  try {
    const db = getDB();
    const facts = listEngineTurnFactsInDatabase(db, runtime.sessionId, runtime.attemptId)
      .filter((fact) => fact.engineId === runtime.engine);
    const existing = getEngineTerminalDecisionInDatabase(
      db, runtime.sessionId, runtime.engine, runtime.attemptId,
    );
    const arbitration = arbitrateTerminalDecision(existing, facts);
    if (arbitration.kind === 'none') throw new Error('引擎终态缺少决定事实');
    if (arbitration.kind === 'conflict') throw new Error('引擎终态决定冲突');

    const decision: EngineTerminalDecision = arbitration.kind === 'unchanged'
      ? arbitration.decision
      : (() => {
          const decidingFact = facts.find((fact) => fact.id === arbitration.factId);
          return {
            id: uuid(),
            sessionId: runtime.sessionId,
            attemptId: runtime.attemptId!,
            engineId: runtime.engine,
            ...(decidingFact?.externalTurnId || runtime.currentTurnId
              ? { externalTurnId: decidingFact?.externalTurnId || runtime.currentTurnId || undefined }
              : {}),
            outcome: arbitration.outcome,
            reasonCode: arbitration.reasonCode,
            factId: arbitration.factId,
            decidedAt: Date.now(),
            projectedAt: null,
          };
        })();
    finishPerformanceObservation(runtime, decision.outcome === 'completed' ? 'completed' : decision.outcome === 'failed' ? 'failed' : 'interrupted');
    return engineTerminalProjection.project({
      decision,
      snapshot,
      sessionStatus: decision.outcome,
    });
  } catch {
    console.error(`[Relay] ENGINE_TERMINAL_PROJECTION_FAILED engine=${runtime.engine}`);
    broadcastFrontendEvent({
      type: 'error',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      sessionId: runtime.sessionId,
      message: `${getEngineDisplayName(runtime.engine)} 终态保存失败，请重启 Relay 后恢复任务状态`,
      code: 'ENGINE_TERMINAL_PROJECTION_FAILED',
    });
    clearRuntimeState(runtime);
    disconnectRuntime(runtime);
    scheduleRuntimeCleanup(runtime);
    return null;
  }
}

function broadcastProjectedTerminal(result: EngineTerminalProjectionResult, options: { deferResourceDrain?: boolean } = {}): void {
  publishEngineTerminalProjectionSafely(result, (projected) => {
    broadcastFrontendEvent({
      type: 'message_saved',
      sessionId: projected.decision.sessionId,
      messageRevision: projected.savedMessage.revision,
      message: presentMessage(projected.savedMessage.message),
    });
    broadcastSessionUpdate(sessionService.require(projected.decision.sessionId));
  });
  if (result.releasedResourceKey) {
    broadcastEngineConcurrency(result.releasedResourceKey);
    if (!options.deferResourceDrain) void getTurnScheduler().drain(result.releasedResourceKey);
  }
}

function presentRuntimeAssistantTerminal(runtime: SessionRuntime): {
  content: string;
  processContent?: string;
  processTimeline: ProcessTimelineEntry[];
} {
  const split = takeFinalAnswerFromTimeline(runtime.processTimeline, runtime.lastFinalAnswerItemId);
  if (runtime.lastFinalAnswerItemId) {
    return {
      content: split.finalContent || runtime.finalAnswerContent,
      processContent: split.processContent,
      processTimeline: split.processTimeline,
    };
  }
  const processContent = runtime.commentaryContent.trim() || undefined;
  return {
    content: runtime.finalAnswerContent || (processContent ? '' : runtime.currentContent),
    processContent,
    processTimeline: runtime.processTimeline,
  };
}
function saveAndBroadcastAssistant(
  runtime: SessionRuntime,
  codexMsg: Extract<EngineEvent, { type: 'message_complete' }>,
): boolean {
  const now=Date.now();
  const result = projectEngineTerminal(runtime, buildRuntimeAssistantSnapshot(runtime,codexMsg,{
    messageId:uuid(),fileChanges:collectRuntimeChangedFilesMetadata(runtime),now,
  }));
  if (!result) return false;
  broadcastProjectedTerminal(result);
  return true;
}
function failRuntime(runtime: SessionRuntime, message: string, code: string | undefined, options: { deferResourceDrain?: boolean } = {}): void {
  if (!runtime.isRunning && !runtime.isStopping) return;
  writeSessionTerminalLog({ sessionId: runtime.sessionId, engine: runtime.engine, model: runtime.turnModelSnapshot?.preferences.modelId || runtime.modelInfo?.model, outcome: code?.endsWith('_TURN_INTERRUPTED') ? 'interrupted' : 'failed', code, phase: getRuntimeExecutionStage(runtime), retryable: Boolean(code && /OVERLOADED|RATE_LIMIT|UNAVAILABLE|TIMEOUT|CONNECTION/i.test(code)), durationMs: runtime.turnStartTime ? Date.now() - runtime.turnStartTime : null, message });
  const duration = runtime.turnStartTime ? Date.now() - runtime.turnStartTime : null;
  const presented = presentRuntimeAssistantTerminal(runtime);
  const items = runtime.turnItems.filter((item) => VISIBLE_ITEM_TYPES.has(item.type));
  const turnId = runtime.currentTurnId || runtime.attemptId || uuid();
  const metadata = buildRuntimeMessageMetadata(runtime, {
    processContent: presented.processContent,
    processTimeline: presented.processTimeline,
    ...collectRuntimeChangedFilesMetadata(runtime),
    executionStage: getRuntimeExecutionStage(runtime),
    errorCode: code,
    errorMessage: message,
    tokenUsage: runtime.tokenUsage || undefined,
  });
  const projected = projectEngineTerminal(runtime, {
    messageId: uuid(), turnId, content: presented.content,
    items: items.length > 0 ? JSON.stringify(items) : null,
    metadata, duration,
  });
  if (!projected) return;
  try {
    publishEngineTerminalProjectionSafely(projected, () => {
      broadcastFrontendEvent({
        type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION,
        sessionId: runtime.sessionId, message, code,
      });
    });
    if (runtime.engine === 'codex' && code === 'CODEX_THREAD_ARCHIVED') {
      sessionService.markCodexArchived(runtime.sessionId, true);
    }
    broadcastProjectedTerminal(projected, options);
  } finally {
    clearRuntimeState(runtime);
    disconnectRuntime(runtime);
    scheduleRuntimeCleanup(runtime);
    void followups.get().onTerminal(runtime.sessionId, false);
  }
}

function finishRecoveredFailure(
  runtime: SessionRuntime,
  message: string,
  code: string | undefined,
): void {
  writeSessionTerminalLog({ sessionId: runtime.sessionId, engine: runtime.engine, model: runtime.turnModelSnapshot?.preferences.modelId || runtime.modelInfo?.model, outcome: code?.endsWith('_TURN_INTERRUPTED') ? 'interrupted' : 'failed', code, phase: getRuntimeExecutionStage(runtime), retryable: Boolean(code && /OVERLOADED|RATE_LIMIT|UNAVAILABLE|TIMEOUT|CONNECTION/i.test(code)), durationMs: runtime.turnStartTime ? Date.now() - runtime.turnStartTime : null, message });
  const turnId = runtime.currentTurnId || runtime.attemptId || uuid();
  const items = runtime.turnItems.filter((item) => VISIBLE_ITEM_TYPES.has(item.type));
  const presented = presentRuntimeAssistantTerminal(runtime);
  const metadata = buildRuntimeMessageMetadata(runtime, {
    processContent: presented.processContent,
    processTimeline: presented.processTimeline,
    ...collectRuntimeChangedFilesMetadata(runtime),
    executionStage: getRuntimeExecutionStage(runtime),
    errorCode: code,
    errorMessage: message,
    tokenUsage: runtime.tokenUsage || undefined,
  });
  const result = projectEngineTerminal(runtime, {
    messageId: uuid(), turnId, content: presented.content,
    items: items.length > 0 ? JSON.stringify(items) : null,
    metadata,
    duration: runtime.turnStartTime ? Date.now() - runtime.turnStartTime : null,
  });
  if (!result) return;
  broadcastProjectedTerminal(result);
  clearRuntimeState(runtime);
  scheduleRuntimeCleanup(runtime);
  void followups.get().onTerminal(runtime.sessionId, false);
}

function hydrateRecoveredRuntime(
  runtime: SessionRuntime,
  snapshot: Extract<EngineEvent, { type: 'recovery_snapshot' }>,
): void {
  runtime.currentTurnId = snapshot.turnId;
  runtime.requestForwarded = true;
  runtime.currentContent = [snapshot.processContent, snapshot.content].filter(Boolean).join('\n\n');
  runtime.commentaryContent = snapshot.processContent || '';
  runtime.finalAnswerContent = snapshot.content;
  runtime.lastFinalAnswerItemId = snapshot.finalAnswerItemId || null;
  const pendingInteractionItems = runtime.turnItems.filter((item) => runtime.pendingInteractions.has(item.id));
  runtime.turnItems = [...snapshot.items, ...pendingInteractionItems].reduce(
    (items, item) => upsertTurnItem(items, item),
    [] as RuntimeTurnItem[],
  );
  runtime.processTimeline = snapshot.processTimeline?.length
    ? snapshot.processTimeline
    : runtime.turnItems.reduce((timeline, item) => (
      VISIBLE_ITEM_TYPES.has(item.type) ? insertOperationReference(timeline, item.id) : timeline
    ), [] as ProcessTimelineEntry[]);
  if (snapshot.durationMs && !runtime.turnStartTime) runtime.turnStartTime = Date.now() - snapshot.durationMs;
  sessionService.setActiveTurn(runtime.sessionId, snapshot.turnId, runtime.turnStartTime);
}

function handleRecoverySnapshot(
  runtime: SessionRuntime,
  snapshot: Extract<EngineEvent, { type: 'recovery_snapshot' }>,
): void {
  hydrateRecoveredRuntime(runtime, snapshot);
  reconcileRecoveredConcurrency(getDB(), runtime, (resourceKey, attemptId) => (
    getTurnScheduler().onStartAccepted(resourceKey, attemptId)
  ));
  if (snapshot.status === 'inProgress') {
    runtime.isRecovering = false;
    setSessionStatus(runtime.sessionId, resolveRecoveryInProgressStatus(
      snapshot.waitingOnInteraction,
      runtime.pendingInteractions.size,
    ));
    if (snapshot.waitingOnInteraction && runtime.pendingInteractions.size === 0) {
      runtime.recoveryInteractionTimer = setTimeout(() => {
        runtime.recoveryInteractionTimer = null;
        if (!runtime.isRunning || runtime.pendingInteractions.size > 0) return;
        recordRuntimeRecoveryFailed(runtime, 'RESTART_RECOVERY_INTERACTION_MISSING');
        failRuntime(
          runtime,
          `Relay 已恢复 ${getEngineDisplayName(runtime.engine)} 回合，但未能重新取得等待中的操作请求`,
          'RESTART_RECOVERY_INTERACTION_MISSING',
        );
      }, RECOVERY_INTERACTION_TIMEOUT_MS);
      runtime.recoveryInteractionTimer.unref?.();
    }
    broadcastRuntimeSyncState(runtime);
    const shouldInterrupt = runtime.recoveryPreviousStatus === 'stopping';
    runtime.recoveryPreviousStatus = null;
    if (shouldInterrupt) void interruptRuntime(runtime, { preserveOnFailure: true });
    return;
  }
  if (snapshot.status === 'completed') {
    if (!snapshot.content.trim()) {
      finishRecoveredFailure(runtime, '未生成最终回复', 'FINAL_ANSWER_MISSING');
      return;
    }
    if (!saveAndBroadcastAssistant(runtime, {
      type: 'message_complete',
      turnId: snapshot.turnId,
      content: snapshot.content,
      ...(snapshot.processContent ? { processContent: snapshot.processContent } : {}),
      ...(snapshot.finalAnswerItemId ? { finalAnswerItemId: snapshot.finalAnswerItemId } : {}),
    })) return;
    clearRuntimeState(runtime);
    scheduleRuntimeCleanup(runtime);
    void followups.get().onTerminal(runtime.sessionId, true);
    return;
  }
  const errorPrefix = getEngineErrorPrefix(runtime.engine);
  const engineName = getEngineDisplayName(runtime.engine);
  const failure = snapshot.error || {
    message: snapshot.status === 'interrupted' ? `${engineName} 回合已中断` : `${engineName} 回合执行失败`,
    code: snapshot.status === 'interrupted' ? `${errorPrefix}_TURN_INTERRUPTED` : `${errorPrefix}_TURN_FAILED`,
  };
  finishRecoveredFailure(runtime, failure.message, failure.code);
}

function ensureEngineConnection(runtime: SessionRuntime): void {
  if (runtime.engineConnection) return;

  const relaySession = sessionService.getRecord(runtime.sessionId);
  if (!relaySession) throw new Error('会话不存在');
  if (!relaySession.engine) throw new Error('会话尚未绑定 AI 引擎');

  const project = runtime.projectId ? projectService.get(runtime.projectId) : undefined;
  const connectionId = uuid();
  runtime.engineConnectionId = connectionId;
  ensureConnectionPerformanceObservation(runtime, relaySession.engine, Boolean(relaySession.engine_session_id));

  const connection = engineRegistry.connect(relaySession.engine, {
    sessionId: runtime.sessionId,
    cwd: project?.path,
    externalSessionId: relaySession.engine_session_id,
    hostContext: createSessionHostContextDelivery(getDB(), runtime.sessionId, relaySession.engine, relaySession.engine_session_id),
    ...(runtime.turnModelSnapshot ? { initialTurnOptions: { preferences: resolveTurnStartPreferences(runtime) } } : {}),
    onSessionReady: observeSessionReady(runtime, (externalSessionId) => sessionService.setEngineSessionId(runtime.sessionId, externalSessionId)),
    onPerformanceMilestone: (milestone) => markPerformanceMilestone(runtime, milestone),
    onEvent: (envelope) => {
      // Discard queued socket callbacks belonging to a retired runtime.
      if (runtimes.get(runtime.sessionId) !== runtime) { disconnectEngineConnection(runtime); return; }
      routeEngineEvent(runtime, connectionId, envelope, ({ payload: codexMsg }) => {
    if (codexMsg.type === 'model_info') {
      runtime.modelInfo = codexMsg;
      updateTurnModelSnapshot(runtime, codexMsg);
    }

    if (codexMsg.type === 'request_forwarded') {
      broadcastFrontendEvent({ type: 'request_forwarded', sessionId: runtime.sessionId });
      runtime.requestForwarded = true;
    } else if (codexMsg.type === 'turn_start') {
      if (runtime.attemptId) {
        const db = getDB();
        const started = markLeaseRunningInDatabase(db, runtime.attemptId, Date.now());
        if (started) {
          db.saveToFile();
          if (runtime.resourceKey) void getTurnScheduler().onStartAccepted(runtime.resourceKey, runtime.attemptId).catch(() => undefined);
        }
      }
      broadcastFrontendEvent({ type: 'turn_start', sessionId: runtime.sessionId, turnId: codexMsg.turnId });
      runtime.currentTurnId = codexMsg.turnId;
      sessionService.setActiveTurn(runtime.sessionId, codexMsg.turnId, runtime.turnStartTime);
      setSessionStatus(runtime.sessionId, resolveInteractionSessionStatus(runtime));
    } else if (codexMsg.type === 'delta') {
      broadcastFrontendEvent({
        type: 'delta',
        sessionId: runtime.sessionId,
        itemId: codexMsg.itemId,
        content: codexMsg.content,
        ...(codexMsg.phase ? { phase: codexMsg.phase } : {}),
      });
      runtime.currentContent += codexMsg.content;
      if (codexMsg.phase === 'commentary' || codexMsg.phase === 'final_answer') {
        const itemId = codexMsg.itemId || codexMsg.phase;
        runtime.processTimeline = appendNarrativeDelta(
          runtime.processTimeline,
          itemId,
          codexMsg.content,
        );
        if (codexMsg.phase === 'final_answer') runtime.lastFinalAnswerItemId = itemId;
      }
      if (codexMsg.phase === 'commentary') runtime.commentaryContent += codexMsg.content;
      if (codexMsg.phase === 'final_answer') runtime.finalAnswerContent += codexMsg.content;
    } else if (codexMsg.type === 'item_start' && codexMsg.item) {
      runtime.turnItems = upsertTurnItem(runtime.turnItems, codexMsg.item);
      if (VISIBLE_ITEM_TYPES.has(codexMsg.item.type) && codexMsg.item.id) {
        runtime.processTimeline = insertOperationReference(runtime.processTimeline, codexMsg.item.id);
      }
      const item = presentProcessItem(codexMsg.item, 'in_progress');
      if (item) broadcastFrontendEvent({ type: 'item_start', sessionId: runtime.sessionId, item });
    } else if (codexMsg.type === 'item_complete' && codexMsg.item) {
      persistContextCompactionItemSafely(runtime.sessionId, codexMsg, sessionService.incrementContextCompactionCount);
      runtime.turnItems = upsertTurnItem(runtime.turnItems, codexMsg.item);
      appendAsyncQuestionItem(runtime, codexMsg.item);
      if (VISIBLE_ITEM_TYPES.has(codexMsg.item.type) && codexMsg.item.id) {
        runtime.processTimeline = insertOperationReference(runtime.processTimeline, codexMsg.item.id);
      }
      const item = presentProcessItem(codexMsg.item, 'completed');
      if (item) broadcastFrontendEvent({ type: 'item_complete', sessionId: runtime.sessionId, item });
    } else if (codexMsg.type === 'server_request') {
      if (runtime.recoveryInteractionTimer) {
        clearTimeout(runtime.recoveryInteractionTimer);
        runtime.recoveryInteractionTimer = null;
      }
      const request = { requestId: codexMsg.requestId, method: codexMsg.method, params: codexMsg.params };
      const routed = routeIncomingApproval({
        runtime,
        adapter: engineRegistry.get(runtime.engine).interactions,
        request,
        resolveTrust: resolveApprovalTrust,
        resolveSessionOwnerUserId: (sessionId) => sessionService.getRecord(sessionId)?.owner_user_id ?? null,
      });
      if (routed.outcome !== 'manual' && routed.outcome !== 'accepted') return;
      const { item } = routed;
      if (routed.outcome === 'accepted') {
        const presented = presentProcessItem(item, 'completed');
        if (presented) broadcastFrontendEvent({ type: 'item_complete', sessionId: runtime.sessionId, item: presented });
        if (routed.standalone) finishStandaloneInteraction(runtime, item);
        else setSessionStatus(runtime.sessionId, resolveInteractionSessionStatus(runtime));
        return;
      }
      const presented = presentProcessItem(item, 'in_progress');
      if (presented) broadcastFrontendEvent({ type: 'item_start', sessionId: runtime.sessionId, item: presented });
      const approval = getPendingApproval(runtime.sessionId, item.id);
      if (approval) broadcastSessionResourceEvent(runtime.sessionId, { type: 'pending_approval_upserted', approval });
      setSessionStatus(runtime.sessionId, resolveInteractionSessionStatus(runtime));
    } else if (codexMsg.type === 'server_request_resolved') {
      const interactionId = createScopedInteractionId(runtime.engineConnectionId ?? 'no-connection', codexMsg.requestId);
      const existing = runtime.turnItems.find((item) => item.id === interactionId);
      if (existing && runtime.pendingInteractions.has(interactionId)) {
        const pending = runtime.pendingInteractions.get(interactionId)!;
        const completed = completeRuntimeInteraction(runtime, interactionId, {
          resolvedAction: 'resolved_elsewhere', source: 'resolved_elsewhere', decidedAt: Date.now(),
        });
        if (!completed) return;
        runtime.pendingInteractions.delete(interactionId);
        broadcastSessionResourceEvent(runtime.sessionId, {
          type: 'pending_approval_resolved',
          sessionId: runtime.sessionId,
          interactionId,
          resolvedAction: 'resolved_elsewhere',
        });
        runtime.turnItems = upsertTurnItem(runtime.turnItems, completed);
        const presented = presentProcessItem(completed, 'completed');
        if (presented) broadcastFrontendEvent({ type: 'item_complete', sessionId: runtime.sessionId, item: presented });
        if (pending.standalone) finishStandaloneInteraction(runtime, completed);
        else setSessionStatus(runtime.sessionId, resolveInteractionSessionStatus(runtime));
      }
    } else if (codexMsg.type === 'system_notice') {
      if (codexMsg.noticeType === 'context_compaction') persistContextCompactionCountSafely(runtime.sessionId, codexMsg.contextCompaction || {}, sessionService.incrementContextCompactionCount);
      if (codexMsg.noticeType === 'model_rerouted' && typeof codexMsg.details?.toModel === 'string') {
        runtime.modelInfo = {
          type: 'model_info',
          model: codexMsg.details.toModel,
          ...(runtime.modelInfo?.platformOs ? { platformOs: runtime.modelInfo.platformOs } : {}),
          ...(runtime.modelInfo?.modelProvider ? { modelProvider: runtime.modelInfo.modelProvider } : {}),
          ...(runtime.modelInfo?.reasoningEffort ? { reasoningEffort: runtime.modelInfo.reasoningEffort } : {}),
        };
        broadcastFrontendEvent({ ...runtime.modelInfo, sessionId: runtime.sessionId });
      }
      const notice: RuntimeTurnItem = {
        id: `notice:${uuid()}`,
        type: 'systemNotice',
        status: 'completed',
        details: {
          noticeType: codexMsg.noticeType,
          title: codexMsg.title,
          message: codexMsg.message,
          ...codexMsg.details,
        },
      };
      runtime.turnItems = upsertTurnItem(runtime.turnItems, notice);
      runtime.processTimeline = insertOperationReference(runtime.processTimeline, notice.id);
      const presented = presentProcessItem(notice, 'completed');
      if (presented) broadcastFrontendEvent({ type: 'item_complete', sessionId: runtime.sessionId, item: presented });
      if (!runtime.isRunning) saveAndBroadcastStandaloneItem(runtime, [notice]);
    } else if (codexMsg.type === 'message_complete') {
      broadcastFrontendEvent({
        type: 'message_complete',
        sessionId: runtime.sessionId,
        turnId: codexMsg.turnId,
        content: codexMsg.content,
        ...(codexMsg.processContent ? { processContent: codexMsg.processContent } : {}),
        ...(codexMsg.usage !== undefined ? { usage: presentUsage(codexMsg.usage) } : {}),
      });
      if (!saveAndBroadcastAssistant(runtime, codexMsg)) return;
      clearRuntimeState(runtime);
      scheduleRuntimeCleanup(runtime);
      void followups.get().onTerminal(runtime.sessionId, true);
    } else if (codexMsg.type === 'error') {
      const { code, userMessage, originalMessage } = codexMsg.diagnostic;
      const capacity = getTerminalCapacityFailure(codexMsg.diagnostic);
      const resourceKey = runtime.resourceKey;
      const attemptId = runtime.attemptId;
      const wasActive = runtime.isRunning || runtime.isStopping;
      if (shouldFinalizeAsUserCancelled(runtime.interactionCancelRequested, code)) {
        finalizeInterruptedRuntime(runtime, { message: originalMessage || userMessage, code });
      } else {
        failRuntime(runtime, originalMessage || userMessage, code, { deferResourceDrain: Boolean(capacity) });
      }
      if (wasActive && capacity && resourceKey && attemptId) {
        void getTurnScheduler().onProviderOverload(resourceKey, attemptId, capacity.retryAfterMs)
          .catch(() => getTurnScheduler().drain(resourceKey));
      }
    } else if (codexMsg.type === 'turn_complete') {
      broadcastFrontendEvent({ type: 'turn_complete', sessionId: runtime.sessionId, turnId: codexMsg.turnId });
    } else if (codexMsg.type === 'model_info') {
      broadcastFrontendEvent({
        type: 'model_info',
        sessionId: runtime.sessionId,
        model: codexMsg.model,
        ...(codexMsg.platformOs ? { platformOs: codexMsg.platformOs } : {}),
        ...(codexMsg.modelProvider ? { modelProvider: codexMsg.modelProvider } : {}),
        ...(codexMsg.reasoningEffort ? { reasoningEffort: codexMsg.reasoningEffort } : {}),
      });
    } else if (codexMsg.type === 'token_usage') {
      sessionService.setTokenUsage(runtime.sessionId, codexMsg.usage);
      if (runtime.isRunning) {
        runtime.tokenUsage = accumulateTurnOutputUsage(
          runtime.latestTokenUsage,
          runtime.tokenUsage,
          codexMsg.usage,
        );
        runtime.latestTokenUsage = codexMsg.usage;
        sessionService.setActiveTurnUsage(runtime.sessionId, runtime.tokenUsage);
      }
      broadcastFrontendEvent({
        type: 'token_usage',
        sessionId: runtime.sessionId,
        usage: codexMsg.usage,
        ...(runtime.isRunning ? {
          currentTurn: true,
          ...(runtime.tokenUsage ? { turnOutputUsage: runtime.tokenUsage } : {}),
        } : {}),
      });
    } else if (codexMsg.type === 'recovery_snapshot') {
      handleRecoverySnapshot(runtime, codexMsg);
    }
      });
    },
    onClosed: () => {
      if (runtime.engineConnectionId !== connectionId) return;
      runtime.engineConnectionId = null;
      runtime.engineConnection = null;
      if (runtime.isRunning) {
        if (!relaySession.engine) throw new Error('会话尚未绑定 AI 引擎');
        const engineName = getEngineDisplayName(relaySession.engine);
        const code = `${getEngineErrorPrefix(relaySession.engine)}_CONNECTION_CLOSED`;
        if (runtime.attemptId) {
          runtime.turnFactSink?.recordConnectionClosed({
            sessionId: runtime.sessionId,
            attemptId: runtime.attemptId,
            connectionId,
            engineId: runtime.engine,
            userStopRequested: runtime.isStopping,
          }, code);
        }
        failRuntime(runtime, `${engineName} 连接在任务完成前断开`, code);
      }
      scheduleRuntimeCleanup(runtime);
    },
    ...(runtime.isRecovering ? {
      recoverTurnId: runtime.currentTurnId,
      recoverStartedAt: runtime.turnStartTime,
    } : {}),
  });

  attachEngineConnection(runtime, connection, connectionId);
}

function saveAndBroadcastStandaloneItem(runtime: SessionRuntime, items: RuntimeTurnItem[]): void {
  const saved = sessionService.saveMessage({
    id: uuid(),
    session_id: runtime.sessionId,
    turn_id: uuid(),
    role: 'assistant',
    content: '',
    phase: 'interaction',
    items: JSON.stringify(items),
    metadata: serializeMessageMetadata({
      processTimeline: items.reduce(
        (timeline, item) => insertOperationReference(timeline, item.id),
        [] as ProcessTimelineEntry[],
      ),
      ...collectRuntimeChangedFilesMetadata(runtime, items),
      executionStage: 'responding',
    }),
    duration: runtime.turnStartTime ? Date.now() - runtime.turnStartTime : 0,
    stopped: 0,
  });
  broadcastFrontendEvent({
    type: 'message_saved',
    sessionId: runtime.sessionId,
    messageRevision: saved.revision,
    message: presentMessage(saved.message),
  });
}

/** 独立授权卡片合并采用活动空闲窗：每张卡到达都重置计时，安静 STANDALONE_INTERACTION_IDLE_MS
 * 才落库。引擎在 turn.completed 后仍会以 3~45 秒不等的间隔继续发授权（实测），固定短窗拦不住，
 * 固定长窗会拖慢落库并长时间持有运行时；空闲窗自适应引擎节奏。新回合发送时强制落库，不阻塞用户。
 */
const STANDALONE_INTERACTION_IDLE_MS = 8_000;

function flushStandaloneInteractions(runtime: SessionRuntime): void {
  if (runtime.standaloneInteractionTimer) {
    clearTimeout(runtime.standaloneInteractionTimer);
    runtime.standaloneInteractionTimer = null;
  }
  if (runtime.pendingInteractions.size > 0) return;
  // A late timer must never reset an active turn or its buffered output.
  if (runtime.attemptId) return;
  const items = runtime.standaloneInteractionItems;
  runtime.standaloneInteractionItems = [];
  if (items.length === 0) return;
  saveAndBroadcastStandaloneItem(runtime, items);
  clearRuntimeState(runtime);
  setSessionStatus(runtime.sessionId, sessionService.getRecord(runtime.sessionId)?.last_result?.status ?? 'idle');
  scheduleRuntimeCleanup(runtime);
}

function finishStandaloneInteraction(runtime: SessionRuntime, item: RuntimeTurnItem): void {
  runtime.standaloneInteractionItems.push(item);
  setSessionStatus(runtime.sessionId, resolveInteractionSessionStatus(runtime));
  if (runtime.standaloneInteractionTimer) clearTimeout(runtime.standaloneInteractionTimer);
  runtime.standaloneInteractionTimer = setTimeout(() => {
    runtime.standaloneInteractionTimer = null;
    flushStandaloneInteractions(runtime);
  }, STANDALONE_INTERACTION_IDLE_MS);
}

function persistSendFailure(client: FrontendClient, input: RejectedSendInput): boolean {
  let savedMessages;
  try {
    const existingSession = sessionService.getRecord(input.sessionId);
    if (!existingSession || deletionState.getSessionBlock(input.sessionId, existingSession.project_id)) return false;
    const existingMessage = input.messageId
      ? sessionService.getMessageRecord(input.sessionId, input.messageId)
      : undefined;
    const existingUserMessage = existingMessage?.role === 'user' ? existingMessage : undefined;
    if (input.workspaceTaskId && !existingUserMessage) return false;
    savedMessages = sessionService.saveMessages(buildFailedSendMessages({
      ...input,
      origin: createMessageOriginForClient(client), clientDiagnostics: client.clientDiagnostics,
    }, existingUserMessage));
  } catch (error) {
    console.error('[Relay] Failed to persist rejected send:', error);
    return false;
  }
  try {
    for (const saved of savedMessages) {
      broadcastFrontendEvent({
        type: 'message_saved',
        sessionId: input.sessionId,
        messageRevision: saved.revision,
        message: presentMessage(saved.message),
      }, client.ws);
    }
    const relaySession = sessionService.getRecord(input.sessionId);
    if (relaySession) {
      const titleCandidate = classifySessionTitleMessage(buildFailedSendUserContent(input.content, input.attachmentNames));
      if (shouldUpdateAutomaticSessionTitle(relaySession.title, titleCandidate.kind)) {
        updateAutomaticTitleBestEffort(() => {
          const updatedSession = sessionService.updateAutomaticTitle(input.sessionId, generateSessionTitle(titleCandidate.content));
          if (updatedSession) broadcastSessionUpdate(updatedSession);
        });
      }
    }
    if (input.code !== 'SESSION_BUSY') setSessionStatus(input.sessionId, 'failed');
  } catch (error) {
    console.error('[Relay] Failed to publish persisted rejected send:', error);
  }
  return true;
}
function rejectSend(client: FrontendClient, input: RejectedSendInput): void {
  if (persistSendFailure(client, input)) return;
  sendFrontendEvent(client.ws, {
    type: 'error',
    protocolVersion: RELAY_PROTOCOL_VERSION,
    sessionId: input.sessionId,
    messageId: input.messageId,
    message: input.message,
    code: input.code,
  });
}
async function handleSendCore(client: FrontendClient, message: SendCommand): Promise<boolean | undefined> {
  try { sessionService.requireUsableForActor(client.actor, message.sessionId); } catch (error) { rejectSend(client, { sessionId: message.sessionId, messageId: message.messageId, content: message.content, attachmentNames: message.attachments?.map((attachment) => attachment.name) || [], message: error instanceof Error ? error.message : '当前会话不可用', code: 'SESSION_USE_FORBIDDEN', workspaceTaskId: message.workspaceTaskId }); return; }
  const { sessionId, content, messageId } = message;
  if (!authorizeClientSession(client, sessionId)) return;
  // 新回合发送前先落掉空闲窗里等待的独立授权卡片，避免它们被后续回合的运行时状态吞掉。
  const pendingRuntime = runtimes.get(sessionId);
  if (pendingRuntime?.standaloneInteractionTimer) flushStandaloneInteractions(pendingRuntime);
  const origin = createMessageOriginForClient(client, message.client);
  let relaySession = sessionService.getRecord(sessionId);
  if (!relaySession) {
    sendFrontendEvent(client.ws, {
      type: 'error',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      message: '会话不存在',
      code: 'SESSION_NOT_FOUND',
      sessionId,
      messageId,
    });
    return;
  }

  const deletionBlock = deletionState.getSessionBlock(sessionId, relaySession.project_id);
  if (deletionBlock) {
    sendFrontendEvent(client.ws, {
      type: 'error',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      message: deletionBlock.message,
      code: deletionBlock.code,
      sessionId,
      messageId,
    });
    return;
  }

  if (!relaySession.engine && !message.engine) {
    rejectSend(client, {
      sessionId, messageId, content, attachmentNames: message.attachments?.map((attachment) => attachment.name) || [], workspaceTaskId: message.workspaceTaskId,
      message: '请选择一个可用的 AI 引擎', code: 'ENGINE_REQUIRED',
    });
    return;
  }
  if (relaySession.engine && message.engine && message.engine !== relaySession.engine) {
    rejectSend(client, {
      sessionId, messageId, content, attachmentNames: message.attachments?.map((attachment) => attachment.name) || [], workspaceTaskId: message.workspaceTaskId,
      message: '当前会话已绑定其他 AI 引擎', code: 'ENGINE_ALREADY_BOUND',
    });
    return;
  }
  const targetEngine = relaySession.engine || message.engine!;
  if (!validateAsyncQuestionSend(client, message, targetEngine, runtimes.get(sessionId)?.turnItems || [])) return;
  const turnPreferences = resolveSendEnginePreferences(relaySession, message);
  if (!content.trim() && !message.attachments?.length) {
    sendFrontendEvent(client.ws, {
      type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId,
      messageId, message: '请输入消息或选择附件', code: 'EMPTY_MESSAGE',
    });
    return;
  }
  const projectId = relaySession.project_id;
  const project = projectId ? projectService.get(projectId) : undefined;
  if (!projectId || !project) {
    rejectSend(client, {
      sessionId, messageId, content, attachmentNames: message.attachments?.map((attachment) => attachment.name) || [], workspaceTaskId: message.workspaceTaskId,
      message: '会话所属项目不存在', code: 'PROJECT_NOT_FOUND',
    });
    return;
  }
  if (runtimes.get(sessionId)?.isRunning || getTurnQueueSnapshot(sessionId) || hasBlockingSessionFollowups(sessionId)) {
    await followups.submit(client, message);
    return true;
  }
  const workspaceTaskLink = await prepareWorkspaceTaskLink(client, message);
  if (workspaceTaskLink === null) return;
  try {
    await validateSendEnginePreferences(targetEngine, turnPreferences, !relaySession.engine);
  } catch (error) {
    sendFrontendEvent(client.ws, {
      type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId, messageId,
      message: error instanceof Error ? error.message : '模型配置暂时不可用',
      code: error instanceof EnginePreferencesValidationError
        ? error.code
        : 'ENGINE_MODEL_CATALOG_UNAVAILABLE',
    });
    return;
  }
  let preparedAttachments;
  try {
    preparedAttachments = prepareMessageAttachments({
      attachments: message.attachments,
      projectId,
      projectPath: project.path,
      userId: client.userId,
      messageId: messageId || '',
    });
  } catch (error: unknown) {
    rejectSend(client, {
      sessionId, messageId, content, attachmentNames: message.attachments?.map((attachment) => attachment.name) || [], workspaceTaskId: message.workspaceTaskId,
      message: error instanceof Error ? error.message : '附件验证失败', code: 'ATTACHMENT_INVALID',
    });
    return;
  }
  const attachments = preparedAttachments.attachments;
  const userContent = content.trim();
  const attemptId = uuid();

  const runtime = runtimes.get(sessionId);
  if (runtime?.isRunning || getTurnQueueSnapshot(sessionId) || hasBlockingSessionFollowups(sessionId)) {
    try { preparedAttachments.rollback(); } catch { /* 忙碌错误优先。 */ }
    await followups.submit(client, message);
    return true;
  }

  let admission;
  try {
    const adapter = engineRegistry.get(targetEngine);
    const resource = adapter.concurrency?.resolveResource({ sessionId, projectId });
    if (!resource) throw new Error('当前引擎未配置并发资源');
    admission = getTurnAdmissionService().enqueue({
      sessionId,
      engineId: targetEngine,
      requestedByUserId: client.userId,
      attemptId,
      resource, bindEngine: !relaySession.engine,
      ...(relaySession.engine ? { enginePreferencesRevision: turnPreferences.expectedRevision } : {}),
      ...(!relaySession.engine ? { enginePreferences: turnPreferences } : {}), ...(workspaceTaskLink ? { workspaceTaskLink } : {}),
      message: {
      id: messageId || uuid(),
      session_id: sessionId,
      turn_id: attemptId,
      role: 'user',
      content: userContent,
      phase: null,
      items: null,
      metadata: serializeMessageMetadata({ attachments, origin, clientDiagnostics: message.clientDiagnostics, replyToAsyncQuestionId: message.replyToAsyncQuestionId }),
      duration: null,
      stopped: 0,
      },
    });
  } catch (error) {
    let rollbackFailed = false;
    try { preparedAttachments.rollback(); } catch { rollbackFailed = true; }
    sendFrontendEvent(client.ws, {
      type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId,
      messageId,
      message: rollbackFailed
        ? '消息保存失败，且附件回滚未完成，请在项目上传文件中检查'
        : error instanceof TurnAdmissionError ? error.message : '消息保存失败，请重试',
      code: rollbackFailed
        ? 'UPLOAD_ROLLBACK_FAILED'
        : error instanceof TurnAdmissionError ? error.code : 'MESSAGE_SAVE_FAILED',
    });
    return;
  }
  broadcastFrontendEvent({
    type: 'message_saved',
    sessionId,
    messageRevision: admission.savedMessage.revision,
    message: presentMessage(admission.savedMessage.message),
  }, client.ws);
  broadcastSessionUpdate(sessionService.require(sessionId));
  broadcastFrontendEvent({ type: 'turn_queue_updated', sessionId, queue: getTurnQueueSnapshot(sessionId) });
  // 自动标题更新必须发生在 pending 状态落库之后，避免广播旧 idle 状态让客户端误收敛运行气泡。
  const titleSource = userContent || (attachments[0] ? `查看文件 ${attachments[0].name}` : '');
  const titleCandidate = classifySessionTitleMessage(titleSource);
  if (shouldUpdateAutomaticSessionTitle(relaySession.title, titleCandidate.kind)) {
    const title = generateSessionTitle(titleCandidate.content);
    updateAutomaticTitleBestEffort(() => {
      const updatedSession = sessionService.updateAutomaticTitle(sessionId, title);
      if (updatedSession) broadcastSessionUpdate(updatedSession);
    });
  }
  subscribe(client, sessionId);
  void getTurnScheduler().drain(admission.queue.resourceKey);
  return true;
}
async function handleSend(client: FrontendClient, message: SendCommand): Promise<void> {
  await auditSessionAdminAction(client.actor, sessionService.getRecord(message.sessionId), 'session.send', () => handleSendCore(client, message));
}
function sendInteractionResponseResult(
  client: FrontendClient,
  message: RespondInteractionCommand,
  outcome: 'accepted' | 'skipped' | 'failed',
  resultMessage?: string,
): void {
  sendFrontendEvent(client.ws, {
    type: 'interaction_response_result',
    operationId: message.operationId,
    sessionId: message.sessionId,
    interactionId: message.interactionId,
    outcome,
    ...(resultMessage ? { message: resultMessage } : {}),
  });
}
function handleInteractionResponseCore(client: FrontendClient, message: RespondInteractionCommand): boolean {
  if (!authorizeClientSession(client, message.sessionId)) return false;
  // 授权操作仅限会话所有人：有查看权限的项目成员只能旁观授权卡片，不能代为处理
  const ownerUserId = sessionService.getRecord(message.sessionId)?.owner_user_id;
  if (!client.actor || !canManageOwnedResource(client.actor, ownerUserId)) {
    sendInteractionResponseResult(client, message, 'skipped', '只有会话所有人可以处理此授权');
    return false;
  }
  const runtime = runtimes.get(message.sessionId);
  const pending = runtime?.pendingInteractions.get(message.interactionId);
  if (!runtime || !pending || !runtime.engineConnection) {
    sendInteractionResponseResult(client, message, 'skipped', '该操作请求已失效或已在其他设备处理');
    return false;
  }
  let result: unknown;
  try {
    const interactionAdapter = engineRegistry.get(runtime.engine).interactions;
    if (!interactionAdapter) throw new Error('当前引擎未提供交互响应能力');
    result = buildInteractionResponse(interactionAdapter, pending.request, message);
    runtime.engineConnection.respondToInteraction(pending.request.requestId, result);
  } catch (error: unknown) {
    sendInteractionResponseResult(client, message, 'failed', getErrorMessage(error, '处理授权响应失败'));
    return false;
  }
  if (!pending.standalone && isTurnCancellingInteractionResponse(pending.request.method, result)) {
    runtime.interactionCancelRequested = true;
  }
  runtime.pendingInteractions.delete(message.interactionId);
  const approvalResolution = getPendingApprovalResolution(pending.request.method, message.action);
  const existing = runtime.turnItems.find((item) => item.id === message.interactionId);
  if (existing) {
    const completed = completeRuntimeInteraction(runtime, message.interactionId, {
      resolvedAction: message.action, source: 'user', decidedAt: Date.now(),
      decidedByDeviceId: client.deviceId ?? null,
      decidedByDeviceType: client.clientEnvironment?.deviceType ?? null,
    });
    if (!completed) return false;
    const item = presentProcessItem(completed, 'completed');
    if (item) broadcastFrontendEvent({ type: 'item_complete', sessionId: runtime.sessionId, item });
    if (pending.standalone) finishStandaloneInteraction(runtime, completed);
    else setSessionStatus(runtime.sessionId, resolveInteractionSessionStatus(runtime));
  }
  sendInteractionResponseResult(client, message, 'accepted');
  if (approvalResolution) {
    broadcastSessionResourceEvent(runtime.sessionId, {
      type: 'pending_approval_resolved',
      sessionId: runtime.sessionId,
      interactionId: message.interactionId,
      resolvedAction: approvalResolution,
    });
  }
  return true;
}

function handleInteractionResponse(client: FrontendClient, message: RespondInteractionCommand): void {
  auditSessionAdminActionSync(client.actor, sessionService.getRecord(message.sessionId), 'session.approval_decide', () => handleInteractionResponseCore(client, message));
}
function finalizeInterruptedRuntime(
  runtime: SessionRuntime,
  originalError?: { message: string; code?: string },
): void {
  const sessionId = runtime.sessionId;
  if (runtime.attemptId) {
    runtime.turnFactSink?.recordInterruptConfirmed({
      sessionId,
      attemptId: runtime.attemptId,
      connectionId: runtime.engineConnectionId || 'disconnected',
      engineId: runtime.engine,
      userStopRequested: true,
    });
  }
  const duration = runtime.turnStartTime ? Date.now() - runtime.turnStartTime : null;
  const presented = presentRuntimeAssistantTerminal(runtime);
  const items = runtime.turnItems.filter((item) => VISIBLE_ITEM_TYPES.has(item.type));
  const turnId = runtime.currentTurnId || runtime.attemptId || uuid();
  const metadata = buildRuntimeMessageMetadata(runtime, {
    processContent: presented.processContent,
    processTimeline: presented.processTimeline,
    ...collectRuntimeChangedFilesMetadata(runtime),
    executionStage: getRuntimeExecutionStage(runtime),
    ...(originalError ? { errorCode: originalError.code, errorMessage: originalError.message } : {}),
    tokenUsage: runtime.tokenUsage || undefined,
  });
  const result = projectEngineTerminal(runtime, {
    messageId: uuid(), turnId, content: presented.content,
    items: items.length > 0 ? JSON.stringify(items) : null,
    metadata, duration,
  });
  if (!result) {
    broadcastFrontendEvent({ type: 'turn_cancelled', sessionId });
    return;
  }
  broadcastProjectedTerminal(result);

  clearRuntimeState(runtime);
  broadcastFrontendEvent({ type: 'turn_cancelled', sessionId });
  scheduleRuntimeCleanup(runtime);
  void followups.get().onTerminal(sessionId, false);
}

function interruptRuntime(runtime: SessionRuntime, options: { preserveOnFailure?: boolean } = {}): Promise<void> {
  const previousStatus = sessionService.getRecord(runtime.sessionId)?.status || 'processing';
  return requestRuntimeInterrupt(runtime, {
    onStarting: () => {
      setSessionStatus(runtime.sessionId, 'stopping');
      broadcastFrontendEvent({ type: 'turn_cancelling', sessionId: runtime.sessionId });
    },
    onStopped: () => finalizeInterruptedRuntime(runtime),
    onFailed: (error) => {
      const engineName = getEngineDisplayName(runtime.engine);
      const unavailable = error.message === '引擎连接尚未就绪';
      const message = unavailable
        ? `停止任务失败：${engineName} 连接尚未就绪`
        : `停止任务失败：${getErrorMessage(error, `${engineName} 未确认中断`)}`;
      const codePrefix = getEngineErrorPrefix(runtime.engine);
      const code = unavailable ? `${codePrefix}_INTERRUPT_UNAVAILABLE` : `${codePrefix}_INTERRUPT_FAILED`;
      if (options.preserveOnFailure) {
        setSessionStatus(runtime.sessionId, resolveInterruptFailureStatus(
          previousStatus,
          runtime.requestForwarded,
          runtime.pendingInteractions.size,
        ));
        broadcastFrontendEvent({
          type: 'error',
          protocolVersion: RELAY_PROTOCOL_VERSION,
          sessionId: runtime.sessionId,
          message,
          code,
        });
        return;
      }
      recordRuntimeEngineError(runtime, code);
      failRuntime(
        runtime,
        message,
        code,
      );
    },
  });
}

export function cancelQueuedTurnForUser(
  sessionId: string,
  user: { id: string; role: 'admin' | 'member' },
): boolean {
  const queue = getQueueEntryBySessionInDatabase(getDB(), sessionId);
  if (!queue || queue.state !== 'queued') return false;
  if (user.role !== 'admin' && queue.requestedByUserId !== user.id) throw new Error('无权取消该排队回合');
  const cancelled = getTurnAdmissionService().cancelQueued(sessionId);
  if (!cancelled) return false;
    broadcastFrontendEvent({
      type: 'message_saved', sessionId,
      messageRevision: cancelled.savedMessage.revision,
      message: presentMessage(cancelled.savedMessage.message),
    });
    broadcastSessionUpdate(sessionService.require(sessionId));
    broadcastFrontendEvent({ type: 'turn_queue_updated', sessionId, queue: null });
    broadcastFrontendEvent({ type: 'turn_cancelled', sessionId });
    void followups.get().onTerminal(sessionId, false);
    void getTurnScheduler().drain(cancelled.resourceKey);
  return true;
}

function handleCancel(client: FrontendClient, requestedSessionId?: string): void {
  const sessionId = requestedSessionId || client.activeSubscriptionSessionId;
  if (!sessionId) return;
  if (!authorizeClientSession(client, sessionId)) return;
  const audit = beginSessionAdminAudit(client.actor, sessionService.getRecord(sessionId), 'session.stop');
  const runtime = runtimes.get(sessionId);
  if (!runtime?.isRunning) {
    try {
      const cancelled = cancelQueuedTurnForUser(sessionId, { id: client.actor.userId, role: client.actor.role });
      audit.finish(cancelled ? 'succeeded' : 'failed');
    } catch { audit.finish('failed'); /* WS 取消保持静默。 */ }
    return;
  }
  void interruptRuntime(runtime).then(() => audit.finish('succeeded'), () => audit.finish('failed'));
}
export type RecoverableRuntimeSession = RecoverableSessionRecord;

export function recoverActiveEngineSessions(sessions: RecoverableRuntimeSession[]): void {
  for (const session of sessions) {
    const runtime = getOrCreateRuntime(session.id);
    runtime.isRunning = true;
    runtime.isRecovering = true;
    runtime.recoveryPreviousStatus = session.previousStatus;
    runtime.currentTurnId = session.turnId;
    runtime.attemptId = session.attemptId;
    runtime.resourceKey = session.resourceKey ?? null;
    runtime.leaseToken = session.leaseToken ?? null;
    runtime.requestedByUserId = session.requestedByUserId ?? null;
    runtime.turnStartTime = session.startedAt;
    runtime.requestForwarded = session.previousStatus !== 'pending';
    runtime.latestTokenUsage = session.latestTokenUsage || null;
    runtime.tokenUsage = session.tokenUsage || null;
    const persistedSession = sessionService.getRecord(session.id);
    runtime.turnModelSnapshot = { preferences: getPersistedEnginePreferences(persistedSession), displayNames: {}, modelDefaults: {}, defaultModelId: null, modelInfo: null };
    const adapter = engineRegistry.get(session.engine);
    if ((adapter.recovery?.restartMode ?? 'interrupt') === 'interrupt') {
      const code = `${adapter.id.toUpperCase()}_RESTART_INTERRUPTED`;
      recordRuntimeRecoveryInterrupted(runtime, code);
      finishRecoveredFailure(runtime, `Relay 重启中断了 ${adapter.descriptor.label} 任务，请重新发送消息继续`, code);
      continue;
    }
    if (!session.externalSessionId) {
      recordRuntimeRecoveryFailed(runtime, 'RESTART_RECOVERY_SESSION_MISSING');
      failRuntime(runtime, 'Relay 重启后无法恢复任务：会话尚未关联引擎会话', 'RESTART_RECOVERY_SESSION_MISSING');
      continue;
    }
    console.log(`[Relay] 正在恢复会话 ${session.id} 的 ${session.engine} 回合`);
    try {
      ensureEngineConnection(runtime);
    } catch (error) {
      recordRuntimeRecoveryFailed(runtime, 'RESTART_RECOVERY_FAILED');
      failRuntime(runtime, getErrorMessage(error, '恢复重启前任务失败'), 'RESTART_RECOVERY_FAILED');
    }
  }
  void startupDiagnostics.measureAsync('session-followup-recovery', () => followups.get().recoverSessionFollowups())
    .catch((error) => console.error('[Relay] 后续消息恢复失败:', error));
}
/** 删除会话前等待活动引擎回合进入可安全删除的终态。 */
export async function interruptEngineBySessionId(sessionId: string): Promise<void> {
  const runtime = runtimes.get(sessionId);
  if (!runtime?.isRunning) return;
  await interruptRuntime(runtime, { preserveOnFailure: true });
}

/** 关闭指定会话的引擎连接。 */
export function closeEngineBySessionId(sessionId: string): void | Promise<void> {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return;
  if (runtime.cleanupTimer) {
    clearTimeout(runtime.cleanupTimer);
    runtime.cleanupTimer = null;
  }
  const closing=disconnectRuntime(runtime);
  clearRuntimeState(runtime);
  runtimes.delete(sessionId);
  return closing;
}

/** 关闭指定项目下所有会话的引擎连接。 */
export function closeEngineByProjectId(projectId: string): void {
  for (const runtime of [...runtimes.values()]) {
    if (runtime.projectId === projectId) closeEngineBySessionId(runtime.sessionId);
  }
}

/** 关闭所有引擎连接（服务停止时调用）。 */
export function closeAllEngineConnections(): void {
  for (const runtime of [...runtimes.values()]) closeEngineBySessionId(runtime.sessionId);
}

export async function closeAllEngineConnectionsAndWait():Promise<void>{
  await Promise.all([...runtimes.values()].map(runtime=>closeEngineBySessionId(runtime.sessionId)));
}

export function setupWebSocket(wss: WebSocketServer,
  options: { isRecoveryInProgress?: () => boolean;
    admissionClosed?:()=>boolean;
    trackWork?:<T>(work:()=>Promise<T>)=>Promise<T>;
    getEngineMaintenanceBlock?: (engineId: SessionRuntime['engine']) => 'maintenance' | 'unavailable' | null;
    resolveApprovalTrust?: (ownerUserId: string, sessionId: string) => EffectiveApprovalTrust;
  } = {},
): void {
  resolveApprovalTrust = options.resolveApprovalTrust ?? resolveManualApprovalTrust;
  wss.on('connection', (ws: WSClient, request) => {
    if(options.admissionClosed?.()){ws.close(1012,'服务正在维护');return;}
    const authSession = authenticateCookieSession(request.headers.cookie);
    if (!authSession) {
      ws.close(1008, '请先登录');
      return;
    }
    if (authSession.user.mustChangePassword) {
      ws.close(1008, '首次登录必须先修改密码');
      return;
    }
    const connectionDiagnostics = createConnectionDiagnostics();
    const client: FrontendClient = {
      ws,
      actor: { userId: authSession.user.id, role: authSession.user.role },
      ...createFrontendOriginContext(authSession.user, request),
      authTokenHash: authSession.tokenHash,
      authExpiresAt: authSession.expiresAt,
      authExpiryTimer: null,
      activeSubscriptionSessionId: null, subscribedSessionIds: new Set(),
    };
    addFrontendClient(client);
    sendFrontendEvent(ws, { type: 'protocol_info', protocolVersion: RELAY_PROTOCOL_VERSION });
    sendFrontendEvent(ws, { type: 'session_reads', receipts: listSessionReadReceipts(getDB(), client.userId) });
    sendFrontendEvent(ws, { type: 'pending_approvals_snapshot', approvals: listPendingApprovalsForClient(client) });

    ws.on('message', (data: Buffer) => {
      if(options.admissionClosed?.()){ws.close(1012,'服务正在维护');return;}
      connectionDiagnostics.message();
      let message: ReturnType<typeof parseFrontendMessage> | null = null;
      try {
        if (!isClientAuthenticated(client)) return;
        message = parseFrontendMessage(JSON.parse(data.toString()));
        if (message.type === 'subscribe') {
          setClientContext(client, message.client, undefined);
          setClientDevice(client, message.deviceId);
          setClientResourceScope(client, message.resourceScope); subscribe(client, message.sessionId, message.active !== false, message.includeMessages !== false);
          sendFrontendEvent(ws, { type: 'pending_approvals_snapshot', approvals: listPendingApprovalsForClient(client) });
        } else if (message.type === 'mark_session_read') {
          handleSessionRead(client, message, authorizeClientSession, sessionService.getRecord);
        } else if (message.type === 'unsubscribe') { removeSubscription(client, message.sessionId); sendFrontendEvent(ws, { type: 'pending_approvals_snapshot', approvals: listPendingApprovalsForClient(client) }); }
        else if (message.type === 'send') {
          const sendMessage = message;
          setClientContext(client, sendMessage.client, sendMessage.clientDiagnostics);
          const sessionRecord = sessionService.getRecord(sendMessage.sessionId);
          const sessionEngine = sessionRecord?.engine ?? sendMessage.engine ?? null;
          const recoveryError = getServiceRecoverySendError(options.isRecoveryInProgress?.() === true)
            ?? getEngineMaintenanceSendError(sessionEngine ? options.getEngineMaintenanceBlock?.(sessionEngine) ?? null : null, sessionEngine);
          if (recoveryError) {
            rejectSend(client, {
              sessionId: sendMessage.sessionId,
              messageId: sendMessage.messageId,
              content: sendMessage.content,
              attachmentNames: sendMessage.attachments?.map((attachment) => attachment.name) || [],
              workspaceTaskId: sendMessage.workspaceTaskId,
              ...recoveryError,
            });
          } else {
            const sendOperation = () => handleSend(client, sendMessage);
            void (options.trackWork ? options.trackWork(sendOperation) : sendOperation()).catch((error: unknown) => {
              console.error('[Relay] Failed to send frontend message:', error);
              if (ws.readyState === WSClient.OPEN) {
                rejectSend(client, {
                  sessionId: sendMessage.sessionId,
                  messageId: sendMessage.messageId,
                  content: sendMessage.content,
                  attachmentNames: sendMessage.attachments?.map((attachment) => attachment.name) || [],
                  workspaceTaskId: sendMessage.workspaceTaskId,
                  message: getErrorMessage(error, '消息处理失败'),
                  code: 'MESSAGE_PROCESSING_FAILED',
                });
              }
            });
          }
        }
        else if (message.type === 'cancel') handleCancel(client, message.sessionId);
        else if (message.type === 'cancel_followup') followups.cancel(client, message.sessionId, message.messageId);
        else if (message.type === 'resume_followups') followups.resume(client, message.sessionId);
        else if (message.type === 'respond_interaction') handleInteractionResponse(client, message);
      } catch (error: unknown) {
        console.error('[Relay] Failed to handle frontend message:', error);
        if (ws.readyState === WSClient.OPEN) {
          sendFrontendEvent(ws, {
            type: 'error',
            protocolVersion: RELAY_PROTOCOL_VERSION,
            ...(message?.type === 'send' ? { sessionId: message.sessionId, messageId: message.messageId } : {}),
            message: getErrorMessage(error, '消息处理失败'),
            code: 'INVALID_MESSAGE',
          });
        }
      }
    });

    ws.on('close', (code, reason) => {
      connectionDiagnostics.close(code, reason);
      for (const sessionId of getClientSubscribedSessionIds(client)) removeSubscription(client, sessionId);
      deleteFrontendClient(client);
    });

    ws.on('error', (err) => {
      connectionDiagnostics.error();
      console.error('[Relay] Frontend WS error:', err.message);
    });
  });
}
