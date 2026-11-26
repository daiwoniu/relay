import { useEffect, useRef, useCallback } from 'react';
import { tracker } from '../analytics/tracker';
import {observeMessageIntent} from '../analytics/message-intent';
import { useChatStore } from '../stores/chat';
import { isAssistantTerminalMessage } from '../stores/message-terminal';
import { hasBlockingFollowups, useSessionFollowupStore } from '../stores/session-followups';
import { AUTH_REQUIRED_EVENT } from '../api/client';
import { isAuthenticationClose } from './websocket-close';
import type { EngineId, EnginePreferencesDto, FrontendCommand, FrontendEvent, RespondInteractionCommand, SendAttachmentDto, SendCommand } from '../generated/relay-contracts';
import { getProtocolCompatibility } from './protocol-version';
import { disposeWebSocket } from './websocket-dispose';
import { shouldFlushDeltaBatch } from './delta-batching';
import { useAuth } from '../auth/AuthContext';
import { usePendingApprovalStore } from '../stores/pending-approvals';
import { generateUUID } from '../utils/uuid';
import { getDeviceId } from '../utils/device-id';
import { createInteractionResponseManager } from './interaction-response';
import { createPendingSendManager, verifyPendingSend } from './pending-send';
import { getFrontendErrorDisposition, shouldKeepLocalSendFeedback } from './frontend-error-policy';
import { applyNotificationPreferencesUpdate } from './useNotificationPreferences';
import { publishThemeSettingsUpdate } from '../theme/theme-sync';
import { PROCESSING_RESYNC_DELAYS_MS, shouldResyncBlankProcessing } from './processing-resync';
import { hasVisibleProcessPresentation } from '../stores/process-step-visibility';
import { isCurrentWebSocketConnection } from './websocket-generation';
import { createSessionEndAttentionEvent } from '../notifications/session-end-policy';
import { invalidateWorkspaceDashboard } from '../components/workspace-console/workspace-console-cache';
import { useSessionEndAttentionStore } from '../stores/session-end-attention';
import { useSessionReadStore } from '../stores/session-reads';
import { useSessionOperationErrorStore } from '../stores/session-operation-errors';
import { useSessionReadReceipt } from './useSessionReadReceipt';
import { getMessageDetails, listSessions } from '../api/sessions';
import { listSidebarOrders } from '../api/sidebar-order';
import { useEngineConcurrencyStore } from '../stores/engine-concurrency';
import { useQueueStartAttentionStore } from '../stores/queue-start-attention';
import { useSessionDeletionProgressStore } from '../stores/session-deletion-progress';
import { approvalTrustStore } from '../stores/approval-trust';
import {
  collectBasicClientDiagnostics,
  collectBasicClientEnvironment,
  collectClientDiagnostics,
  collectClientEnvironment,
  waitForClientDiagnostics,
  waitForClientEnvironment,
} from '../utils/client-environment';
import type { ClientEnvironmentDto } from '../generated/relay-contracts';
import { BackgroundRuntimeCache } from './background-runtime-cache';
import { selectLiveSessionSubscriptions } from './session-subscription-policy';
import { findMissingResourceIds, getResourceInventory } from '../components/layout/resource-inventory';
import { consumeLocalResourceDeletion, publishResourceDeletionNotice } from '../stores/resource-deletion-notice';

function sendFrontendCommand(ws: WebSocket, command: FrontendCommand): void {
  ws.send(JSON.stringify(command));
}

// 订阅时上报本机设备标识与环境，服务端据此记录授权决定由哪台设备做出。
// 存储不可用时 getDeviceId 返回空串，deviceId 契约要求 min(1)，空值省略字段而不是发送被拒的空串。
function sendSubscribeCommand(ws: WebSocket, sessionId: string, active: boolean, resourceScope: 'mine' | 'all' = 'mine'): void {
  const deviceId = getDeviceId();
  sendFrontendCommand(ws, {
    type: 'subscribe', sessionId, active, includeMessages: false, resourceScope,
    ...(deviceId ? { deviceId } : {}),
    client: collectBasicClientEnvironment(),
  });
}

