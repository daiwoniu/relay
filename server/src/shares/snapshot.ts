import {
  ShareSnapshotV1Schema,
  type CreateShareRequest,
  type ProcessItemDto,
  type ProcessTimelineEntryDto,
  type ShareSnapshotMessage,
  type ShareSnapshotV1,
} from '../contracts/index.js';
import type { Message } from '../db/queries.js';
import type { EngineId } from '../db/query-types.js';
import { presentMessage, type AttachmentAvailability } from '../messages/presenter.js';
import { sanitizeCodexFileDirectives } from './codex-directive-sanitizer.js';

function sanitizeSharedChangedFiles(changedFiles: NonNullable<ReturnType<typeof presentMessage>['changedFiles']>) {
  return changedFiles.map((file) => {
    if (!file.external) return file;
    const fileName = file.path.replaceAll('\\', '/').split('/').filter(Boolean).pop() || '未命名文件';
    const { external: _external, ...safeFile } = file;
    return { ...safeFile, path: `外部文件/${fileName}` };
  });
}

const FILE_PATH_DETAIL_KEYS = new Set(['path', 'filePath', 'file', 'cwd', 'agentPath']);

function sanitizeSharedProcessPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/)/.test(normalized)) return value;
  const fileName = normalized.split('/').filter(Boolean).pop() || '未命名文件';
  return `文件/${fileName}`;
}

const SAFE_PROCESS_DETAIL_KEYS = new Set([
  'title', 'summary', 'content', 'text', 'command', 'cwd', 'aggregatedOutput', 'outputSummary',
  'query', 'searchQuery', 'path', 'filePath', 'file', 'diff', 'patch',
  'changeType', 'action', 'kind', 'name', 'toolName', 'tool', 'result', 'output',
  'agentName', 'agentPath', 'exitCode', 'durationMs', 'duration', 'message', 'reason',
  'fromModel', 'toModel', 'range', 'files', 'fileChanges', 'changes', 'commandActions',
  'planCount', 'plan', 'explanation',
  'interactionKind', 'resolvedAction', 'decisionSource', 'effectiveScope', 'decidedAt',
  'firstObservedAt', 'startedObservedAt', 'completedObservedAt',
]);

const SAFE_NESTED_DETAIL_KEYS = new Set([
  'path', 'filePath', 'file', 'command', 'status', 'message', 'summary', 'text',
  'content', 'exitCode', 'duration', 'durationMs', 'changeType', 'name', 'type',
  'source', 'lineCount', 'charCount', 'firstLine', 'lastLine', 'truncated', 'step',
]);

function sanitizeDisplayValue(
  value: unknown,
  depth = 0,
  redactFilePaths = true,
  fieldName = '',
): unknown {
  if (depth > 4) return undefined;
  if (typeof value === 'string') {
    return redactFilePaths && FILE_PATH_DETAIL_KEYS.has(fieldName)
      ? sanitizeSharedProcessPath(value)
      : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const sanitized = sanitizeDisplayValue(entry, depth + 1, redactFilePaths, fieldName);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|cookie|authorization|credential|requestid/i.test(key)) continue;
    if (!SAFE_NESTED_DETAIL_KEYS.has(key)) continue;
    const sanitized = sanitizeDisplayValue(entry, depth + 1, redactFilePaths, key);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function sanitizeProcessItems(items: ProcessItemDto[] | undefined): ProcessItemDto[] | undefined {
  if (!items?.length) return undefined;
  const sanitized = items.flatMap((item) => {
    if (item.status === 'in_progress') return [];
    const details: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item.details)) {
      if (!SAFE_PROCESS_DETAIL_KEYS.has(key)) continue;
      const safeValue = sanitizeDisplayValue(value, 0, true, key);
      if (safeValue !== undefined) details[key] = safeValue;
    }
    return [{ id: item.id, type: item.type, status: item.status, details } satisfies ProcessItemDto];
  });
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeTimeline(
  timeline: ProcessTimelineEntryDto[] | undefined,
  items: ProcessItemDto[] | undefined,
): ProcessTimelineEntryDto[] | undefined {
  if (!timeline?.length) return undefined;
  const itemIds = new Set(items?.map((item) => item.id) || []);
  const sanitized = timeline.filter((entry) => entry.type === 'narrative' || itemIds.has(entry.itemId));
  return sanitized.length > 0 ? sanitized : undefined;
}

