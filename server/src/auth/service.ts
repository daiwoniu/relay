import * as queries from '../db/queries.js';
import type { AuthSession, User } from '../db/queries.js';
import type { EngineId } from '../db/query-types.js';
import type { UserRole } from '../db/user-role.js';
import { presentPublicUser, type PublicUserDto } from '../contracts/index.js';
import { hashPassword, verifyPassword } from './password.js';
import { ACCEPTANCE_SESSION_TTL_MS, SESSION_TTL_MS, createSessionToken, getSessionExpiry, hashSessionToken } from './session.js';
import { notifyAuthSessionRevoked, notifyUserAccessRevoked } from './revocation.js';

export interface AuthRepository {
  getUserByUsername(username: string): User | undefined;
  getUserById(userId: string): User | undefined;
  listUsers(): User[];
  createUser(username: string, passwordHash: string, role?: UserRole): User;
  setUserRole(userId: string, role: UserRole): User;
  updateUserUsernameAndDeleteOtherSessions(userId: string, username: string, retainedTokenHash: string): { user: User; tokenHashes: string[] };
  updateUserPassword(userId: string, passwordHash: string, mustChangePassword?: boolean): User;
  createMemberWithDefaultProject?(input: { username: string; passwordHash: string; displayName?: string | null; workspacePath: string; canCreateProject?: boolean; projectIds?: string[] }): { user: User };
  setUserDefaultProject?(userId: string, projectId: string): unknown;
  setUserDefaultEngine?(userId: string, engine: EngineId): unknown;
  setUserDefaultModel?(userId: string, modelId: string | null): unknown;
  setUserDisabled?(userId: string, disabledAt: number | null): User;
  setUserCanCreateProject?(userId: string, allowed: boolean): User;
  createAuthSession(session: AuthSession): void;
  getAuthSession(tokenHash: string): AuthSession | undefined;
  getAuthenticatedUser(tokenHash: string, now?: number): User | undefined;
  deleteAuthSession(tokenHash: string): void;
  deleteAuthSessionsByUserId(userId: string): string[];
  deleteExpiredAuthSessions(now?: number): void;
}

const databaseRepository: AuthRepository = {
  getUserByUsername: queries.getUserByUsername,
  getUserById: queries.getUserById,
  listUsers: queries.listUsers,
  createUser: queries.createUser,
  setUserRole: queries.setUserRole,
  updateUserUsernameAndDeleteOtherSessions: queries.updateUserUsernameAndDeleteOtherSessions,
  updateUserPassword: queries.updateUserPassword,
  createMemberWithDefaultProject: queries.createMemberWithDefaultProject,
  setUserDefaultProject: queries.setUserDefaultProject,
  setUserDefaultEngine: queries.setUserDefaultEngine,
  setUserDefaultModel: queries.setUserDefaultModel,
  setUserDisabled: queries.setUserDisabled,
  setUserCanCreateProject: queries.setUserCanCreateProject,
  createAuthSession: queries.createAuthSession,
  getAuthSession: queries.getAuthSession,
  getAuthenticatedUser: queries.getAuthenticatedUser,
  deleteAuthSession: queries.deleteAuthSession,
  deleteAuthSessionsByUserId: queries.deleteAuthSessionsByUserId,
  deleteExpiredAuthSessions: queries.deleteExpiredAuthSessions,
};

export function ensureDefaultAdmin(
  repository: AuthRepository = databaseRepository,
  credentials = {
    username: process.env.RELAY_ADMIN_USERNAME?.trim() || 'admin',
    password: process.env.RELAY_ADMIN_PASSWORD || 'admin',
  },
): PublicUserDto {
  const existing = repository.getUserByUsername(credentials.username);
  if (existing?.role === 'admin') return presentPublicUser(existing);
  const currentAdmin = repository.listUsers().find((user) => user.role === 'admin');
  if (currentAdmin) return presentPublicUser(currentAdmin);
  if (existing) return presentPublicUser(repository.setUserRole(existing.id, 'admin'));
  return presentPublicUser(repository.createUser(credentials.username, hashPassword(credentials.password), 'admin'));
}

