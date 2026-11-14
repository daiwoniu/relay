import { RELAY_PROTOCOL_VERSION, type FrontendEvent, type PendingApprovalDto, type TurnQueueSnapshotDto } from '../contracts/index.js';
import type { SessionRuntime } from '../engine/runtime.js';
import { presentProcessItems } from '../messages/presenter.js';
import { sessionService } from '../services/sessions.js';
import { collectPendingApprovals } from './pending-approvals.js';
import { canManageOwnedResource, type Actor } from '../auth/authorization.js';

export function listPendingApprovals(runtimes: Iterable<SessionRuntime>, actor?: Actor): PendingApprovalDto[] {
  return collectPendingApprovals([...runtimes].flatMap((runtime) => {
    const session = sessionService.getRecord(runtime.sessionId);
    if (!session?.engine || (actor && !canManageOwnedResource(actor, session.owner_user_id))) return [];
    return [{
      sessionId: runtime.sessionId,
      sessionTitle: session.title,
      engine: session.engine,
      items: runtime.turnItems,
      pending: [...runtime.pendingInteractions.entries()].map(([interactionId, pending]) => ({
        interactionId,
        createdAt: pending.createdAt,
      })),
    }];
  }));
}

export function getPendingApproval(
  runtimes: Iterable<SessionRuntime>,
  sessionId: string,
  interactionId: string,
  actor?: Actor,
): PendingApprovalDto | null {
  return listPendingApprovals(runtimes, actor)
    .find((approval) => approval.sessionId === sessionId && approval.id === interactionId) || null;
}

export function buildRuntimeSyncState(
  sessionId: string,
  runtime?: SessionRuntime,
  queue: TurnQueueSnapshotDto | null = null,
): Extract<FrontendEvent, { type: 'sync_state' }> {
  const messagePageResult = sessionService.listMessagePage(sessionId);
  if (messagePageResult.unchanged) throw new Error('消息同步页缺少消息内容');
  return {
    type: 'sync_state',
    protocolVersion: RELAY_PROTOCOL_VERSION,
    sessionId,
    messageRevision: messagePageResult.page.revision,
    messageHasMore: messagePageResult.page.hasMore,
    messageNextCursor: messagePageResult.page.nextCursor,
    messages: messagePageResult.page.messages,
    isRunning: runtime?.isRunning || false,
    currentContent: runtime
      ? runtime.finalAnswerContent || (runtime.commentaryContent ? '' : runtime.currentContent)
      : '',
    ...(runtime?.commentaryContent ? { processContent: runtime.commentaryContent } : {}),
    processSteps: presentProcessItems(runtime?.turnItems || [], runtime?.isRunning ? 'in_progress' : 'completed'),
    ...(runtime?.processTimeline.length ? { processTimeline: runtime.processTimeline } : {}),
    startTime: runtime?.turnStartTime || null,
    requestForwarded: runtime?.requestForwarded || false,
    isStopping: runtime?.isStopping || false,
    queue,
  };
}

export function buildRuntimeOnlySyncState(
  sessionId: string,
  runtime?: SessionRuntime,
  queue: TurnQueueSnapshotDto | null = null,
): Extract<FrontendEvent, { type: 'runtime_sync_state' }> {
  return {
    type: 'runtime_sync_state',
    protocolVersion: RELAY_PROTOCOL_VERSION,
    sessionId,
    isRunning: runtime?.isRunning || false,
    currentContent: runtime
      ? runtime.finalAnswerContent || (runtime.commentaryContent ? '' : runtime.currentContent)
      : '',
    ...(runtime?.commentaryContent ? { processContent: runtime.commentaryContent } : {}),
    processSteps: presentProcessItems(runtime?.turnItems || [], runtime?.isRunning ? 'in_progress' : 'completed'),
    ...(runtime?.processTimeline.length ? { processTimeline: runtime.processTimeline } : {}),
    startTime: runtime?.turnStartTime || null,
    requestForwarded: runtime?.requestForwarded || false,
    isStopping: runtime?.isStopping || false,
    queue,
  };
}