function findCompletedAssistantCutoff(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = presentMessage(messages[index]);
    if (message.role === 'assistant' && message.outcome === 'completed') return index;
  }
  throw new Error('当前会话没有可分享的已完成助手回复');
}

export function presentSharedMessage(message: Message, includeProcess: boolean, attachmentAvailability?: AttachmentAvailability): ShareSnapshotMessage | undefined {
  const presented = presentMessage(message, { attachmentAvailability });
  if (presented.role !== 'user' && presented.role !== 'assistant') return undefined;
  const processItems = includeProcess ? sanitizeProcessItems(presented.items) : undefined;
  const processTimeline = includeProcess ? sanitizeTimeline(presented.processTimeline, processItems) : undefined;
  return {
    id: presented.id,
    ...(message.turn_id ? { turnId: message.turn_id } : {}),
    role: presented.role,
    content: presented.role === 'assistant'
      ? sanitizeCodexFileDirectives(presented.content)
      : presented.content,
    createdAt: presented.created_at,
    ...(presented.duration !== null ? { duration: presented.duration } : {}),
    ...(presented.role === 'assistant' && presented.outcome ? { outcome: presented.outcome } : {}),
    ...(presented.role === 'assistant' && presented.modelInfo ? { modelInfo: presented.modelInfo } : {}),
    ...(includeProcess && presented.processContent ? { processContent: presented.processContent } : {}),
    ...(processItems ? { processItems } : {}),
    ...(processTimeline ? { processTimeline } : {}),
    ...(includeProcess && presented.changedFiles?.length
      ? { changedFiles: sanitizeSharedChangedFiles(presented.changedFiles) }
      : {}),
    ...(includeProcess && presented.changedFilesIncomplete === true
      ? { changedFilesIncomplete: true }
      : {}),
    ...(presented.attachments?.length ? {
      attachments: presented.attachments.map((attachment) => attachment.kind === 'host_file'
        ? { id: attachment.id, kind: attachment.kind, name: attachment.name, size: attachment.size }
        : {
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          size: attachment.size,
          mimeType: attachment.mimeType,
          available: attachment.available,
        }),
    } : {}),
  };
}

export function buildShareSnapshot(
  messages: Message[],
  request: Pick<CreateShareRequest, 'scope' | 'includeProcess'> & { messageIds?: string[]; sourceEngine?: EngineId },
): ShareSnapshotV1 {
  const cutoff = findCompletedAssistantCutoff(messages);
  const eligible = messages.slice(0, cutoff + 1);
  const eligibleIds = new Set(eligible.map((message) => message.id));
  const requestedIds = request.scope === 'session' ? undefined : request.messageIds || [];
  if (requestedIds && requestedIds.some((id) => !eligibleIds.has(id))) {
    throw new Error('所选消息超出可分享截止线或不存在');
  }
  const selectedIds = requestedIds ? new Set(requestedIds) : undefined;
  const snapshotMessages = eligible.flatMap((message) => {
    if (selectedIds && !selectedIds.has(message.id)) return [];
    const snapshotMessage = presentSharedMessage(message, request.includeProcess);
    return snapshotMessage ? [snapshotMessage] : [];
  });
  if (snapshotMessages.length === 0) throw new Error('没有可分享的消息');
  return ShareSnapshotV1Schema.parse({ version: 1, scope: request.scope, includeProcess: request.includeProcess, sourceEngine: request.sourceEngine ?? 'codex', messages: snapshotMessages });
}

export function readShareSnapshot(snapshotVersion: number, snapshotJson: string): ShareSnapshotV1 {
  if (snapshotVersion !== 1) throw new Error(`不支持的分享快照版本：${snapshotVersion}`);
  const snapshot = ShareSnapshotV1Schema.parse(JSON.parse(snapshotJson));
  return {
    ...snapshot,
    sourceEngine: snapshot.sourceEngine ?? 'codex',
    messages: snapshot.messages.map((message) => message.role === 'assistant'
      ? { ...message, content: sanitizeCodexFileDirectives(message.content) }
      : message),
  };
}
