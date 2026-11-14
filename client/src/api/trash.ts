import type {
  TrashDeleteResponseDto,
  TrashImpactDto,
  TrashProjectDeleteRequest,
  TrashProjectListResponseDto,
  TrashRestoreResponseDto,
  TrashSessionDeleteRequest,
  TrashSessionListResponseDto,
} from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export const TRASH_PAGE_SIZE = 30;

export function listTrashProjects(limit = TRASH_PAGE_SIZE, offset = 0, query = ''): Promise<TrashProjectListResponseDto> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (query) params.set('q', query);
  return requestJson(`/api/trash/projects?${params}`);
}
export function listTrashSessions(limit = TRASH_PAGE_SIZE, offset = 0, query = '', projectId = ''): Promise<TrashSessionListResponseDto> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (query) params.set('q', query);
  if (projectId) params.set('projectId', projectId);
  return requestJson(`/api/trash/sessions?${params}`);
}
export type TrashSessionProject = { id: string; name: string; path: string };
export function listTrashSessionProjects(): Promise<TrashSessionProject[]> {
  return requestJson('/api/trash/session-projects');
}
export function listTrashSessionMatches(sessionId: string, query: string, offset = 0): Promise<{ items: TrashMessagePreview[]; total: number }> {
  const params = new URLSearchParams({ q: query, offset: String(offset) });
  return requestJson(`/api/trash/sessions/${encodeURIComponent(sessionId)}/matches?${params}`);
}
export function listTrashProjectSessions(projectId: string, limit = 100, offset = 0): Promise<TrashSessionListResponseDto> {
  return requestJson(`/api/trash/projects/${encodeURIComponent(projectId)}/sessions?limit=${limit}&offset=${offset}`);
}
export type TrashMessagePreview = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: number };
export function getTrashSessionPreview(sessionId: string): Promise<TrashMessagePreview[]> {
  return requestJson(`/api/trash/sessions/${encodeURIComponent(sessionId)}/preview`);
}
export function restoreTrashProject(projectId: string): Promise<TrashRestoreResponseDto> {
  return requestJson(`/api/trash/projects/${encodeURIComponent(projectId)}/restore`, { method: 'POST' });
}
export function restoreTrashSession(sessionId: string): Promise<TrashRestoreResponseDto> {
  return requestJson(`/api/trash/sessions/${encodeURIComponent(sessionId)}/restore`, { method: 'POST' });
}
export function getTrashProjectImpact(projectId: string): Promise<TrashImpactDto> {
  return requestJson(`/api/trash/projects/${encodeURIComponent(projectId)}/impact`);
}
export function getTrashSessionImpact(sessionId: string): Promise<TrashImpactDto> {
  return requestJson(`/api/trash/sessions/${encodeURIComponent(sessionId)}/impact`);
}
export function permanentlyDeleteTrashProject(projectId: string, input: TrashProjectDeleteRequest): Promise<TrashDeleteResponseDto> {
  return requestJson(`/api/trash/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE', ...jsonBody(input) });
}
export function permanentlyDeleteTrashSession(sessionId: string, input: TrashSessionDeleteRequest): Promise<TrashDeleteResponseDto> {
  return requestJson(`/api/trash/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', ...jsonBody(input) });
}
