import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoreStoragePort } from '../../storage/contracts.js';
import type { RespondInteractionCommand } from '../../contracts/index.js';
import type { FeishuPending, FeishuWorkResult } from '../../storage/native-feishu-im.js';
import { StorageContractError } from '../../storage/command-boundary.js';
import type { StoredRuntimeGraph } from '../../ws/stored-runtime-graph.js';
import type { EngineRegistry } from '../../engine/registry.js';
import type { NormalizedInteraction } from '../../engine/interactions.js';
import type { SessionRuntime } from '../../engine/runtime.js';
import { containsInteractionCommandSyntax, normalizeInteractionReason } from '../../engine/interaction-purpose.js';
import type { EngineModelCatalog } from '../../engine/models/types.js';
import { validateEnginePreferences } from '../../engine/models/preferences.js';
import { feishuModelIdSchema, type FeishuBotConfig, type FeishuEnginePreferences, type FeishuManualDecision } from './inbound.js';
import { feishuEngineReplyLine } from './reply-execution.js';
import { feishuExecutionId, feishuExecutionResource } from './native-session-scope.js';
import { FeishuAttachmentError, uploadFeishuAttachments } from './attachments.js';
import { createFeishuClient } from './sdk.js';
import type { StoredProjectUploads } from '../../services/stored-project-uploads.js';
import type { StoredMessageAttachments } from '../../services/stored-message-attachments.js';
import type { StoredDraftCleanup } from '../../services/stored-draft-cleanup.js';

type ApprovalNotice = Extract<FeishuWorkResult, { kind: 'approvalNotice' }>;
type SendApprovalNotice = (target: ApprovalNotice, readBody: () => string | null) => Promise<void>;

function reviewActions({ kind, availableActions }: NormalizedInteraction) {
  if (kind !== 'command' && kind !== 'file' && kind !== 'permissions') return null;
  const accept = availableActions.includes('accept_once');
  const decline = availableActions.includes('decline');
  const cancel = availableActions.includes('cancel');
  return accept || decline || cancel ? { accept, decline, cancel } : null;
}

function liveManualRequests(runtime: SessionRuntime | undefined | null, attemptId: string) {
  if (!runtime?.isRunning || runtime.isStopping || runtime.isRecovering || !runtime.engineConnectionId
    || runtime.attemptId !== attemptId) return [];
  return [...runtime.pendingInteractions].filter(([, request]) =>
    request.manualReview && !request.standalone && request.connectionId === runtime.engineConnectionId);
}

