import fs from 'node:fs';
import type { Message } from '../db/queries.js';
import {
  MessageDtoSchema,
  MessageSummaryDtoSchema,
  ProcessItemDtoSchema,
  ApprovalDecisionSourceSchema,
  ApprovalDecisionScopeSchema,
  InteractionResolvedActionSchema,
  type MessageDto,
  type MessageSummaryDto,
  type ProcessItemDto,
  type ProcessItemStatus,
} from '../contracts/index.js';
import { parseMessageMetadata } from '../message-metadata.js';
import { hasIncompleteChangedFilesReport } from './changed-files.js';
import { presentPlan } from './plan.js';
import { parseRelayFileChangeReport } from './file-change-report.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROCESS_ITEM_STATUSES = new Set<ProcessItemStatus>(['in_progress', 'completed', 'incomplete']);
const COLLAB_AGENT_STATUSES = new Set([
  'pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound',
]);
const PROCESS_ITEM_DETAIL_KEYS = [
  'command', 'content', 'text', 'cwd', 'aggregatedOutput', 'outputSummary',
  'query', 'searchQuery', 'path', 'filePath', 'file',
  'diff', 'patch', 'summary', 'changeType', 'action', 'kind',
  'name', 'toolName', 'tool', 'arguments', 'input', 'params', 'result', 'output',
  'agentName', 'agentPath', 'agentThreadId', 'kind', 'prompt', 'exitCode', 'errorCode', 'failureCode', 'durationMs', 'duration',
  'interactionKind', 'requestId', 'method', 'title', 'message', 'reason', 'sourceItemId',
  'grantRoot', 'permissions', 'availableDecisions', 'questions', 'autoResolutionMs',
  'requestedSchema', 'mode', 'url', 'serverName', 'noticeType',
  'fromModel', 'toModel', 'range',
  'networkApprovalContext', 'additionalPermissions', 'proposedExecpolicyAmendment',
  'proposedNetworkPolicyAmendments', 'fileChanges',
] as const;

function presentProcessItemDetails(source: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const key of PROCESS_ITEM_DETAIL_KEYS) {
    if (source[key] !== undefined) details[key] = source[key];
  }
  for (const key of ['server', 'serverName'] as const) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) details[key] = value.trim().slice(0, 256);
    else delete details[key];
  }
  if (typeof source.readOnlyHint === 'boolean') details.readOnlyHint = source.readOnlyHint;
  if (typeof source.success === 'boolean') details.success = source.success;
  for (const key of ['firstObservedAt', 'startedObservedAt', 'completedObservedAt']) {
    const value = source[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) details[key] = value;
  }
  const resolvedAction = InteractionResolvedActionSchema.safeParse(source.resolvedAction);
  if (resolvedAction.success) details.resolvedAction = resolvedAction.data;
  const decisionSource = ApprovalDecisionSourceSchema.safeParse(source.decisionSource);
  const decidedAt = typeof source.decidedAt === 'number' ? source.decidedAt : Number.NaN;
  const trustExpiresAt = source.trustExpiresAt === null
    ? null
    : typeof source.trustExpiresAt === 'number' ? source.trustExpiresAt : Number.NaN;
  const decisionSourceValue = decisionSource.success ? decisionSource.data : null;
  const expectedScope = decisionSourceValue === 'session_trust'
    ? 'session'
    : decisionSourceValue === 'project_trust' ? 'project' : null;
  const parsedScope = ApprovalDecisionScopeSchema.safeParse(source.effectiveScope);
  const effectiveScope = source.effectiveScope === null ? null : parsedScope.success ? parsedScope.data : undefined;
  const validExpiry = trustExpiresAt === null || (Number.isInteger(trustExpiresAt) && trustExpiresAt >= 0);
  if (decisionSource.success && Number.isInteger(decidedAt) && decidedAt >= 0
    && effectiveScope === expectedScope && validExpiry
    && (expectedScope !== null || trustExpiresAt === null)) {
    details.decisionSource = decisionSource.data;
    details.effectiveScope = effectiveScope;
    details.trustExpiresAt = trustExpiresAt;
    details.decidedAt = decidedAt;
  }
  if (Array.isArray(source.commandActions)) {
    details.commandActions = source.commandActions.flatMap((action) => {
      if (!isRecord(action) || typeof action.command !== 'string') return [];
      return [{ command: action.command }];
    });
  }
  for (const key of ['changes', 'files', 'fileChanges'] as const) {
    if (!Array.isArray(source[key])) continue;
    const changes: unknown[] = [];
    for (const change of source[key]) {
      if (typeof change === 'string') {
        changes.push(change);
        continue;
      }
      if (!isRecord(change)) continue;
      const changeType = [change.changeType, change.type, isRecord(change.kind) ? change.kind.type : change.kind, change.action]
        .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim();
      const pathDetails = {
        ...(typeof change.path === 'string' ? { path: change.path } : {}),
        ...(typeof change.filePath === 'string' ? { filePath: change.filePath } : {}),
        ...(typeof change.file === 'string' ? { file: change.file } : {}),
        ...(changeType ? { changeType } : {}),
      };
      if (Object.keys(pathDetails).length > 0) changes.push(pathDetails);
    }
    details[key] = changes;
  }
  if (Array.isArray(source.plan)) {
    details.plan = presentPlan(source.plan);
    details.planCount = (details.plan as unknown[]).length;
  } else if (Number.isInteger(source.planCount) && Number(source.planCount) >= 0) {
    details.planCount = source.planCount;
  }
  if (typeof source.explanation === 'string') {
    details.explanation = source.explanation.trim().slice(0, 16 * 1024);
  }
  if (isRecord(source.agentsStates) || Array.isArray(source.agentResults)) {
    const rawResults = isRecord(source.agentsStates) ? Object.entries(source.agentsStates).flatMap(([threadId, state]) => isRecord(state) ? [{ ...state, threadId }] : []) : [];
    const agentResults = [...(Array.isArray(source.agentResults) ? source.agentResults : []), ...rawResults].flatMap((value) => {
      if (!isRecord(value) || typeof value.threadId !== 'string' || !value.threadId || !COLLAB_AGENT_STATUSES.has(String(value.status))) return [];
      return [{ threadId: value.threadId, status: String(value.status),
        ...(typeof value.message === 'string' && value.message.trim() ? { message: value.message.trim() } : {}),
        ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim().slice(0, 256) } : {}),
      }];
    });
    if (agentResults.length > 0) details.agentResults = [...new Map(agentResults.map(result => [result.threadId, result])).values()];
  }
  return details;
}