export function useRelayWebSocket() {
  const analyticsConnection=useRef({account:'',connected:false,outage:false});
  const { user, updateUser } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const localPendingSendSessionsRef = useRef(new Map<string, string>());
  const interactionResponseManagerRef = useRef(createInteractionResponseManager());
  const pendingSendManagerRef = useRef(createPendingSendManager({
    verify: (sessionId, messageId) => verifyPendingSend({
      readMessage: () => getMessageDetails(sessionId, messageId, { timeoutMs: 3_000 }),
      hasFollowup: () => Boolean(useSessionFollowupStore.getState().bySession[sessionId]?.some(item => item.id === messageId)),
      requestSync: () => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) sendSubscribeCommand(ws, sessionId, useChatStore.getState().activeSessionId === sessionId, latestSidebarAccountScopeRef.current);
      },
    }),
  }));
  const disposedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPendingDeltasRef = useRef<() => void>(() => {});
  const discardPendingDeltasRef = useRef<() => void>(() => {});
  const cleanupConnectionRef = useRef<() => void>(() => {});
  const protocolMismatchRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const hasCompletedProtocolHandshakeRef = useRef(false);
  const runtimeCacheRef = useRef(new BackgroundRuntimeCache());
  const subscribedSessionIdsRef = useRef(new Set<string>());
  const sidebarAccountScopeRef = useRef<'mine' | 'all'>('mine');
  const latestSidebarAccountScopeRef = useRef<'mine' | 'all'>('mine');
  const activeSubscriptionSessionIdRef = useRef<string | null>(null);
  const lastFocusedAtRef = useRef(new Map<string, number>());
  const clientEnvironmentRef = useRef<ClientEnvironmentDto>(collectBasicClientEnvironment());
  const clientEnvironmentPromiseRef = useRef<Promise<ClientEnvironmentDto> | null>(null);
  // 按会话缓存发送时明确的引擎。服务端对未绑定引擎的会话会把 SessionDto.engine 返回为 null，
  // 不能依赖 store 里的 session.engine 判断，否则 defer 永远不触发。
  const sessionEngineRef = useRef<Record<string, EngineId>>({});
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const sidebarAccountScope = useChatStore((state) => state.sidebarAccountScope);
  const sessions = useChatStore((state) => state.sessions);
  latestSidebarAccountScopeRef.current = sidebarAccountScope;
  const activeSessionStatus = useChatStore((state) => (
    state.sessions.find((session) => session.id === state.activeSessionId)?.status || null
  ));
  const streamingSessionId = useChatStore((state) => state.streaming.streamingSessionId);
  const hasStreamingPresentation = useChatStore((state) => (
    state.streaming.streamingSessionId === state.activeSessionId
    && (Boolean(state.streaming.currentContent)
      || hasVisibleProcessPresentation(state.streaming.processContent, state.streaming.processSteps))
  ));
  const isStreamingStopping = useChatStore((state) => (
    state.streaming.streamingSessionId === state.activeSessionId && state.streaming.isStopping
  ));
  const { applyRuntimeStreamingSnapshot, startWaiting, markRequestForwarded, startStreaming, startStopping, appendDelta, addProcessStep, updateProcessStep, setProcessTimeline, setStreamingSessionId, setStreamingTokenUsage, finishStreaming, setError, setTokenUsage, applyMessageSync, applyMessageSaved, updateSession, updateSessionStatus, setSidebarOrder, setConnectionError, setProtocolMismatch, mergeReconnectSessionSnapshot } = useChatStore();

  // 用 ref 保持最新的 store 函数，让 connect() 保持稳定
  const storeRef = useRef({ applyRuntimeStreamingSnapshot, startWaiting, markRequestForwarded, startStreaming, startStopping, appendDelta, addProcessStep, updateProcessStep, setProcessTimeline, setStreamingSessionId, setStreamingTokenUsage, finishStreaming, setError, setTokenUsage, applyMessageSync, applyMessageSaved, updateSession, updateSessionStatus, setSidebarOrder, setConnectionError, setProtocolMismatch, mergeReconnectSessionSnapshot });
  storeRef.current = { applyRuntimeStreamingSnapshot, startWaiting, markRequestForwarded, startStreaming, startStopping, appendDelta, addProcessStep, updateProcessStep, setProcessTimeline, setStreamingSessionId, setStreamingTokenUsage, finishStreaming, setError, setTokenUsage, applyMessageSync, applyMessageSaved, updateSession, updateSessionStatus, setSidebarOrder, setConnectionError, setProtocolMismatch, mergeReconnectSessionSnapshot };

  const readSession = sessions.find((session) => session.id === activeSessionId);
  const resultLoaded = useChatStore((state) => Boolean(readSession?.last_result && (state.messages[readSession.id] ?? []).some((message) => message.id === readSession.last_result?.messageId)));
  const sendReadReceipt = useCallback((sessionId: string, messageId: string) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    sendFrontendCommand(ws, { type: 'mark_session_read', sessionId, messageId });
    return true;
  }, []);
  useSessionReadReceipt(readSession, resultLoaded, sendReadReceipt);
  useEffect(() => { useSessionReadStore.getState().reset(); }, [user?.id]);

  const retireCurrentConnection = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    connectionGenerationRef.current += 1;
    subscribedSessionIdsRef.current.clear();
    activeSubscriptionSessionIdRef.current = null;
    cleanupConnectionRef.current();
    cleanupConnectionRef.current = () => {};
    flushPendingDeltasRef.current = () => {};
    discardPendingDeltasRef.current = () => {};
    if (ws) disposeWebSocket(ws);
  }, []);

  const connect = useCallback(() => {
    if (disposedRef.current) return;
    protocolMismatchRef.current = false;
    const clientEnvironmentPromise = collectClientEnvironment();
    clientEnvironmentPromiseRef.current = clientEnvironmentPromise;
    void clientEnvironmentPromise.then((environment) => {
      if (clientEnvironmentPromiseRef.current === clientEnvironmentPromise) {
        clientEnvironmentRef.current = environment;
      }
    });
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    wsRef.current = ws;
    const isCurrentConnection = () => isCurrentWebSocketConnection({
      socket: ws,
      generation,
      currentSocket: wsRef.current,
      currentGeneration: connectionGenerationRef.current,
      disposed: disposedRef.current,
    });
    const refreshSessionsAfterReconnect = async () => {
      const state = useChatStore.getState();
      const expectedStatuses = Object.fromEntries(
        state.sessions.map((session) => [session.id, session.status]),
      );
      const reconciliationCandidates = {
        projectIds: new Set(state.projects.map((project) => project.id)),
        sessionIds: new Set(state.sessions.map((session) => session.id)),
      };
      const controller = new AbortController();
      const abort = () => controller.abort();
      ws.addEventListener('close', abort, { once: true });
      try {
        const [sessions, sidebarOrders] = await Promise.all([listSessions(controller.signal), listSidebarOrders(controller.signal)]);
        if (!isCurrentConnection()) return;
        storeRef.current.mergeReconnectSessionSnapshot(sessions, expectedStatuses);
        const latestState = useChatStore.getState();
        const inventory = getResourceInventory(sidebarOrders.orders);
        for (const session of sessions) inventory.sessionIds.add(session.id);
        const missing = findMissingResourceIds(
          reconciliationCandidates,
          inventory,
        );
        const activeSessionMissing = Boolean(latestState.activeSessionId && missing.sessionIds.has(latestState.activeSessionId));
        const currentProjectMissing = Boolean(latestState.currentProjectId && missing.projectIds.has(latestState.currentProjectId));
        for (const projectId of missing.projectIds) useChatStore.getState().removeProject(projectId);
        for (const sessionId of missing.sessionIds) useChatStore.getState().removeSession(sessionId);
        if (activeSessionMissing || currentProjectMissing) {
          publishResourceDeletionNotice(activeSessionMissing
            ? '会话已删除。'
            : '项目已删除。');
        }
      } catch {
        // WebSocket 增量仍可继续工作，重连补偿失败无需打断连接。
      } finally {
        controller.abort();
        ws.removeEventListener('close', abort);
      }
    };
    const pendingDeltas = new Map<string, {
      content: string;
      phase?: string;
      itemId?: string;
      observedAt?: number;
      timer: ReturnType<typeof setTimeout> | null;
    }>();
    let protocolTimer: ReturnType<typeof setTimeout> | null = null;

    const clearProtocolTimer = () => {
      if (protocolTimer) clearTimeout(protocolTimer);
      protocolTimer = null;
    };

    const rejectProtocol = (serverVersion: unknown) => {
      const compatibility = getProtocolCompatibility(serverVersion);
      if (compatibility.compatible) {
        clearProtocolTimer();
        storeRef.current.setConnectionError(null);
        storeRef.current.setProtocolMismatch(null);
        return false;
      }
      protocolMismatchRef.current = true;
      clearProtocolTimer();
      discardPendingDeltasRef.current();
      storeRef.current.finishStreaming();
      storeRef.current.setConnectionError(compatibility.message);
      storeRef.current.setProtocolMismatch(compatibility.mismatch);
      usePendingApprovalStore.getState().setConnectionAvailable(false);
      ws.close(1000, '协议版本不兼容');
      return true;
    };

    const flushPendingDelta = (sessionId: string) => {
      const pending = pendingDeltas.get(sessionId);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      pendingDeltas.delete(sessionId);
      if (!pending.content && pending.observedAt === undefined) return;
      runtimeCacheRef.current.appendDelta(sessionId, pending.content, pending.phase, pending.itemId, pending.observedAt);
      if (useChatStore.getState().activeSessionId === sessionId) {
        storeRef.current.appendDelta(pending.content, pending.phase, pending.itemId, pending.observedAt);
      }
    };

    const flushPendingDeltas = () => {
      for (const sessionId of [...pendingDeltas.keys()]) flushPendingDelta(sessionId);
    };

    const discardPendingDeltas = () => {
      for (const pending of pendingDeltas.values()) {
        if (pending.timer) clearTimeout(pending.timer);
      }
      pendingDeltas.clear();
    };
    cleanupConnectionRef.current = () => {
      clearProtocolTimer();
      discardPendingDeltas();
    };
    flushPendingDeltasRef.current = flushPendingDeltas;

    const queueDelta = (sessionId: string, content: string, phase?: string, itemId?: string, observedAt?: number) => {
      const current = pendingDeltas.get(sessionId);
      if (current && shouldFlushDeltaBatch(current.content, current.phase, phase, current.itemId, itemId)) {
        flushPendingDelta(sessionId);
      }
      const pending = pendingDeltas.get(sessionId) ?? { content: '', timer: null, observedAt };
      pending.content += content;
      pending.phase = phase;
      pending.itemId = itemId;
      if (!pending.timer) pending.timer = setTimeout(() => flushPendingDelta(sessionId), 80);
      pendingDeltas.set(sessionId, pending);
    };
    discardPendingDeltasRef.current = discardPendingDeltas;

    ws.onopen = () => {
      if (!isCurrentConnection()) return;
      console.log('[Relay] WebSocket 已连接');
      protocolTimer = setTimeout(() => rejectProtocol(undefined), 5000);
      const state = useChatStore.getState();
      const desired = selectLiveSessionSubscriptions({
        activeSessionId: state.activeSessionId,
        sessions: state.sessions,
        lastFocusedAt: lastFocusedAtRef.current,
      });
      subscribedSessionIdsRef.current = new Set(desired);
      activeSubscriptionSessionIdRef.current = state.activeSessionId;
      for (const sessionId of desired.filter((id) => id !== state.activeSessionId)) {
        sendSubscribeCommand(ws, sessionId, false, latestSidebarAccountScopeRef.current);
      }
      if (state.activeSessionId) sendSubscribeCommand(ws, state.activeSessionId, true, latestSidebarAccountScopeRef.current);
      sidebarAccountScopeRef.current = latestSidebarAccountScopeRef.current;
    };

    ws.onmessage = (event) => {
      if (!isCurrentConnection()) return;
      const msg: FrontendEvent = JSON.parse(event.data);
      const store = storeRef.current;
      if (msg.type === 'protocol_info' || msg.type === 'sync_state' || msg.type === 'runtime_sync_state' || msg.type === 'error') {
        if (rejectProtocol((msg as { protocolVersion?: unknown }).protocolVersion)) return;
      }
      if (msg.type === 'protocol_info') {
        const state=analyticsConnection.current;
        if(state.account!==(user?.id??'')){state.account=user?.id??'';state.connected=false;state.outage=false;}
        if(!state.connected||state.outage)tracker.result({feature:'connection',action:state.outage?'recover':'initialize',surface:'system',operationId:generateUUID(),result:'success',trigger:'automatic'});
        state.connected=true;state.outage=false;
        if (hasCompletedProtocolHandshakeRef.current) void refreshSessionsAfterReconnect();
        hasCompletedProtocolHandshakeRef.current = true;
        usePendingApprovalStore.getState().setConnectionAvailable(true);
        return;
      }
      if (msg.type === 'pending_approvals_snapshot') {
        usePendingApprovalStore.getState().applySnapshot(msg.approvals, msg.live);
        return;
      }
      if (msg.type === 'pending_approval_upserted') {
        usePendingApprovalStore.getState().upsertLive(msg.approval);
        return;
      }
      if (msg.type === 'pending_approval_resolved') {
        usePendingApprovalStore.getState().resolve(msg.sessionId, msg.interactionId);
        const item = msg.item;
        if (item?.id === msg.interactionId && item.details.interactionKind === 'async_question') {
          const current = useChatStore.getState();
          const loaded = current.messages[msg.sessionId];
          if (loaded) current.setMessages(msg.sessionId, loaded.map(message => ({ ...message, items: message.items?.map(old => old.id === item.id ? item : old) })));
          if (runtimeCacheRef.current.get(msg.sessionId)?.processSteps.some(old => old.id === item.id)) runtimeCacheRef.current.upsertProcessStep(msg.sessionId, item);
          if (current.streaming.streamingSessionId === msg.sessionId && current.streaming.processSteps.some(old => old.id === item.id)) store.updateProcessStep(item);
        }
        return;
      }
      if (msg.type === 'interaction_response_result') {
        interactionResponseManagerRef.current.handle(msg);
        return;
      }
      if (msg.type === 'notification_preferences_updated') {
        applyNotificationPreferencesUpdate(msg.preferences);
        return;
      }
      if (msg.type === 'theme_settings_updated') {
        publishThemeSettingsUpdate(msg.settings);
        return;
      }
      if (msg.type === 'conversation_defaults_updated') {
        updateUser(msg.user);
        return;
      }
      if (msg.type === 'approval_trust_updated') {
        void approvalTrustStore.getState().handleRemoteUpdate(msg);
        return;
      }
      if (msg.type === 'sidebar_order_updated') {
        store.setSidebarOrder(msg.order);
        return;
      }
      if (msg.type === 'engine_concurrency_updated') {
        useEngineConcurrencyStore.getState().upsertConcurrency(msg.concurrency);
        return;
      }
      if (msg.type === 'turn_queue_updated') {
        useEngineConcurrencyStore.getState().applyQueueSnapshot(msg.sessionId, msg.queue);
        return;
      }
      if (msg.type === 'session_followup_snapshot') {
        useSessionFollowupStore.getState().replace(msg.sessionId, msg.followups);
        for (const followup of msg.followups) pendingSendManagerRef.current.confirm(followup.id);
        return;
      }
      if (msg.type === 'session_followup_updated') {
        useSessionFollowupStore.getState().upsert(msg.followup);
        pendingSendManagerRef.current.confirm(msg.followup.id);
        return;
      }
      if (msg.type === 'turn_queue_started') {
        useEngineConcurrencyStore.getState().clearQueue(msg.sessionId, msg.queueId);
        if (user?.id) {
          const session = useChatStore.getState().sessions.find((item) => item.id === msg.sessionId);
          useQueueStartAttentionStore.getState().publish({ userId: user.id, sessionId: msg.sessionId, sessionTitle: session?.title || '未命名会话', queueId: msg.queueId });
        }
        return;
      }
      if (msg.type === 'project_updated') {
        useChatStore.getState().upsertProject(msg.project);
        return;
      }
      if (msg.type === 'project_deleted') {
        if (user?.id) invalidateWorkspaceDashboard(user.id);
        const state = useChatStore.getState();
        const affectsCurrent = state.currentProjectId === msg.projectId
          || state.sessions.some((session) => session.id === state.activeSessionId && session.project_id === msg.projectId);
        const localDeletion = consumeLocalResourceDeletion('project', msg.projectId);
        useChatStore.getState().removeProject(msg.projectId);
        if (affectsCurrent && !localDeletion) {
          publishResourceDeletionNotice('项目已在其他终端删除。');
        }
        return;
      }
      if (msg.type === 'session_deletion_progress') {
        useSessionDeletionProgressStore.getState().setStage(msg.sessionId, msg.stage);
        return;
      }
      if (msg.type === 'session_deleted') {
        useSessionOperationErrorStore.getState().clear(msg.sessionId);
        if (user?.id) invalidateWorkspaceDashboard(user.id);
        const affectsCurrent = useChatStore.getState().activeSessionId === msg.sessionId;
        const localDeletion = consumeLocalResourceDeletion('session', msg.sessionId);
        useSessionDeletionProgressStore.getState().clearStage(msg.sessionId);
        runtimeCacheRef.current.delete(msg.sessionId);
        lastFocusedAtRef.current.delete(msg.sessionId);
        useChatStore.getState().removeSession(msg.sessionId);
        if (affectsCurrent && !localDeletion) {
          publishResourceDeletionNotice('会话已在其他终端删除。');
        }
        return;
      }
      const currentSessionId = useChatStore.getState().activeSessionId;
      const msgSessionId = 'sessionId' in msg ? msg.sessionId : undefined;
      const isCurrentSession = !msgSessionId || msgSessionId === currentSessionId;
      const trackedStreamingSessionId = useChatStore.getState().streaming.streamingSessionId;
      const isTrackedStreamingSession = Boolean(msgSessionId && msgSessionId === trackedStreamingSessionId);
      const preserveLocalSend = shouldKeepLocalSendFeedback({
        localSendPending: [...localPendingSendSessionsRef.current.values()].includes(msgSessionId || ''),
        sessionId: msgSessionId,
        streamingSessionId: trackedStreamingSessionId,
        isWaiting: useChatStore.getState().streaming.isWaiting,
      });

      if (msg.type === 'delta') {
        queueDelta(msg.sessionId, msg.content, msg.phase, msg.itemId, msg.observedAt);
        return;
      }
      flushPendingDeltas();

      switch (msg.type) {
        case 'sync_state':
          useSessionOperationErrorStore.getState().clear(msg.sessionId);
          useEngineConcurrencyStore.getState().applyQueueSnapshot(msg.sessionId, msg.queue || null, true);
          for (const message of msg.messages) pendingSendManagerRef.current.confirm(message.id);
          {
            const sessionStatus = useChatStore.getState().sessions.find(
              (session) => session.id === msg.sessionId,
            )?.status;
            const projection = runtimeCacheRef.current.applyRuntimeSync(msg, sessionStatus);
            if (!isCurrentSession) {
              if (isTrackedStreamingSession && !projection.shouldPresent && !preserveLocalSend) store.finishStreaming();
              break;
            }
            store.applyMessageSync(
              msg.sessionId,
              msg.messages,
              msg.messageRevision,
              msg.messageHasMore,
              msg.messageNextCursor,
            );
            if (!projection.shouldPresent) {
              if (useChatStore.getState().streaming.streamingSessionId === msg.sessionId && !preserveLocalSend) {
                store.finishStreaming();
              }
              break;
            }
            store.applyRuntimeStreamingSnapshot(projection.snapshot);
          }
          break;

        case 'runtime_sync_state':
          useSessionOperationErrorStore.getState().clear(msg.sessionId);
          useEngineConcurrencyStore.getState().applyQueueSnapshot(msg.sessionId, msg.queue || null, true);
          {
            const sessionStatus = useChatStore.getState().sessions.find(
              (session) => session.id === msg.sessionId,
            )?.status;
            const projection = runtimeCacheRef.current.applyRuntimeSync(msg, sessionStatus);
            if (!isCurrentSession) break;
            if (!projection.shouldPresent) {
              if (useChatStore.getState().streaming.streamingSessionId === msg.sessionId && !preserveLocalSend) store.finishStreaming();
              break;
            }
            store.applyRuntimeStreamingSnapshot(projection.snapshot);
          }
          break;

        case 'request_forwarded':
          runtimeCacheRef.current.markForwarded(msg.sessionId);
          if (!isCurrentSession) break;
          if (msg.sessionId && useChatStore.getState().streaming.streamingSessionId !== msg.sessionId) {
            store.startWaiting(undefined, 'forwarded');
            store.setStreamingSessionId(msg.sessionId);
          } else {
            store.markRequestForwarded();
          }
          break;

        case 'turn_start':
          runtimeCacheRef.current.startStreaming(msg.sessionId);
          if (!isCurrentSession) break;
          if (msg.sessionId && useChatStore.getState().streaming.streamingSessionId !== msg.sessionId) {
            store.startWaiting();
            store.setStreamingSessionId(msg.sessionId);
          }
          store.markRequestForwarded();
          store.startStreaming();
          if (msg.sessionId) store.updateSessionStatus(msg.sessionId, 'processing');
          break;

        case 'item_start': {
          runtimeCacheRef.current.upsertProcessStep(msg.sessionId, msg.item);
          if (!isCurrentSession) break;
          if (msg.item.type === 'interaction' && useChatStore.getState().streaming.streamingSessionId !== msg.sessionId) {
            store.startWaiting();
            if (msg.sessionId) store.setStreamingSessionId(msg.sessionId);
            store.startStreaming();
          }
          store.addProcessStep(msg.item);
          break;
        }

        case 'item_complete': {
          runtimeCacheRef.current.upsertProcessStep(msg.sessionId, msg.item);
          if (!isCurrentSession) break;
          store.updateProcessStep(msg.item);
          break;
        }

        case 'message_complete': {
          if (!isCurrentSession && !isTrackedStreamingSession) break;
          break;
        }

        case 'token_usage':
          storeRef.current.setTokenUsage(msg.sessionId, msg.usage);
          if (
            msg.currentTurn
            && useChatStore.getState().streaming.streamingSessionId === msg.sessionId
          ) {
            storeRef.current.setStreamingTokenUsage(msg.turnOutputUsage || msg.usage);
          }
          break;

        case 'message_saved':
          if (isAssistantTerminalMessage(msg.message) && !preserveLocalSend) useSessionOperationErrorStore.getState().clear(msg.sessionId);
          if (msg.message.role === 'user' && user?.id) invalidateWorkspaceDashboard(user.id);
          pendingSendManagerRef.current.confirm(msg.message.id);
          store.applyMessageSaved(
            msg.sessionId,
            msg.message,
            msg.messageRevision,
            isAssistantTerminalMessage(msg.message)
            && !msg.message.isError
            && !preserveLocalSend
            && (isCurrentSession || isTrackedStreamingSession),
          );
          if (!preserveLocalSend && msg.message.isError && msg.message.errorCode !== 'SESSION_BUSY' && (isCurrentSession || isTrackedStreamingSession)) {
            store.finishStreaming();
          }
          if (!preserveLocalSend && isAssistantTerminalMessage(msg.message)) runtimeCacheRef.current.delete(msg.sessionId);
          break;

        case 'session_reads':
          useSessionReadStore.getState().merge(msg.receipts);
          break;
        case 'session_updated':
          {
            const previousSession = useChatStore.getState().sessions.find((session) => session.id === msg.sessionId);
            const attentionEvent = user?.id ? createSessionEndAttentionEvent(previousSession?.status, { ...msg.session, id: msg.sessionId }, user.id,
              { snapshot: msg.snapshot, previousResultMessageId: previousSession?.last_result?.messageId }) : null;
            if (attentionEvent) useSessionEndAttentionStore.getState().publish(attentionEvent);
            useChatStore.getState().upsertSession({ ...msg.session, id: msg.sessionId });
          }
          if (
            isTrackedStreamingSession
            && !preserveLocalSend
            && !['queued', 'pending', 'processing', 'recovering', 'awaiting_action', 'stopping'].includes(msg.session.status)
          ) {
            store.finishStreaming();
          }
          if (!preserveLocalSend && !['queued', 'pending', 'processing', 'recovering', 'awaiting_action', 'stopping'].includes(msg.session.status)) {
            runtimeCacheRef.current.delete(msg.sessionId);
          }
          break;

        case 'engine_preferences_updated':
          store.updateSession({ id: msg.sessionId, engine_preferences: msg.preferences });
          break;

        case 'turn_complete':
          break;

        case 'turn_cancelling':
          runtimeCacheRef.current.startStopping(msg.sessionId);
          if (isCurrentSession || isTrackedStreamingSession) {
            store.startStopping();
          }
          if (msg.sessionId) store.updateSessionStatus(msg.sessionId, 'stopping');
          break;

        case 'turn_cancelled':
          runtimeCacheRef.current.delete(msg.sessionId);
          if (isCurrentSession || isTrackedStreamingSession) {
            store.finishStreaming();
          }
          break;

        case 'model_info':
          break;

        case 'error': {
          const disposition = getFrontendErrorDisposition(msg, Boolean(msg.messageId && pendingSendManagerRef.current.has(msg.messageId)));
          if (disposition === 'send-rejected' || disposition === 'send-uncertain') {
            // A late error for an already confirmed message cannot undo acceptance.
            if (msg.messageId && pendingSendManagerRef.current.has(msg.messageId)) {
              if (disposition === 'send-uncertain') pendingSendManagerRef.current.verify(msg.messageId);
              else pendingSendManagerRef.current.reject(msg.messageId, msg.message || '消息发送失败');
            }
            break;
          }
          if (disposition === 'operation') {
            useChatStore.getState().setNonTerminalError(msg.message || '操作状态暂时无法确认，请同步状态核对', msg.sessionId || currentSessionId || undefined);
            break;
          }
          if (msg.sessionId) runtimeCacheRef.current.delete(msg.sessionId);
          if (!isCurrentSession && !isTrackedStreamingSession) break;
          console.error('[Relay] 服务端错误:', msg.message);
          store.setError(msg.message || '处理消息时发生未知错误', msg.sessionId);
          break;
        }
      }
    };

    ws.onclose = (event) => {
      if (!isCurrentConnection()) return;
      const state=analyticsConnection.current;
      if(state.account!==(user?.id??'')){state.account=user?.id??'';state.connected=false;state.outage=false;}
      if(!state.outage&&!isAuthenticationClose(event.code)){
        state.outage=true;
        tracker.result({feature:'connection',action:state.connected?'disconnect':'initialize',surface:'system',operationId:generateUUID(),result:'error',trigger:'automatic'});
      }
      usePendingApprovalStore.getState().setConnectionAvailable(false);
      interactionResponseManagerRef.current.rejectAll('连接已断开，授权响应未确认');
      useSessionDeletionProgressStore.getState().clearAll();
      retireCurrentConnection();
      if (protocolMismatchRef.current) return;
      if (isAuthenticationClose(event.code)) {
        window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
        return;
      }
      console.log('[Relay] WebSocket 断开，3秒后重连…');
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, 3000);
    };

    ws.onerror = () => {
      if (!isCurrentConnection()) return;
      // 初始连接错误很常见（服务还没就绪时刷新），静默处理，由 onclose 负责重连
    };
  }, [retireCurrentConnection, updateUser, user?.id]);

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    protocolMismatchRef.current = false;
    usePendingApprovalStore.getState().setConnectionAvailable(false);
    interactionResponseManagerRef.current.rejectAll('连接已断开，授权响应未确认');
    retireCurrentConnection();
    connect();
  }, [connect, retireCurrentConnection]);

  const resyncSession = useCallback((sessionId: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      flushPendingDeltasRef.current();
      sendSubscribeCommand(ws, sessionId, true);
      return true;
    }
    reconnect();
    return false;
  }, [reconnect]);

  const send = useCallback(async (sessionId: string, content: string, messageId?: string, attachments?: SendAttachmentDto[], onConfirmationState?: (state: 'verifying') => void, engine?: EngineId, enginePreferences?: EnginePreferencesDto, workspaceTaskId?: string, replyToAsyncQuestionId?: string, workspaceId?:string): Promise<void> => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const previousStatus = useChatStore.getState().sessions.find((session) => session.id === sessionId)?.status || 'idle';
      const state = useChatStore.getState();
      const isRunningFollowup = ['processing', 'recovering', 'awaiting_action', 'stopping'].includes(previousStatus)
        || Boolean(useEngineConcurrencyStore.getState().queueBySessionId[sessionId])
        || hasBlockingFollowups(useSessionFollowupStore.getState().bySession[sessionId])
        || (state.streaming.streamingSessionId === sessionId && state.streaming.isStreaming);
      const confirmedMessageId = messageId || generateUUID();
      useSessionOperationErrorStore.getState().clear(sessionId);
      if (!isRunningFollowup) {
        localPendingSendSessionsRef.current.set(confirmedMessageId, sessionId);
        storeRef.current.startWaiting();
        storeRef.current.setStreamingSessionId(sessionId);
        storeRef.current.updateSessionStatus(sessionId, 'pending');
      }
      try {
        const basicClientDiagnostics = collectBasicClientDiagnostics();
        const [clientEnvironment, clientDiagnostics] = await Promise.all([
          waitForClientEnvironment(clientEnvironmentPromiseRef.current, clientEnvironmentRef.current),
          waitForClientDiagnostics(
            collectClientDiagnostics(basicClientDiagnostics),
            basicClientDiagnostics,
          ),
        ]);
        if (wsRef.current?.readyState !== WebSocket.OPEN) throw new Error('连接已断开，消息未发送');
        const payload: SendCommand = {
          type: 'send', sessionId, content, client: clientEnvironment, clientDiagnostics, messageId: confirmedMessageId,
        };
        if (engine) {
          payload.engine = engine;
          sessionEngineRef.current[sessionId] = engine;
        }
        if (enginePreferences) payload.enginePreferences = enginePreferences;
        if (workspaceTaskId) payload.workspaceTaskId = workspaceTaskId;
        if (workspaceTaskId && workspaceId) payload.workspaceId = workspaceId;
        if (replyToAsyncQuestionId) payload.replyToAsyncQuestionId = replyToAsyncQuestionId;
        if (attachments?.length) payload.attachments = attachments;
        const confirmation = pendingSendManagerRef.current.wait(confirmedMessageId, {
          sessionId,
          onVerifying: () => onConfirmationState?.('verifying'),
        });
        try {
          observeMessageIntent(confirmedMessageId,engine);
          sendFrontendCommand(wsRef.current, payload);
        } catch (error) {
          pendingSendManagerRef.current.reject(
            confirmedMessageId,
            error instanceof Error ? error.message : '消息发送失败',
          );
        }
        await confirmation;
      } catch (error) {
        const current = useChatStore.getState();
        if (!isRunningFollowup && current.streaming.streamingSessionId === sessionId && current.streaming.isWaiting
          && !current.streaming.isStreaming && !useEngineConcurrencyStore.getState().queueBySessionId[sessionId]) {
          storeRef.current.finishStreaming();
          if (current.sessions.find(session => session.id === sessionId)?.status === 'pending') storeRef.current.updateSessionStatus(sessionId, previousStatus);
        }
        throw error;
      } finally {
        localPendingSendSessionsRef.current.delete(confirmedMessageId);
      }
    } else {
      throw new Error('未连接到服务器，请稍后重试');
    }
  }, []);

  const cancel = useCallback((sessionId: string, expectedAttemptId: string, analyticsOperationId?: string) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) throw new Error('未连接到服务器，请重连后重试');
    sendFrontendCommand(ws, { type: 'cancel', sessionId, expectedAttemptId, analyticsOperationId });
  }, []);

  const cancelFollowup = useCallback((sessionId: string, messageId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) throw new Error('未连接到服务器');
    sendFrontendCommand(wsRef.current, { type: 'cancel_followup', sessionId, messageId });
  }, []);

  const resumeFollowups = useCallback((sessionId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) throw new Error('未连接到服务器');
    sendFrontendCommand(wsRef.current, { type: 'resume_followups', sessionId });
  }, []);

  const respondToInteraction = useCallback((
    sessionId: string,
    interactionId: string,
    action: RespondInteractionCommand['action'],
    options: Pick<RespondInteractionCommand, 'answers' | 'formData'> = {},
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('未连接到服务器，无法提交操作'));
    }
    const operationId = generateUUID();
    const resultPromise = interactionResponseManagerRef.current.wait(operationId);
    if(action==='cancel')tracker.action({feature:'interaction',action:'cancel',surface:'message'});
    else tracker.action({feature:'interaction',action:action==='accept'?'approve':action==='accept_for_session'?'approve_session':action==='decline'?'reject':options.formData?'submit_mcp':'submit_answer',surface:'message',operationId});
    try {
      sendFrontendCommand(wsRef.current, {
      type: 'respond_interaction',
        operationId,
      sessionId,
      interactionId,
      action,
      ...options,
      });
    } catch (error) {
      interactionResponseManagerRef.current.reject(operationId, error instanceof Error ? error.message : '提交操作失败');
    }
    return resultPromise;
  }, []);

  const shouldAutoResync = shouldResyncBlankProcessing({
    activeSessionId,
    streamingSessionId,
    sessionStatus: activeSessionStatus,
    hasPresentation: hasStreamingPresentation,
    isStopping: isStreamingStopping || activeSessionStatus === 'stopping',
    isAwaitingAction: activeSessionStatus === 'awaiting_action',
  });

  useEffect(() => {
    usePendingApprovalStore.getState().configureUser(user?.id || null);
    useSessionFollowupStore.getState().clear();
    useSessionOperationErrorStore.getState().reset();
    runtimeCacheRef.current.clear();
    lastFocusedAtRef.current.clear();
  }, [user?.id]);

  useEffect(() => {
    const ws = wsRef.current;
    flushPendingDeltasRef.current();
    if (activeSessionId) {
      lastFocusedAtRef.current.set(activeSessionId, Date.now());
      const cached = runtimeCacheRef.current.get(activeSessionId);
      if (cached) storeRef.current.applyRuntimeStreamingSnapshot(cached);
    }
    if (ws?.readyState !== WebSocket.OPEN) return;

    const desired = selectLiveSessionSubscriptions({
      activeSessionId,
      sessions,
      lastFocusedAt: lastFocusedAtRef.current,
    });
    const desiredSet = new Set(desired);
    for (const sessionId of subscribedSessionIdsRef.current) {
      if (desiredSet.has(sessionId)) continue;
      sendFrontendCommand(ws, { type: 'unsubscribe', sessionId });
      runtimeCacheRef.current.delete(sessionId);
    }
    const scopeChanged = sidebarAccountScopeRef.current !== sidebarAccountScope;
    for (const sessionId of desired) {
      if (!scopeChanged && (sessionId === activeSessionId || subscribedSessionIdsRef.current.has(sessionId))) continue;
      sendSubscribeCommand(ws, sessionId, sessionId === activeSessionId, sidebarAccountScope);
    }
    if (activeSessionId && activeSubscriptionSessionIdRef.current !== activeSessionId && !scopeChanged) {
      sendSubscribeCommand(ws, activeSessionId, true, sidebarAccountScope);
    }
    sidebarAccountScopeRef.current = sidebarAccountScope;
    subscribedSessionIdsRef.current = desiredSet;
    activeSubscriptionSessionIdRef.current = activeSessionId;
  }, [activeSessionId, sessions, sidebarAccountScope]);

  useEffect(() => {
    if (!shouldAutoResync || !activeSessionId) return;
    const timers = PROCESSING_RESYNC_DELAYS_MS.map((delay) => (
      setTimeout(() => resyncSession(activeSessionId), delay)
    ));
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [activeSessionId, resyncSession, shouldAutoResync]);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      protocolMismatchRef.current = false;
      cleanupConnectionRef.current();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      retireCurrentConnection();
      interactionResponseManagerRef.current.rejectAll('连接已关闭，授权响应未确认');
      pendingSendManagerRef.current.rejectAll('连接已关闭，消息未得到服务端确认');
      usePendingApprovalStore.getState().setConnectionAvailable(false);
    };
  }, [connect, retireCurrentConnection]);

  return { send, cancel, cancelFollowup, resumeFollowups, respondToInteraction, reconnect, resyncSession };
}
