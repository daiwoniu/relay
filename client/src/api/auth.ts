import { jsonBody, requestJson } from './client';
import type { AuthResponseDto, EngineId, OkDto, PublicUserDto, UserListResponseDto, UserResponseDto } from '../generated/relay-contracts';

export type AuthUser = PublicUserDto;

export function getCurrentUser(signal?: AbortSignal, timeoutMs = 8_000): Promise<AuthResponseDto> {
  return requestJson('/api/auth/me', { notifyUnauthorized: false, signal, timeoutMs });
}

export function login(username: string, password: string): Promise<AuthResponseDto> {
  return requestJson('/api/auth/login', {
    method: 'POST',
    notifyUnauthorized: false,
    ...jsonBody({ username, password }),
  });
}

export function logout(): Promise<OkDto> {
  return requestJson('/api/auth/logout', { method: 'POST', notifyUnauthorized: false });
}

export function updateProfile(displayName: string): Promise<UserResponseDto> {
  return requestJson('/api/auth/profile', { analytics:{feature:'settings',action:'save',surface:'settings'},method: 'PATCH', ...jsonBody({ displayName }) });
}

export function uploadAvatar(blob: Blob): Promise<UserResponseDto> {
  return requestJson('/api/auth/avatar', {
    analytics:{feature:'settings',action:'save',surface:'settings'},
    method: 'PUT',
    headers: { 'Content-Type': blob.type },
    body: blob,
  });
}

export function removeAvatar(): Promise<UserResponseDto> {
  return requestJson('/api/auth/avatar', { analytics:{feature:'settings',action:'save',surface:'settings'},method: 'DELETE' });
}

export function changePassword(currentPassword: string, newPassword: string): Promise<OkDto> {
  return requestJson('/api/auth/change-password', {
    analytics:{feature:'auth',action:'change_password',surface:'settings'},
    method: 'POST',
    notifyUnauthorized: false,
    ...jsonBody({ currentPassword, newPassword }),
  });
}

export function changeUsername(username: string, currentPassword: string): Promise<UserResponseDto> {
  return requestJson('/api/auth/change-username', {
    analytics:{feature:'auth',action:'change_username',surface:'settings'},
    method: 'POST',
    ...jsonBody({ username, currentPassword }),
  });
}

export function listUsers(): Promise<UserListResponseDto> {
  return requestJson('/api/auth/users');
}

export function createMember(input: { username: string; initialPassword: string; displayName?: string; canCreateProject?: boolean; projectIds?: string[] }): Promise<UserResponseDto> {
  return requestJson('/api/auth/users', { analytics:{feature:'account_admin',action:'create',surface:'admin'},method: 'POST', ...jsonBody(input) });
}

export function setUserDisabled(userId: string, disabled: boolean): Promise<UserResponseDto> {
  return requestJson(`/api/auth/users/${encodeURIComponent(userId)}/disabled`, {
    analytics:{feature:'account_admin',action:disabled?'disable':'enable',surface:'admin'},
    method: 'PATCH', ...jsonBody({ disabled }),
  });
}
export function setUserCanCreateProject(userId: string, canCreateProject: boolean): Promise<UserResponseDto> {
  return requestJson(`/api/auth/users/${encodeURIComponent(userId)}/project-permission`, { analytics:{feature:'account_admin',action:'change_project_permission',surface:'admin'},method: 'PATCH', ...jsonBody({ canCreateProject }) });
}

export function setDefaultProject(projectId: string): Promise<UserResponseDto> {
  return requestJson('/api/auth/default-project', { analytics:{feature:'settings',action:'save',surface:'settings',settingKey:'default_project'},method: 'PATCH', ...jsonBody({ projectId }) });
}

export function setDefaultEngine(engine: EngineId): Promise<UserResponseDto> {
  return requestJson('/api/auth/default-engine', { analytics:{feature:'settings',action:'save',surface:'settings',settingKey:'default_engine'},method: 'PATCH', ...jsonBody({ engine }) });
}

export function setDefaultModel(modelId: string | null): Promise<UserResponseDto> {
  return requestJson('/api/auth/default-model', { analytics:{feature:'settings',action:'save',surface:'settings',settingKey:'default_model'},method: 'PATCH', ...jsonBody({ modelId }) });
}

export function resetUserPassword(userId: string, currentPassword: string, newPassword: string): Promise<OkDto> {
  return requestJson(`/api/auth/users/${encodeURIComponent(userId)}/reset-password`, {
    analytics:{feature:'account_admin',action:'reset_password',surface:'admin'},
    method: 'POST',
    ...jsonBody({ currentPassword, newPassword }),
  });
}

export function getUserAvatarUrl(user: Pick<PublicUserDto, 'id' | 'avatarUpdatedAt'>): string | null {
  return user.avatarUpdatedAt === null
    ? null
    : `/api/auth/users/${encodeURIComponent(user.id)}/avatar?v=${user.avatarUpdatedAt}`;
}