export function presentProcessItem(
  input: unknown,
  fallbackStatus: ProcessItemStatus = 'completed',
): ProcessItemDto | undefined {
  if (!isRecord(input)) return undefined;
  const source = isRecord(input.details) ? input.details : isRecord(input.raw) ? input.raw : input;
  const id = typeof input.id === 'string' ? input.id : typeof source.id === 'string' ? source.id : '';
  const type = typeof input.type === 'string' ? input.type : typeof source.type === 'string' ? source.type : '';
  const statusCandidate = input.status === 'failed' || source.status === 'failed' || type === 'dynamicToolCall' && source.success === false
    ? 'incomplete'
    : PROCESS_ITEM_STATUSES.has(input.status as ProcessItemStatus)
      ? input.status
      : PROCESS_ITEM_STATUSES.has(source.status as ProcessItemStatus)
        ? source.status
        : fallbackStatus;
  const details = presentProcessItemDetails(source);
  if (type === 'dynamicToolCall' && source.tool === 'relay_report_file_changes' && source.success === true
    && statusCandidate === 'completed' && !source.server && !source.serverName) {
    // Keep the bounded file metadata separately: long arguments are compacted for history.
    let report = parseRelayFileChangeReport({ version: 1, reportedFileChanges: source.fileChanges });
    if (!report) {
      try {
        const input = source.arguments ?? source.input ?? source.params;
        report = parseRelayFileChangeReport(typeof input === 'string' ? JSON.parse(input) : input);
      } catch { /* A truncated historical report cannot be reconstructed. */ }
    }
    if (report) details.fileChanges = report.reportedFileChanges;
  }
  if (type === 'imageGeneration' && typeof source.savedPath === 'string' && source.savedPath.trim()
    && source.savedPath.length <= 4096 && !/[\u0000-\u001F\u007F]/.test(source.savedPath)) details.savedPath = source.savedPath;
  // Generated images are delivered as files. Streaming and resync share this
  // projection, so neither may duplicate their base64 in process events.
  if (type === 'imageGeneration') {
    for (const key of ['result', 'output', 'aggregatedOutput']) delete details[key];
  }
  const parsed = ProcessItemDtoSchema.safeParse({
    id,
    type,
    status: statusCandidate,
    details,
  });
  return parsed.success ? parsed.data : undefined;
}

export function presentProcessItems(items: unknown[], fallbackStatus: ProcessItemStatus = 'completed'): ProcessItemDto[] {
  return items
    .map((item) => presentProcessItem(item, fallbackStatus))
    .filter((item): item is ProcessItemDto => Boolean(item));
}

export function parseMessageItems(items: string | null): ProcessItemDto[] | undefined {
  if (!items) return undefined;
  try {
    const parsed = JSON.parse(items);
    if (!Array.isArray(parsed)) return undefined;
    const presented = presentProcessItems(parsed);
    return presented.length > 0 ? presented : undefined;
  } catch {
    return undefined;
  }
}

