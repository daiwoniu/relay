import type { MessageDto, MessagePageDto, MessageSummaryDto } from '../generated/relay-contracts.ts';

export const MESSAGE_CACHE_MAX_SESSIONS = 20;
export const MESSAGE_CACHE_TOTAL_BYTES = 20 * 1024 * 1024;
export const MESSAGE_CACHE_SESSION_BYTES = 2 * 1024 * 1024;
export const MESSAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CachedMessageSummary = Omit<MessageSummaryDto, 'attachments'>;

export interface CachedMessagePage extends Omit<MessagePageDto, 'messages'> {
  messages: CachedMessageSummary[];
}

export interface CachePolicyRecord {
  key: string;
  sizeBytes: number;
  lastAccessedAt: number;
  createdAt: number;
}

export function createMessageCacheKey(userId: string, protocolVersion: number, sessionId: string): string {
  return `${userId}:${protocolVersion}:${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

export function isCompatibleMessageCachePage(page: unknown): page is CachedMessagePage {
  if (!isRecord(page) || !Array.isArray(page.messages)) return false;
  return page.messages.every((message) => (
    isRecord(message)
    && typeof message.hasDetails === 'boolean'
    && isNonnegativeInteger(message.processItemCount)
    && isNonnegativeInteger(message.processNarrativeCount)
    && isNonnegativeInteger(message.changedFileCount)
  ));
}

export function sanitizeMessageSummary(message: MessageSummaryDto): CachedMessageSummary {
  const sanitized: CachedMessageSummary = {
    id: message.id,
    session_id: message.session_id,
    turn_id: message.turn_id,
    role: message.role,
    content: message.content,
    phase: message.phase,
    created_at: message.created_at,
    duration: message.duration,
    stopped: message.stopped,
    hasDetails: message.hasDetails,
    processItemCount: message.processItemCount,
    processNarrativeCount: message.processNarrativeCount,
    changedFileCount: message.changedFileCount,
  };
  if (message.isError !== undefined) sanitized.isError = message.isError;
  if (message.asyncQuestionIds?.length) sanitized.asyncQuestionIds = message.asyncQuestionIds;
  if (message.replyToAsyncQuestionId !== undefined) sanitized.replyToAsyncQuestionId = message.replyToAsyncQuestionId;
  if (message.executionStage !== undefined) sanitized.executionStage = message.executionStage;
  if (message.outcome !== undefined) sanitized.outcome = message.outcome;
  if (message.errorCode !== undefined) sanitized.errorCode = message.errorCode;
  if (message.errorMessage !== undefined) sanitized.errorMessage = message.errorMessage;
  if (message.tokenUsage !== undefined) sanitized.tokenUsage = message.tokenUsage;
  if (message.modelInfo !== undefined) sanitized.modelInfo = message.modelInfo;
  if (message.changedFilesIncomplete !== undefined) sanitized.changedFilesIncomplete = message.changedFilesIncomplete;
  return sanitized;
}

export function createCacheableMessageSummary(message: MessageDto | MessageSummaryDto): MessageSummaryDto {
  const summary = message as MessageSummaryDto;
  const detailed = message as MessageDto;
  const processItemCount = summary.processItemCount ?? detailed.items?.length ?? 0;
  const timelineNarrativeCount = detailed.processTimeline?.filter((entry) => entry.type === 'narrative').length ?? 0;
  const processNarrativeCount = summary.processNarrativeCount
    ?? (timelineNarrativeCount || (detailed.processContent ? 1 : 0));
  const changedFileCount = summary.changedFileCount ?? detailed.changedFiles?.length ?? 0;
  const asyncQuestionIds = summary.asyncQuestionIds ?? detailed.items?.filter((item) => item.type === 'interaction'
    && item.details.interactionKind === 'async_question' && item.status === 'in_progress').map((item) => item.id);
  return {
    ...sanitizeMessageSummary({
      ...message,
      ...(asyncQuestionIds?.length ? { asyncQuestionIds } : {}),
      hasDetails: summary.hasDetails ?? Boolean(
        processItemCount || processNarrativeCount || changedFileCount || detailed.processContent || detailed.processTimeline?.length
      ),
      processItemCount,
      processNarrativeCount,
      changedFileCount,
    }),
  };
}

export function sanitizeMessagePage(page: MessagePageDto): CachedMessagePage {
  return { ...page, messages: page.messages.map(sanitizeMessageSummary) };
}

export function estimateCacheBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function selectCacheRecordsToKeep<T extends CachePolicyRecord>(records: T[], now = Date.now()): T[] {
  const fresh = records
    .filter((record) => now - record.createdAt <= MESSAGE_CACHE_TTL_MS && record.sizeBytes <= MESSAGE_CACHE_SESSION_BYTES)
    .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
  const kept: T[] = [];
  let totalBytes = 0;
  for (const record of fresh) {
    if (kept.length >= MESSAGE_CACHE_MAX_SESSIONS) break;
    if (totalBytes + record.sizeBytes > MESSAGE_CACHE_TOTAL_BYTES) continue;
    kept.push(record);
    totalBytes += record.sizeBytes;
  }
  return kept;
}
