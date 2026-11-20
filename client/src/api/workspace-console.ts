import { requestJson } from './client';
import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto, WorkspaceOperationRecordsDto, WorkspaceTaskSessionLinkResponseDto } from '../generated/relay-contracts';

export function getWorkspaceConsoleDashboard(signal?: AbortSignal, force = false): Promise<WorkspaceConsoleDashboardDto> {
  return requestJson<WorkspaceConsoleDashboardDto>(`/api/admin/workspace-console/dashboard${force ? '?refresh=1' : ''}`, { signal, timeoutMs: 12_000, cache: 'no-store' });
}

export type ResponsibilityRefreshTrigger = 'open' | 'auto' | 'retry' | 'manual' | 'detail';
export function getWorkspaceConsoleResponsibility(signal?: AbortSignal, force = false,
  trigger: ResponsibilityRefreshTrigger = 'open', taskId?:string): Promise<WorkspaceConsoleResponsibilityDto> {
  const query = new URLSearchParams({ trigger });
  if (force) query.set('refresh', '1');
  if(taskId)query.set('taskId',taskId);
  return requestJson<WorkspaceConsoleResponsibilityDto>(`/api/admin/workspace-console/responsibility?${query}`, { ...(trigger==='manual'||trigger==='retry'?{analytics:{feature:'workbench' as const,action:'refresh',surface:'workbench' as const}}:{}),signal, timeoutMs: 100_000, cache: 'no-store' });
}

export function getWorkspaceOperationRecords(parentId: string, anchor: string, cursor?: string | null,
  signal?: AbortSignal, force = false): Promise<WorkspaceOperationRecordsDto> {
  const query = new URLSearchParams({ anchor });
  if (cursor) query.set('cursor', cursor);
  if (force) query.set('refresh', '1');
  return requestJson<WorkspaceOperationRecordsDto>(`/api/admin/workspace-console/operations/${encodeURIComponent(parentId)}?${query}`,
    { signal, timeoutMs: 25_000, cache: 'no-store' });
}

export function linkWorkspaceTaskSession(taskId: string, sessionId: string,targetRef?:string): Promise<WorkspaceTaskSessionLinkResponseDto> {
  return requestJson(`/api/admin/workspace-console/tasks/${encodeURIComponent(taskId)}/sessions`, {
    analytics:{feature:'workbench',action:'link_session',surface:'workbench'},
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId,...(targetRef?{targetRef}:{}) }), timeoutMs: 12_000,
  });
}

export function unlinkWorkspaceTaskSession(taskId: string, sessionId: string,targetRef?:string): Promise<WorkspaceTaskSessionLinkResponseDto> {
  return requestJson(`/api/admin/workspace-console/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}${targetRef?`?targetRef=${encodeURIComponent(targetRef)}`:''}`, {
    analytics:{feature:'workbench',action:'unlink_session',surface:'workbench'},
    method: 'DELETE', timeoutMs: 12_000,
  });
}
