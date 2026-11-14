import { randomUUID } from 'node:crypto';
import { SendAttachmentDtoSchema, RELAY_PROTOCOL_VERSION, type SendCommand, type TurnQueueSnapshotDto } from '../contracts/index.js';
import { getDB } from '../db/index.js';
import { listSessionFollowups } from '../db/session-followups.js';
import { canSubmitAsyncQuestionAnswer } from '../codex/async-questions.js';
import type { RuntimeTurnItem } from '../engine/runtime.js';
import type { SessionFollowupRecord } from '../db/session-followups.js';
import { defaultEngineSystem } from '../engine/default-system.js';
import { parseMessageMetadata, serializeMessageMetadata } from '../message-metadata.js';
import { prepareMessageAttachments } from '../messages/message-attachments.js';
import { presentMessage } from '../messages/presenter.js';
import { SessionFollowupDelivery, type FollowupRuntime } from '../services/session-followup-delivery.js';
import { projectService } from '../services/projects.js';
import { sessionService } from '../services/sessions.js';
import type { TurnAdmissionService } from '../services/turn-admission.js';
import { deletionState } from '../services/deletion-state.js';
import { broadcastFrontendEvent, broadcastSessionUpdate, sendFrontendEvent, type FrontendClient } from './frontend-client-hub.js';
import { resolveSendEnginePreferences, validateSendEnginePreferences } from './frontend-model-selection.js';
import { getErrorMessage } from './frontend-protocol.js';
import { createMessageOriginForClient } from '../message-origin.js';
import { presentFollowupAttachments } from '../messages/followup-attachments.js';

export function presentSessionFollowup(record: SessionFollowupRecord) {
  return {
    id: record.id, sessionId: record.sessionId, content: record.content,
    state: record.state, createdAt: record.createdAt, errorCode: record.errorCode,
    replyToAsyncQuestionId: record.replyToAsyncQuestionId,
    attachments: presentFollowupAttachments(record.attachmentsJson),
  };
}

export function hasBlockingSessionFollowups(sessionId: string): boolean {
  return listSessionFollowups(getDB(), sessionId).some((record) =>
    !['steered', 'delivered', 'cancelled'].includes(record.state));
}

function recoveryOutcome(sessionId: string): 'completed' | 'failed' | 'unknown' {
  const row = getDB().get("SELECT metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1", [sessionId]);
  const outcome = parseMessageMetadata(row?.metadata as string | null).outcome;
  return outcome === 'completed' ? 'completed' : outcome ? 'failed' : 'unknown';
}

export function isAsyncQuestionSendAvailable(input: {
  sessionId: string; questionId: string; messageId?: string; runtimeItems: RuntimeTurnItem[]; actorUserId: string;
}): boolean {
  const history = getDB().all('SELECT role, items, metadata FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC', [input.sessionId]) as Array<{ role: string; items: string | null; metadata: string | null }>;
  return canSubmitAsyncQuestionAnswer({ questionId: input.questionId, messageId: input.messageId,
    ownerUserId: sessionService.getRecord(input.sessionId)?.owner_user_id ?? null, actorUserId: input.actorUserId,
    runtimeItems: input.runtimeItems, history, followups: listSessionFollowups(getDB(), input.sessionId) });
}

export function validateAsyncQuestionSend(
  client: FrontendClient, message: SendCommand, engine: string, runtimeItems: RuntimeTurnItem[],
): boolean {
  const questionId = message.replyToAsyncQuestionId;
  if (!questionId) return true;
  if (engine === 'codex' && isAsyncQuestionSendAvailable({
    sessionId: message.sessionId, questionId, messageId: message.messageId, runtimeItems, actorUserId: client.userId,
  })) return true;
  sendFrontendEvent(client.ws, {
    type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION,
    sessionId: message.sessionId, messageId: message.messageId,
    message: '这条提问已失效或已回答，请刷新会话', code: 'ASYNC_QUESTION_UNAVAILABLE',
  });
  return false;
}