export type AttachmentAvailability = (filename: string) => boolean;
function presentMessageWithItems(
  message: Message,
  includeDetails: boolean,
  parsedItems: ProcessItemDto[] | undefined,
  availability?: AttachmentAvailability,
): MessageDto {
  const items = includeDetails ? parsedItems : undefined;
  const metadata = parseMessageMetadata(message.metadata);
  const changedFilesIncomplete = metadata.changedFilesIncomplete === true
    || (message.role === 'assistant' && hasIncompleteChangedFilesReport(parsedItems ?? []));
  const isOperationRecord = message.phase === 'interaction'
    || (message.phase === 'final_answer' && !message.content.trim() && !message.stopped
      && (!metadata.outcome || metadata.outcome === 'completed'));
  const historicalOutcome = isOperationRecord ? undefined : message.phase === 'error'
    ? 'failed'
    : message.stopped === 1
      ? 'stopped'
      : message.role === 'assistant'
        ? 'completed'
        : undefined;
  const historicalStage = message.role === 'assistant'
    ? (message.content || metadata.processContent || message.items ? 'responding' : 'accepted')
    : undefined;
  return MessageDtoSchema.parse({
    id: message.id,
    session_id: message.session_id,
    turn_id: message.turn_id,
    role: message.role,
    ...(message.role === 'user' && metadata.replyToAsyncQuestionId
      ? { replyToAsyncQuestionId: metadata.replyToAsyncQuestionId }
      : {}),
    content: message.content,
    phase: message.phase,
    created_at: message.created_at,
    duration: message.duration,
    stopped: message.stopped === 1,
    ...(message.phase === 'error' ? { isError: true } : {}),
    ...(includeDetails && items ? { items } : {}),
    ...(includeDetails && metadata.processContent ? { processContent: metadata.processContent } : {}),
    ...(includeDetails && metadata.processTimeline?.length ? { processTimeline: metadata.processTimeline } : {}),
    ...(metadata.changedFiles?.length ? { changedFiles: metadata.changedFiles } : {}),
    ...(changedFilesIncomplete ? { changedFilesIncomplete: true } : {}),
    ...(metadata.executionStage || historicalStage ? { executionStage: metadata.executionStage || historicalStage } : {}),
    ...(!isOperationRecord && (metadata.outcome || historicalOutcome) ? { outcome: metadata.outcome || historicalOutcome } : {}),
    ...(metadata.errorCode ? { errorCode: metadata.errorCode } : {}),
    ...(metadata.errorMessage || message.phase === 'error'
      ? { errorMessage: metadata.errorMessage || message.content }
      : {}),
    ...(metadata.tokenUsage ? { tokenUsage: metadata.tokenUsage } : {}),
    ...(metadata.modelInfo ? { modelInfo: metadata.modelInfo } : {}),
    ...(message.role === 'user' && metadata.origin ? { origin: metadata.origin } : {}),
    ...(metadata.attachments?.length ? {
      attachments: metadata.attachments.map((attachment) => {
        if (attachment.kind === 'host_file') return attachment;
        if (availability) return { ...attachment, available: availability(attachment.path) };
        let available = false;
        try {
          const stat = fs.lstatSync(attachment.path);
          available = stat.isFile() && !stat.isSymbolicLink();
        } catch {}
        return { ...attachment, available };
      }),
    } : {}),
  });
}

export function presentMessage(message: Message, options: { includeDetails?: boolean; attachmentAvailability?: AttachmentAvailability } = {}): MessageDto {
  return presentMessageWithItems(message, options.includeDetails !== false, parseMessageItems(message.items), options.attachmentAvailability);
}

export function presentMessageSummary(message: Message, availability?: AttachmentAvailability): MessageSummaryDto {
  const items = parseMessageItems(message.items) ?? [];
  const asyncQuestionIds = items.filter((item) => item.type === 'interaction'
    && item.details.interactionKind === 'async_question'
    && item.status === 'in_progress').map((item) => item.id);
  const presented = presentMessageWithItems(message, false, items, availability);
  const metadata = parseMessageMetadata(message.metadata);
  const timelineNarrativeCount = metadata.processTimeline?.filter((entry) => entry.type === 'narrative').length ?? 0;
  const processNarrativeCount = timelineNarrativeCount || (metadata.processContent ? 1 : 0);
  const changedFileCount = metadata.changedFiles?.length ?? 0;
  const processItemCount = items.length;
  const historicalOperationRecord = presented.role === 'assistant'
    && ['interaction', 'final_answer'].includes(presented.phase ?? '')
    && !presented.content.trim() && !presented.stopped && !presented.isError && !presented.errorCode
    && (!presented.outcome || presented.outcome === 'completed')
    && !processNarrativeCount && !changedFileCount && !metadata.changedFilesIncomplete
    && processItemCount > 0 && items.every((item) => item.type === 'interaction' && item.status === 'completed');
  return MessageSummaryDtoSchema.parse({
    ...presented,
    historicalOperationRecord,
    ...(asyncQuestionIds.length ? { asyncQuestionIds } : {}),
    hasDetails: processItemCount > 0
      || processNarrativeCount > 0
      || Boolean(metadata.processContent)
      || Boolean(metadata.processTimeline?.length),
    processItemCount,
    processNarrativeCount,
    changedFileCount,
    ...(metadata.changedFiles?.length ? { changedFiles: metadata.changedFiles } : {}),
    ...(metadata.changedFilesIncomplete === true ? { changedFilesIncomplete: true } : {}),
  });
}