function publicApprovalPurpose({ snapshot }: NormalizedInteraction): string | null {
  if (typeof snapshot.reason !== 'string') return null;
  // Only the provider's declared reason is eligible for chat. Never derive it from raw commands or arguments.
  const reason = normalizeInteractionReason(snapshot.reason, '相关操作')
    .replace(/(?:\b[\w-]*(?:token|password|passwd|secret|credential|api[_-]?key|authorization|cookie)|密码|密钥|令牌|凭证)\s*[:=：]\s*(?:"[^"]*"|'[^']*'|\[REDACTED[^\]]*\]|[^\s,;&，；。)）]+)/gi, '敏感参数')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s，。；！？）)<>"']+/gi, '相关地址')
    .replace(/(?:[a-z]:[\\/]|\\\\|(?:^|[\s（(])(?:\.\.?[\\/]|\/))[^\s，。；！？）)<>"']+/gi, ' 相关路径')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '相关账号')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '相关地址')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '相关标识')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  const unsafe = (text: string) => containsInteractionCommandSyntax(text)
    || /[`<>]|\$\(|\bBearer\b|\[REDACTED|(?:密码|密钥|令牌|凭证)\s*(?:为|是)|\b(?:token|password|secret|cookie)\s+(?:is|value)\b/i.test(text);
  const parts = reason.split(/以便|目的是|用于|从而|\bin order to\b|\bso that\b/gi);
  const description = (unsafe(reason) ? parts.slice(1).find(part => part.trim() && !unsafe(part)) ?? '' : reason)
    .replace(/[。！？!?\s]+$/, '').trim();
  if (!/\p{L}/u.test(description)) return null;
  const characters = Array.from(description);
  return characters.length <= 160 ? description : `${characters.slice(0, 159).join('')}…`;
}

export function feishuApprovalWaitBody(interactions: readonly NormalizedInteraction[]): string | null {
  const requests = interactions.filter(reviewActions);
  if (!requests.length) return null;
  const operations = [...new Set(requests.map(({ kind, snapshot }) => kind === 'command' ? '执行命令'
    : kind === 'file' ? '进行文件操作' : snapshot.networkApprovalContext ? '访问网络' : '授予额外权限'))];
  const descriptions = requests.map(publicApprovalPurpose);
  const purposes = [...new Set(descriptions.filter((purpose): purpose is string => purpose !== null))];
  const missing = descriptions.filter(purpose => purpose === null).length;
  const explanation = purposes.length
    ? `${purposes.join('、')}${missing ? `。另有 ${missing} 项请在对应授权记录查看详情` : ''}`
    : '请在 Relay 处理过程的授权记录中查看具体用途和操作详情。';
  return [
    '任务正在等待 Relay 人工审核。',
    `申请授权：${operations.join('、')}`,
    `申请说明：${explanation}`,
    requests.every(request => request.availableActions.includes('accept_once'))
      ? '所需授权通过后，任务会自动继续。你无需重复发送。'
      : '你无需重复发送，请等待机器人后续回复。',
  ].join('\n');
}

export class NativeFeishuConversation {
  constructor(private readonly options: {
    port: Pick<CoreStoragePort, 'runFeishuWork' | 'runFeishuAdmin' | 'execute'>;
    graph: Pick<StoredRuntimeGraph, 'scheduler' | 'runtimes' | 'responses'>;
    registry: Pick<EngineRegistry, 'list' | 'get'>;
    storeId: string; generation: number;
    catalog: (engine: FeishuEnginePreferences['engineId']) => Promise<EngineModelCatalog>;
    assertExclusiveWriter: () => Promise<void>;
    attachments?: { uploads: Pick<StoredProjectUploads, 'uploadInScope'>; promoter: Pick<StoredMessageAttachments, 'prepareInScope'>;
      cleanup: Pick<StoredDraftCleanup, 'deleteInScope'>; onCleanupFailure: () => void };
  }) {}

  get supportedEngines() { return this.options.registry.list().filter(adapter => adapter.models && adapter.concurrency).map(adapter => adapter.id); }
  catalog(engine: FeishuEnginePreferences['engineId']) { return this.options.catalog(engine); }

  async approvals(principal: Parameters<CoreStoragePort['runFeishuAdmin']>[0]['principal'],
    scope: { botId: string; tenantKey: string }, sequence: number, decision?: { id: string; action: FeishuManualDecision; operationId: string }) {
    const { reviewTurn } = await this.options.port.runFeishuAdmin({ principal, request: { ...scope, action: 'reviewTurn', sequence } });
    const runtime = reviewTurn ? this.options.graph.runtimes.get(reviewTurn.sessionId) : undefined;
    const liveRequests = reviewTurn ? liveManualRequests(runtime, reviewTurn.attemptId) : [];
    const requests = liveRequests.flatMap(([id, pending]) => {
      const { snapshot } = pending.interaction;
      const actions = reviewActions(pending.interaction);
      if (!actions) return [];
      const detail = snapshot.command ?? snapshot.path ?? snapshot.reason;
      return [{ id, title: snapshot.title, detail: typeof detail === 'string' ? detail.slice(0, 1200)
        : Array.isArray(detail) ? detail.filter(value => typeof value === 'string').join(' ').slice(0, 1200) : null,
      ...actions }];
    });
    if (!decision) return { requests };
    const request = requests.find(item => item.id === decision.id);
    if (!runtime || !request?.[decision.action]) throw new StorageContractError('CONFLICT');
    const command: RespondInteractionCommand = { type: 'respond_interaction', sessionId: runtime.sessionId,
      interactionId: decision.id, operationId: decision.operationId, action: decision.action };
    const result = await this.options.graph.responses.respond(principal, command);
    if (result.state !== 'submitted') throw new StorageContractError(result.state === 'access-denied' ? 'FORBIDDEN'
      : result.state === 'unknown' ? 'STORAGE_UNAVAILABLE' : 'CONFLICT');
    return { requests: [] };
  }

  async reply(bot: FeishuBotConfig, pending: FeishuPending, preferences: FeishuEnginePreferences, signal: AbortSignal,
    details?: { taskId?: string; taskTitle?: string; senderDisplayName?: string; sendApprovalNotice?: SendApprovalNotice }) {
    const { port, graph, registry, storeId, generation, assertExclusiveWriter } = this.options;
    const { inbound, sequence } = pending;
    const scope = { botId: inbound.botId, tenantKey: inbound.tenantKey, sequence, workspacePath: bot.workspacePath };
    const { engineId, ...model } = preferences;
    const useMappedPreferences = !!inbound.relayTurn || (inbound.chatType === 'group' && !!(inbound.parentId || inbound.rootId));
    let replyCatalog: EngineModelCatalog | undefined;
    const canStart = async (engine: FeishuEnginePreferences['engineId'], settings?: Omit<FeishuEnginePreferences, 'engineId'>) => {
      if (!registry.get(engine).availability.getCurrent().available) return false;
      try {
        if (settings) {
          replyCatalog = await this.catalog(engine);
          validateEnginePreferences(replyCatalog, settings);
        }
      }
      catch { return false; }
      return true;
    };
    signal.throwIfAborted();
    if (!useMappedPreferences && !await canStart(engineId, model)) return null;
    signal.throwIfAborted();
    await assertExclusiveWriter();
    const { taskId, taskTitle, senderDisplayName, sendApprovalNotice } = details ?? {};
    const mapped = await port.runFeishuWork({ ...scope, action: 'prepareRelayTurn', configurationId: bot.id, engineId, preferences: model,
      ...(taskId === undefined ? {} : { taskId }), ...(taskTitle === undefined ? {} : { taskTitle }),
      ...(senderDisplayName === undefined ? {} : { senderDisplayName }),
      ...(pending.question === undefined ? {} : { clarifiedContent: pending.question }) });
    if (mapped?.kind !== 'relayTurnPrepared') return null;
    const { turn, content } = mapped;
    const attemptId = feishuExecutionId([turn.messageId, 'attempt']);
    const resourceKey = feishuExecutionResource(turn.engineId);
    const read = () => port.runFeishuWork({ ...scope, action: 'readRelayTurn' });
    let state = await read();
    if (state?.kind === 'relayTurnResult' && state.state === 'notAdmitted') {
      if (useMappedPreferences && !await canStart(turn.engineId, turn.preferences)) return null;
      if (inbound.attachments?.length) {
        const services = this.options.attachments;
        if (!services) throw new FeishuAttachmentError('upload');
        const attachmentScope = { ...scope, messageId: turn.messageId };
        const readScope = async () => {
          signal.throwIfAborted();
          const result = await port.runFeishuWork({ ...attachmentScope, action: 'attachmentScope' });
          if (result?.kind !== 'attachmentScope') throw new FeishuAttachmentError('upload');
          return result.scope;
        };
        try {
          let drafts = turn.attachmentDrafts;
          if (!drafts) {
            const client = await createFeishuClient(bot.appId, bot.appSecret);
            drafts = await uploadFeishuAttachments({ resources: inbound.attachments, getResource: client.im.messageResource.get,
              uploads: services.uploads, cleanup: services.cleanup, onCleanupFailure: services.onCleanupFailure,
              readScope, messageId: turn.messageId, feishuMessageId: inbound.messageId, signal });
            await assertExclusiveWriter();
            const recorded = await port.runFeishuWork({ ...attachmentScope, action: 'recordAttachmentDrafts', drafts });
            if (recorded?.kind !== 'attachmentScope') throw new FeishuAttachmentError('upload');
          }
          const uploadScope = await readScope();
          await services.promoter.prepareInScope(uploadScope.viewerUserId, inbound.projectId, turn.messageId, drafts, readScope, signal);
        } catch (error) {
          signal.throwIfAborted();
          throw error instanceof FeishuAttachmentError ? error : new FeishuAttachmentError('upload');
        }
      }
      signal.throwIfAborted();
      await assertExclusiveWriter();
      const result = await port.execute({ protocolVersion: 1, storeId, workerGeneration: generation, requestId: randomUUID(),
        operationId: `feishu-turn:${turn.messageId}`, principal: { kind: 'system', purpose: 'scheduler' },
        command: { name: 'turn.enqueue', input: { sessionId: turn.sessionId, messageId: turn.messageId,
          attemptId, engineId: turn.engineId, resourceKey, content, metadata: null,
          expectedPreferencesRevision: mapped.preferencesRevision,
          origin: { kind: 'feishu', botId: scope.botId, tenantKey: scope.tenantKey, sequence },
        } } });
      state = await read();
      if (state?.kind === 'relayTurnResult' && state.state === 'notAdmitted') {
        if (result.state === 'rejected' && ['FORBIDDEN', 'INVALID_ARGUMENT', 'NOT_FOUND'].includes(result.code)) return null;
        throw new StorageContractError('NOT_SUBMITTED');
      }
    }
    const readApprovalNotice = () => signal.aborted ? null : feishuApprovalWaitBody(
      liveManualRequests(graph.runtimes.get(turn.sessionId), attemptId).map(([, request]) => request.interaction));
    let approvalNoticeClaimed = !!turn.approvalNoticeClaimed;
    while (state?.kind === 'relayTurnResult' && state.state === 'pending') {
      signal.throwIfAborted();
      if (sendApprovalNotice && !approvalNoticeClaimed && readApprovalNotice()) {
        try {
          await assertExclusiveWriter();
          if (readApprovalNotice()) {
            const target = await port.runFeishuWork({ ...scope, action: 'takeApprovalNotice', messageId: turn.messageId });
            if (target?.kind === 'approvalNotice') {
              approvalNoticeClaimed = true;
              await sendApprovalNotice(target, readApprovalNotice);
            }
          }
        } catch { /* A missed reminder must not prevent the normal reply. */ }
      }
      void graph.scheduler.drain(resourceKey).catch(() => undefined);
      await delay(1500, undefined, { signal });
      state = await read();
    }
    if (state?.kind !== 'relayTurnResult' || state.state !== 'completed') return null;
    const catalog = replyCatalog?.engineId === turn.engineId ? replyCatalog : await this.catalog(turn.engineId).catch(() => undefined);
    return { body: state.body, usage: state.usage,
        model: (state.modelInfo?.effective.id && feishuModelIdSchema.safeParse(state.modelInfo.effective.id).success
          ? state.modelInfo.effective.id : turn.preferences?.modelId) ?? turn.engineId,
        executionLine: feishuEngineReplyLine(turn.engineId, turn.preferences, state.contextCompactionCount, state.modelInfo, catalog),
        taskId: turn.taskId, taskTitle: turn.taskTitle };
  }
}