export function loginWithPassword(
  username: string,
  password: string,
  repository: AuthRepository = databaseRepository,
  now = Date.now(),
  options: { ttlMs?: number; requiredRole?: UserRole } = {},
): { user: PublicUserDto; token: string; expiresAt: number; ttlMs: number } | null {
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  if (ttlMs === ACCEPTANCE_SESSION_TTL_MS && options.requiredRole !== 'admin') {
    throw new Error('验收长会话必须绑定管理员角色');
  }
  repository.deleteExpiredAuthSessions(now);
  const user = repository.getUserByUsername(username);
  if (!user || user.disabled_at != null || !verifyPassword(password, user.password_hash) || (options.requiredRole && user.role !== options.requiredRole)) return null;

  const { token, tokenHash } = createSessionToken();
  const expiresAt = getSessionExpiry(now, ttlMs);
  repository.createAuthSession({ token_hash: tokenHash, user_id: user.id, created_at: now, expires_at: expiresAt });
  return { user: presentPublicUser(user), token, expiresAt, ttlMs };
}

export function authenticateSessionToken(
  token: string | null | undefined,
  repository: AuthRepository = databaseRepository,
  now = Date.now(),
): PublicUserDto | null {
  if (!token) return null;
  const user = repository.getAuthenticatedUser(hashSessionToken(token), now);
  return user ? presentPublicUser(user) : null;
}

export function authenticateSessionDetails(
  token: string | null | undefined,
  repository: AuthRepository = databaseRepository,
  now = Date.now(),
): { user: PublicUserDto; tokenHash: string; expiresAt: number } | null {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = repository.getAuthSession(tokenHash);
  if (!session || session.expires_at <= now) return null;
  const user = repository.getAuthenticatedUser(tokenHash, now);
  return user ? { user: presentPublicUser(user), tokenHash, expiresAt: session.expires_at } : null;
}

export function logoutSessionToken(token: string | null | undefined, repository: AuthRepository = databaseRepository): void {
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  repository.deleteAuthSession(tokenHash);
  notifyAuthSessionRevoked(tokenHash);
}

export function cleanupExpiredLoginSessions(repository: AuthRepository = databaseRepository, now = Date.now()): void {
  repository.deleteExpiredAuthSessions(now);
}

export function revokeUserSessions(userId: string, repository: AuthRepository = databaseRepository): number {
  const tokenHashes = repository.deleteAuthSessionsByUserId(userId);
  for (const tokenHash of tokenHashes) notifyAuthSessionRevoked(tokenHash);
  notifyUserAccessRevoked(userId);
  return tokenHashes.length;
}

export type CreateMemberResult =
  | { ok: true; user: PublicUserDto }
  | { ok: false; reason: 'forbidden' | 'username_exists' | 'unsupported' };

export function createMemberByAdmin(
  adminUserId: string,
  input: { username: string; initialPassword: string; displayName?: string | null; workspacePath: string; canCreateProject?: boolean; projectIds?: string[] },
  repository: AuthRepository = databaseRepository,
): CreateMemberResult {
  const admin = repository.getUserById(adminUserId);
  if (!admin || admin.role !== 'admin') return { ok: false, reason: 'forbidden' };
  if (repository.getUserByUsername(input.username)) return { ok: false, reason: 'username_exists' };
  if (!repository.createMemberWithDefaultProject) return { ok: false, reason: 'unsupported' };
  try {
    const created = repository.createMemberWithDefaultProject({
      username: input.username,
      passwordHash: hashPassword(input.initialPassword),
      displayName: input.displayName?.trim() || null,
      workspacePath: input.workspacePath,
      canCreateProject: input.canCreateProject,
      projectIds: input.projectIds,
    });
    return { ok: true, user: presentPublicUser(created.user) };
  } catch (error) {
    if (repository.getUserByUsername(input.username)) return { ok: false, reason: 'username_exists' };
    throw error;
  }
}