export function createFrontendFollowups(deps: {
  runtimeOf(sessionId: string): FollowupRuntime | null;
  admission(): TurnAdmissionService;
  drain(resourceKey: string): Promise<void>;
  queueSnapshot(sessionId: string): TurnQueueSnapshotDto | null;
  changed(record: SessionFollowupRecord): void;
}) {
  async function dispatch(record: SessionFollowupRecord): Promise<void> {
    const session = sessionService.getRecord(record.sessionId);
    if (!session?.engine || session.owner_user_id !== record.userId) throw new Error('会话已失效');
    const projectId = session.project_id;
    const project = projectId ? projectService.get(projectId) : null;
    if (!projectId || !project || deletionState.getSessionBlock(record.sessionId, projectId)) throw new Error('项目已失效');
    const preferences = resolveSendEnginePreferences(session, {
      type: 'send', sessionId: record.sessionId, content: record.content,
    });
    await validateSendEnginePreferences(session.engine, preferences, false);
    const drafts = SendAttachmentDtoSchema.array().max(10).parse(JSON.parse(record.attachmentsJson));
    const prepared = prepareMessageAttachments({
      attachments: drafts, projectId, projectPath: project.path,
      userId: record.userId, messageId: record.id,
    });
    let admitted;
    try {
      const adapter = defaultEngineSystem.registry.get(session.engine);
      const resource = adapter.concurrency?.resolveResource({ sessionId: record.sessionId, projectId });
      if (!resource) throw new Error('当前引擎未配置并发资源');
      const attemptId = randomUUID();
      admitted = deps.admission().enqueue({
        sessionId: record.sessionId,
        engineId: session.engine,
        requestedByUserId: record.userId,
        attemptId,
        resource,
        enginePreferencesRevision: preferences.expectedRevision,
        message: {
          id: record.id, session_id: record.sessionId, turn_id: attemptId,
          role: 'user', content: record.content.trim(), phase: null, items: null,
          metadata: serializeMessageMetadata({ attachments: prepared.attachments, origin: record.origin, replyToAsyncQuestionId: record.replyToAsyncQuestionId || undefined }),
          duration: null, stopped: 0,
        },
      });
    } catch (error) {
      prepared.rollback();
      throw error;
    }
    try {
      broadcastFrontendEvent({
        type: 'message_saved', sessionId: record.sessionId,
        messageRevision: admitted.savedMessage.revision,
        message: presentMessage(admitted.savedMessage.message),
      });
      broadcastSessionUpdate(sessionService.require(record.sessionId));
      broadcastFrontendEvent({ type: 'turn_queue_updated', sessionId: record.sessionId, queue: deps.queueSnapshot(record.sessionId) });
    } catch (error) { console.error('[Relay] 后续消息广播失败:', error); }
    void Promise.resolve().then(() => deps.drain(admitted.queue.resourceKey))
      .catch((error) => console.error('[Relay] 后续消息调度失败:', error));
  }

  async function accepted(record: SessionFollowupRecord): Promise<void> {
    const content = record.content.trim();
    const existing = sessionService.getMessageRecord(record.sessionId, record.id);
    if (existing) {
      if (existing.role !== 'user' || existing.content !== content) throw new Error('引导消息 ID 已被其他消息使用');
      return;
    }
    const saved = sessionService.saveMessage({
      id: record.id, session_id: record.sessionId,
      turn_id: record.targetTurnId || randomUUID(), role: 'user', content,
      phase: null, items: null,
      metadata: serializeMessageMetadata({ origin: record.origin, replyToAsyncQuestionId: record.replyToAsyncQuestionId || undefined }),
      duration: null, stopped: 0,
    });
    try {
      broadcastFrontendEvent({
        type: 'message_saved', sessionId: record.sessionId,
        messageRevision: saved.revision, message: presentMessage(saved.message),
      });
      broadcastSessionUpdate(sessionService.require(record.sessionId));
    } catch (error) { console.error('[Relay] 引导消息广播失败:', error); }
  }

  let service: SessionFollowupDelivery | null = null;
  function get(): SessionFollowupDelivery {
    return service ??= new SessionFollowupDelivery({
      db: getDB(),
      ownerOf: (sessionId) => sessionService.getRecord(sessionId)?.owner_user_id ?? null,
      runtimeOf: deps.runtimeOf,
      recoveryOutcome,
      dispatch,
      accepted,
      changed: deps.changed,
    });
  }

  async function submit(client: FrontendClient, message: SendCommand): Promise<void> {
    const messageId = message.messageId || randomUUID();
    try {
      if (message.workspaceTaskId) throw new Error('运行中消息暂不支持工作区任务关联');
      await get().submitFollowup({
        id: messageId, sessionId: message.sessionId, userId: client.userId,
        content: message.content.trim(), attachmentsJson: JSON.stringify(message.attachments || []),
        replyToAsyncQuestionId: message.replyToAsyncQuestionId || null,
        origin: createMessageOriginForClient(client, message.client),
        targetTurnId: deps.runtimeOf(message.sessionId)?.turnId ?? null,
        createdAt: Date.now(),
      });
    } catch (error) {
      sendFrontendEvent(client.ws, {
        type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION,
        sessionId: message.sessionId, messageId,
        message: getErrorMessage(error, '后续消息保存失败'), code: 'FOLLOWUP_SAVE_FAILED',
      });
    }
  }
  function cancel(client: FrontendClient, sessionId: string, messageId: string): void {
    try {
      sessionService.requireUsableForActor(client.actor, sessionId);
      void get().cancelSessionFollowup(sessionId, messageId, client.userId).catch((error) => {
        sendFrontendEvent(client.ws, {
          type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId, messageId,
          message: getErrorMessage(error, '取消后续消息失败'), code: 'FOLLOWUP_CANCEL_FAILED',
        });
      });
    } catch (error) {
      sendFrontendEvent(client.ws, {
        type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId, messageId,
        message: getErrorMessage(error, '无权取消后续消息'), code: 'FOLLOWUP_CANCEL_FAILED',
      });
    }
  }

  function resume(client: FrontendClient, sessionId: string): void {
    try {
      sessionService.requireUsableForActor(client.actor, sessionId);
      if (sessionService.getRecord(sessionId)?.owner_user_id !== client.userId) throw new Error('只有会话所有人可以继续后续消息');
      void get().resumeSessionFollowups(sessionId).catch((error) => {
        sendFrontendEvent(client.ws, {
          type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId,
          message: getErrorMessage(error, '继续后续消息失败'), code: 'FOLLOWUP_RESUME_FAILED',
        });
      });
    } catch (error) {
      sendFrontendEvent(client.ws, {
        type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId,
        message: getErrorMessage(error, '无权继续后续消息'), code: 'FOLLOWUP_RESUME_FAILED',
      });
    }
  }
  return { get, submit, cancel, resume };
}
