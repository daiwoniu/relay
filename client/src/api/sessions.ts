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

export async function listSessions(signal?: AbortSignal, timeoutMs = 8_000): Promise<SessionDto[]> {
  const limit = 100;
  const sessions: SessionDto[] = [];
  let afterId = '';
  for (;;) {
    signal?.throwIfAborted();
    const query = new URLSearchParams({ limit: String(limit), afterId });
    const page = await requestJson<SessionDto[]>(`/api/sessions?${query}`, { signal, timeoutMs });
    sessions.push(...page);
    if (page.length < limit) break;
    const lastId = page[page.length - 1].id;
    if (lastId <= afterId) throw new Error('会话列表分页未前进');
    afterId = lastId;
  }
  return sessions.sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
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

export function searchSessions(query: string, { ownerUserId, signal }: { ownerUserId?: string | null; signal?: AbortSignal } = {}): Promise<SessionSearchResponseDto> {
  const params = new URLSearchParams({ q: query });
  if (ownerUserId) params.set('ownerUserId', ownerUserId);
  return requestJson(`/api/sessions/search?${params}`, { signal });
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
    analytics:{feature:'session',action:'create',surface:'sidebar'},
    method: 'POST',
    ...jsonBody({ projectId, engine, ...(title ? { title } : {}) }),
  });
}

export function forkSession(id: string, messageId?: string): Promise<SessionUpdateResponseDto> {
  return requestJson(`/api/sessions/${encodeURIComponent(id)}/fork`, {
    analytics:{feature:'session',action:'fork',surface:'message_menu'},
    method: 'POST',
    ...jsonBody(messageId ? { messageId } : {}),
  });
}

export function updateSession(
  id: string,
  updates: { title?: string; pinned?: 0 | 1; archived?: 0 | 1; project_id?: string | null },
): Promise<SessionUpdateResponseDto> {
  const action=Object.keys(updates).length>1?'update':updates.title!==undefined?'rename':updates.pinned!==undefined?updates.pinned?'pin':'unpin':'update';
  return requestJson(`/api/sessions/${id}`, { analytics:{feature:'session',action,surface:'context_menu'},method: 'PATCH', ...jsonBody(updates) });
}

export function updateSessionEnginePreferences(
  id: string,
  preferences: Pick<EnginePreferencesDto, 'modelId' | 'reasoningEffort' | 'serviceTier'> & { expectedRevision: number },
): Promise<SessionUpdateResponseDto> {
  return requestJson(`/api/sessions/${encodeURIComponent(id)}/engine-preferences`, {
    analytics:{feature:'composer',action:'apply_model',surface:'composer'},
    method: 'PATCH', ...jsonBody(preferences),
  });
}

export async function deleteSession(id: string): Promise<OkDto> {
  markLocalResourceDeletion('session', id);
  try { return await requestJson(`/api/sessions/${id}`, { analytics:{feature:'trash',action:'delete',surface:'sidebar'},method: 'DELETE' }); }
  catch (error) { cancelLocalResourceDeletion('session', id); throw error; }
}

export function unarchiveSession(id: string): Promise<SessionUpdateResponseDto> {
  return requestJson(`/api/sessions/${id}/unarchive`, { analytics:{feature:'session',action:'unarchive',surface:'context_menu'},method: 'POST' });
}