export type SetDefaultProjectResult =
  | { ok: true; user: PublicUserDto }
  | { ok: false; reason: 'invalid_project' | 'user_not_found' | 'unsupported' };

export function setOwnDefaultProject(
  userId: string,
  projectId: string,
  repository: AuthRepository = databaseRepository,
): SetDefaultProjectResult {
  if (!repository.getUserById(userId)) return { ok: false, reason: 'user_not_found' };
  if (!repository.setUserDefaultProject) return { ok: false, reason: 'unsupported' };
  try {
    repository.setUserDefaultProject(userId, projectId);
  } catch {
    return { ok: false, reason: 'invalid_project' };
  }
  const updated = repository.getUserById(userId);
  return updated ? { ok: true, user: presentPublicUser(updated) } : { ok: false, reason: 'user_not_found' };
}

export type SetDefaultEngineResult =
  | { ok: true; user: PublicUserDto }
  | { ok: false; reason: 'user_not_found' | 'unsupported' };

export function setOwnDefaultEngine(
  userId: string,
  engine: EngineId,
  repository: AuthRepository = databaseRepository,
): SetDefaultEngineResult {
  if (!repository.getUserById(userId)) return { ok: false, reason: 'user_not_found' };
  if (!repository.setUserDefaultEngine) return { ok: false, reason: 'unsupported' };
  repository.setUserDefaultEngine(userId, engine);
  const updated = repository.getUserById(userId);
  return updated ? { ok: true, user: presentPublicUser(updated) } : { ok: false, reason: 'user_not_found' };
}

export type SetDefaultModelResult =
  | { ok: true; user: PublicUserDto }
  | { ok: false; reason: 'user_not_found' | 'engine_changed' | 'unsupported' };

export function setOwnDefaultModel(
  userId: string,
  expectedEngine: EngineId,
  modelId: string | null,
  repository: AuthRepository = databaseRepository,
): SetDefaultModelResult {
  const current = repository.getUserById(userId);
  if (!current) return { ok: false, reason: 'user_not_found' };
  if ((current.default_engine ?? 'codex') !== expectedEngine) return { ok: false, reason: 'engine_changed' };
  if (!repository.setUserDefaultModel) return { ok: false, reason: 'unsupported' };
  repository.setUserDefaultModel(userId, modelId);
  const updated = repository.getUserById(userId);
  return updated ? { ok: true, user: presentPublicUser(updated) } : { ok: false, reason: 'user_not_found' };
}

export type SetUserDisabledResult =
  | { ok: true; user: PublicUserDto; revokedSessions: number }
  | { ok: false; reason: 'forbidden' | 'self_target' | 'admin_target' | 'user_not_found' | 'unsupported' };

export function setUserDisabledByAdmin(
  adminUserId: string,
  targetUserId: string,
  disabled: boolean,
  repository: AuthRepository = databaseRepository,
  now = Date.now(),
): SetUserDisabledResult {
  const admin = repository.getUserById(adminUserId);
  if (!admin || admin.role !== 'admin') return { ok: false, reason: 'forbidden' };
  if (adminUserId === targetUserId) return { ok: false, reason: 'self_target' };
  const target = repository.getUserById(targetUserId);
  if (!target) return { ok: false, reason: 'user_not_found' };
  if (target.role === 'admin') return { ok: false, reason: 'admin_target' };
  if (!repository.setUserDisabled) return { ok: false, reason: 'unsupported' };
  const updated = repository.setUserDisabled(targetUserId, disabled ? now : null);
  return {
    ok: true,
    user: presentPublicUser(updated),
    revokedSessions: disabled ? revokeUserSessions(targetUserId, repository) : 0,
  };
}

