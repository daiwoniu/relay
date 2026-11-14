import type { ApiErrorDto, OkDto, ProjectDeletionImpactDto, ProjectDto, TrashRestoreResponseDto, UserListResponseDto } from '../generated/relay-contracts';
import { ApiError, jsonBody, requestJson } from './client';
import { cancelLocalResourceDeletion, markLocalResourceDeletion } from '../stores/resource-deletion-notice';

export function getProjectInTrashConflict(error: unknown): NonNullable<ApiErrorDto['projectInTrash']> | null {
  return error instanceof ApiError && error.status === 409 && error.data?.code === 'PROJECT_IN_TRASH'
    ? error.data.projectInTrash ?? null
    : null;
}

export function listProjects(signal?: AbortSignal, timeoutMs = 8_000): Promise<ProjectDto[]> {
  return requestJson('/api/projects', { signal, timeoutMs });
}

export function createProject(path: string, name?: string): Promise<ProjectDto> {
  return requestJson('/api/projects', {
    method: 'POST',
    ...jsonBody(name ? { path, name } : { path }),
  });
}

export function updateProject(id: string, updates: { name?: string; pinned?: 0 | 1; deletion_protected?: 0 | 1 }): Promise<OkDto> {
  return requestJson(`/api/projects/${id}`, { method: 'PATCH', ...jsonBody(updates) });
}

export type ProjectMemberRole = 'viewer' | 'collaborator' | 'manager';
export interface ProjectMemberDto { user_id: string; role: ProjectMemberRole; can_view_sessions?: 0 | 1; }
export function listProjectMembers(id: string): Promise<ProjectMemberDto[]> { return requestJson(`/api/projects/${encodeURIComponent(id)}/members`); }
export function listProjectMemberCandidates(id: string): Promise<UserListResponseDto> { return requestJson(`/api/projects/${encodeURIComponent(id)}/members/candidates`); }
export function setProjectMember(id: string, userId: string, role: ProjectMemberRole, canViewSessions?: 0 | 1): Promise<{ ok: true }> {
  return requestJson(`/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    ...jsonBody({ role, ...(canViewSessions === undefined ? {} : { can_view_sessions: canViewSessions }) }),
  });
}
export function removeProjectMember(id: string, userId: string): Promise<{ ok: true }> {
  return requestJson(`/api/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

export async function deleteProject(id: string): Promise<OkDto> {
  markLocalResourceDeletion('project', id);
  try { return await requestJson(`/api/projects/${id}`, { method: 'DELETE' }); }
  catch (error) { cancelLocalResourceDeletion('project', id); throw error; }
}

export function getProjectDeletionImpact(id: string): Promise<ProjectDeletionImpactDto> {
  return requestJson(`/api/projects/${encodeURIComponent(id)}/deletion-impact`);
}

export function restoreProjectFromTrash(id: string): Promise<TrashRestoreResponseDto> {
  return requestJson(`/api/trash/projects/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}
