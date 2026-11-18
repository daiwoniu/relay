import type {
  EngineId,
  EnginePreferencesDto,
  MessageDto,
  MessageDetailsDto,
  SubAgentReportDto,
  MessageCursorDto,
  MessagePageResultDto,
  OkDto,
  SessionDto,
  SessionDetailsDto,
  SessionDeletionImpactDto,
  SessionMessageMatchesResponseDto,
  SessionSearchResponseDto,
  SessionUpdateResponseDto,
} from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';
import { cancelLocalResourceDeletion, markLocalResourceDeletion } from '../stores/resource-deletion-notice';

export const MESSAGE_PAGE_SIZE = 30;

export function getSubAgentReport(sessionId: string, messageId: string, itemId: string, signal: AbortSignal): Promise<SubAgentReportDto> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/subagent-report?${new URLSearchParams({ itemId })}`, {
    // Codex allows 10 s each for connection, initialization and reading; leave room for permission checks.
    signal, timeoutMs: 35_000, cache: 'no-store',
  });
}

interface ListMessagesOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  details?: 'full' | 'summary';
}

export function listSessions(signal?: AbortSignal, timeoutMs = 8_000): Promise<SessionDto[]> {
  return requestJson('/api/sessions', { signal, timeoutMs });
}

export function getSession(
  sessionId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SessionDetailsDto> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 8_000,
  });
}

export function getSessionDeletionImpact(sessionId: string): Promise<SessionDeletionImpactDto> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/deletion-impact`);
}

export function searchSessions(query: string, limit = 50): Promise<SessionSearchResponseDto> {
  return requestJson(`/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export function searchSessionMessages(
  sessionId: string,
  query: string,
  limit = 500,
  options: { includeProcess?: boolean; includeOperations?: boolean } = {},
): Promise<SessionMessageMatchesResponseDto> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (options.includeProcess) params.set('includeProcess', '1');
  if (options.includeOperations) params.set('includeOperations', '1');
  return requestJson(`/api/sessions/${sessionId}/search-matches?${params.toString()}`);
}

export function listMessages(
  sessionId: string,
  limit = MESSAGE_PAGE_SIZE,
  offset = 0,
  options: ListMessagesOptions = {},
): Promise<MessageDto[]> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (options.details === 'summary') params.set('details', '0');
  return requestJson(`/api/sessions/${sessionId}/messages?${params.toString()}`, {
    cache: 'no-store',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

export function getMessagePage(
  sessionId: string,
  options: {
    limit?: number;
    knownRevision?: number | null;
    cursor?: MessageCursorDto | null;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<MessagePageResultDto> {
  const params = new URLSearchParams({ limit: String(options.limit ?? MESSAGE_PAGE_SIZE) });
  if (options.cursor) {
    params.set('beforeCreatedAt', String(options.cursor.beforeCreatedAt));
    params.set('beforeId', options.cursor.beforeId);
  } else if (options.knownRevision !== undefined && options.knownRevision !== null) {
    params.set('knownRevision', String(options.knownRevision));
  }
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/message-page?${params.toString()}`, {
    cache: 'no-store',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

export function getMessageDetails(
  sessionId: string,
  messageId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MessageDetailsDto> {
  return requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/details`,
    { cache: 'no-store', signal: options.signal, timeoutMs: options.timeoutMs ?? 8_000 },
  );
}

export function createSession(projectId: string | null, title?: string, engine: EngineId | null = null): Promise<SessionDto> {
  return requestJson('/api/sessions', {
    method: 'POST',
    ...jsonBody({ projectId, engine, ...(title ? { title } : {}) }),
  });
}

export function forkSession(id: string, messageId?: string): Promise<SessionUpdateResponseDto> {
  return requestJson(`/api/sessions/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
    ...jsonBody(messageId ? { messageId } : {}),
  });
}

export function updateSession(
  id: string,
  updates: { title?: string; pinned?: 0 | 1; archived?: 0 | 1; project_id?: string | null },
): Promise<SessionUpdateResponseDto> {
  return requestJson(`/api/sessions/${id}`, { method: 'PATCH', ...jsonBody(updates) });
}

export function updateSessionEnginePreferences(
  id: string,
  preferences: Pick<EnginePreferencesDto, 'modelId' | 'reasoningEffort' | 'serviceTier'> & { expectedRevision: number },
): Promise<SessionUpdateResponseDto> {
  return requestJson(`/api/sessions/${encodeURIComponent(id)}/engine-preferences`, {
    method: 'PATCH', ...jsonBody(preferences),
  });
}

export async function deleteSession(id: string): Promise<OkDto> {
  markLocalResourceDeletion('session', id);
  try { return await requestJson(`/api/sessions/${id}`, { method: 'DELETE' }); }
  catch (error) { cancelLocalResourceDeletion('session', id); throw error; }
}

export function unarchiveSession(id: string): Promise<SessionUpdateResponseDto> {
  return requestJson(`/api/sessions/${id}/unarchive`, { method: 'POST' });
}