export function setUserCanCreateProjectByAdmin(
  adminUserId: string,
  targetUserId: string,
  allowed: boolean,
  repository: AuthRepository = databaseRepository,
): { ok: true; user: PublicUserDto } | { ok: false; reason: 'forbidden' | 'user_not_found' | 'unsupported' } {
  const admin = repository.getUserById(adminUserId);
  if (!admin || admin.role !== 'admin') return { ok: false, reason: 'forbidden' };
  const target = repository.getUserById(targetUserId);
  if (!target) return { ok: false, reason: 'user_not_found' };
  if (!repository.setUserCanCreateProject) return { ok: false, reason: 'unsupported' };
  return { ok: true, user: presentPublicUser(repository.setUserCanCreateProject(targetUserId, allowed)) };
}

export type ChangePasswordResult =
  | { ok: true; revokedSessions: number }
  | { ok: false; reason: 'invalid_current_password' | 'same_password' | 'user_not_found' };

export function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  repository: AuthRepository = databaseRepository,
): ChangePasswordResult {
  const user = repository.getUserById(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  if (!verifyPassword(currentPassword, user.password_hash)) return { ok: false, reason: 'invalid_current_password' };
  if (verifyPassword(newPassword, user.password_hash)) return { ok: false, reason: 'same_password' };
  repository.updateUserPassword(userId, hashPassword(newPassword), false);
  return { ok: true, revokedSessions: revokeUserSessions(userId, repository) };
}

export type ChangeUsernameResult =
  | { ok: true; user: PublicUserDto; revokedSessions: number }
  | { ok: false; reason: 'invalid_current_password' | 'same_username' | 'username_exists' | 'user_not_found' };

export function changeOwnUsername(
  userId: string,
  currentPassword: string,
  username: string,
  retainedTokenHash: string,
  repository: AuthRepository = databaseRepository,
): ChangeUsernameResult {
  const user = repository.getUserById(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  if (!verifyPassword(currentPassword, user.password_hash)) return { ok: false, reason: 'invalid_current_password' };
  if (user.username === username) return { ok: false, reason: 'same_username' };
  const existing = repository.getUserByUsername(username);
  if (existing && existing.id !== userId) return { ok: false, reason: 'username_exists' };
  let updated: User;
  let tokenHashes: string[];
  try {
    ({ user: updated, tokenHashes } = repository.updateUserUsernameAndDeleteOtherSessions(userId, username, retainedTokenHash));
  } catch (error) {
    const conflicting = repository.getUserByUsername(username);
    if (conflicting && conflicting.id !== userId) return { ok: false, reason: 'username_exists' };
    throw error;
  }
  for (const tokenHash of tokenHashes) notifyAuthSessionRevoked(tokenHash);
  return { ok: true, user: presentPublicUser(updated), revokedSessions: tokenHashes.length };
}

export type AdminResetPasswordResult =
  | { ok: true; revokedSessions: number }
  | { ok: false; reason: 'forbidden' | 'self_target' | 'invalid_current_password' | 'same_password' | 'user_not_found' };

export function adminResetUserPassword(
  adminUserId: string,
  adminCurrentPassword: string,
  targetUserId: string,
  newPassword: string,
  repository: AuthRepository = databaseRepository,
): AdminResetPasswordResult {
  const admin = repository.getUserById(adminUserId);
  if (!admin || admin.role !== 'admin') return { ok: false, reason: 'forbidden' };
  if (adminUserId === targetUserId) return { ok: false, reason: 'self_target' };
  if (!verifyPassword(adminCurrentPassword, admin.password_hash)) return { ok: false, reason: 'invalid_current_password' };
  const target = repository.getUserById(targetUserId);
  if (!target) return { ok: false, reason: 'user_not_found' };
  if (verifyPassword(newPassword, target.password_hash)) return { ok: false, reason: 'same_password' };
  repository.updateUserPassword(targetUserId, hashPassword(newPassword), true);
  return { ok: true, revokedSessions: revokeUserSessions(targetUserId, repository) };
}
