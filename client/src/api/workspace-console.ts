import { requestJson } from './client';
import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto, WorkspaceOperationRecordsDto, WorkspaceTaskSessionLinkResponseDto } from '../generated/relay-contracts';

export function getWorkspaceConsoleDashboard(signal?: AbortSignal, force = false): Promise<WorkspaceConsoleDashboardDto> {
  return requestJson<WorkspaceConsoleDashboardDto>(`/api/admin/workspace-console/dashboard${force ? '?refresh=1' : ''}`, { signal, timeoutMs: 12_000, cache: 'no-store' });
}

export type ResponsibilityRefreshTrigger = 'open' | 'auto' | 'retry' | 'manual' | 'detail';
export function getWorkspaceConsoleResponsibility(signal?: AbortSignal, force = false,
  trigger: ResponsibilityRefreshTrigger = 'open'): Promise<WorkspaceConsoleResponsibilityDto> {
  const query = new URLSearchParams({ trigger });
  if (force) query.set('refresh', '1');
  return requestJson<WorkspaceConsoleResponsibilityDto>(`/api/admin/workspace-console/responsibility?${query}`, { signal, timeoutMs: 100_000, cache: 'no-store' });
}

export function getWorkspaceOperationRecords(parentId: string, anchor: string, cursor?: string | null,
  signal?: AbortSignal, force = false): Promise<WorkspaceOperationRecordsDto> {
  const query = new URLSearchParams({ anchor });
  if (cursor) query.set('cursor', cursor);
  if (force) query.set('refresh', '1');
  return requestJson<WorkspaceOperationRecordsDto>(`/api/admin/workspace-console/operations/${encodeURIComponent(parentId)}?${query}`,
    { signal, timeoutMs: 25_000, cache: 'no-store' });
}

export function linkWorkspaceTaskSession(taskId: string, sessionId: string): Promise<WorkspaceTaskSessionLinkResponseDto> {
  return requestJson(`/api/admin/workspace-console/tasks/${encodeURIComponent(taskId)}/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }), timeoutMs: 12_000,
  });
}

export function unlinkWorkspaceTaskSession(taskId: string, sessionId: string): Promise<WorkspaceTaskSessionLinkResponseDto> {
  return requestJson(`/api/admin/workspace-console/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE', timeoutMs: 12_000,
  });
}
