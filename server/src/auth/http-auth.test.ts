import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthSession, User } from '../db/queries.js';
import { formatLoginRetryAfter, LoginAttemptLimiter } from './login-limiter.js';
import {
  createClientId,
  getClientIdFromCookieHeader,
  parseCookieHeader,
  serializeClearSessionCookie,
  serializeClientIdCookie,
  serializeSessionCookie,
} from './cookie.js';
import {
  type AuthRepository,
  authenticateSessionToken,
  adminResetUserPassword,
  changeOwnPassword,
  changeOwnUsername,
  ensureDefaultAdmin,
  loginWithPassword,
  logoutSessionToken,
  setUserDisabledByAdmin,
} from './service.js';
import { loginSchema, resolveLoginSessionPolicy, adminResetPasswordSchema, changePasswordSchema, changeUsernameSchema, createMemberSchema, notificationPreferencesPatchSchema, profilePatchSchema } from '../routes/auth.js';
import { hashPassword } from './password.js';
import { ACCEPTANCE_SESSION_TTL_MS, SESSION_TTL_MS } from './session.js';

function createMemoryRepository(): AuthRepository & { sessions: Map<string, AuthSession>; users: Map<string, User> } {
  const users = new Map<string, User>();
  const sessions = new Map<string, AuthSession>();
  return {
    sessions,
    users,
    getUserByUsername(username) {
      return [...users.values()].find((user) => user.username.toLowerCase() === username.toLowerCase());
    },
    getUserById(userId) {
      return users.get(userId);
    },
    listUsers() {
      return [...users.values()];
    },
    createUser(username, passwordHash, role = 'member') {
      const now = Date.now();
      const user = { id: `user-${users.size + 1}`, username, password_hash: passwordHash, role, created_at: now, updated_at: now };
      users.set(user.id, user);
      return user;
    },
    setUserRole(userId, role) {
      const user = users.get(userId);
      if (!user) throw new Error('用户不存在');
      const updated = { ...user, role, updated_at: Date.now() };
      users.set(userId, updated);
      return updated;
    },
    updateUserPassword(userId, passwordHash, mustChangePassword = false) {
      const user = users.get(userId);
      if (!user) throw new Error('用户不存在');
      const updated = { ...user, password_hash: passwordHash, must_change_password: Number(mustChangePassword), updated_at: Date.now() };
      users.set(userId, updated);
      return updated;
    },
    updateUserUsernameAndDeleteOtherSessions(userId, username, retainedTokenHash) {
      const user = users.get(userId);
      if (!user) throw new Error('用户不存在');
      const updated = { ...user, username, updated_at: Date.now() };
      users.set(userId, updated);
      const hashes: string[] = [];
      for (const [tokenHash, session] of sessions) {
        if (session.user_id !== userId || tokenHash === retainedTokenHash) continue;
        hashes.push(tokenHash);
        sessions.delete(tokenHash);
      }
      return { user: updated, tokenHashes: hashes };
    },
    setUserDisabled(userId, disabledAt) {
      const user = users.get(userId);
      if (!user) throw new Error('用户不存在');
      const updated = { ...user, disabled_at: disabledAt, updated_at: Date.now() };
      users.set(userId, updated);
      return updated;
    },
    createAuthSession(session) {
      sessions.set(session.token_hash, session);
    },
    getAuthSession(tokenHash) {
      return sessions.get(tokenHash);
    },
    getAuthenticatedUser(tokenHash, now = Date.now()) {
      const session = sessions.get(tokenHash);
      return session && session.expires_at > now ? users.get(session.user_id) : undefined;
    },
    deleteAuthSession(tokenHash) {
      sessions.delete(tokenHash);
    },
    deleteAuthSessionsByUserId(userId) {
      const hashes: string[] = [];
      for (const [tokenHash, session] of sessions) {
        if (session.user_id !== userId) continue;
        hashes.push(tokenHash);
        sessions.delete(tokenHash);
      }
      return hashes;
    },
    deleteExpiredAuthSessions(now = Date.now()) {
      for (const [tokenHash, session] of sessions) {
        if (session.expires_at <= now) sessions.delete(tokenHash);
      }
    },
  };
}

test('默认管理员只创建一次，并可登录、认证和退出', () => {
  const repository = createMemoryRepository();
  const first = ensureDefaultAdmin(repository, { username: 'admin', password: 'admin' });
  const second = ensureDefaultAdmin(repository, { username: 'admin', password: 'changed' });
  assert.deepEqual(first, second);
  assert.equal(first.role, 'admin');

  const now = Date.UTC(2026, 7, 4);
  assert.equal(loginWithPassword('admin', 'wrong', repository, now), null);
  const login = loginWithPassword('admin', 'admin', repository, now);
  assert.ok(login);
  assert.deepEqual(authenticateSessionToken(login.token, repository, now), first);

  logoutSessionToken(login.token, repository);
  assert.equal(authenticateSessionToken(login.token, repository, now), null);
});

test('只有管理员可创建固定一百八十天验收会话', () => {
  const repository = createMemoryRepository();
  ensureDefaultAdmin(repository, { username: 'admin', password: 'admin-password' });
  repository.createUser('member', hashPassword('member-password'), 'member');
  const now = Date.UTC(2026, 7, 4);

  assert.throws(() => loginWithPassword('admin', 'admin-password', repository, now, {
    ttlMs: ACCEPTANCE_SESSION_TTL_MS,
  }), /管理员角色/);

  const admin = loginWithPassword('admin', 'admin-password', repository, now, {
    ttlMs: ACCEPTANCE_SESSION_TTL_MS,
    requiredRole: 'admin',
  });
  assert.ok(admin);
  assert.equal(admin.ttlMs, ACCEPTANCE_SESSION_TTL_MS);
  assert.equal(admin.expiresAt, now + ACCEPTANCE_SESSION_TTL_MS);
  const sessionCount = repository.sessions.size;
  assert.equal(loginWithPassword('member', 'member-password', repository, now, {
    ttlMs: ACCEPTANCE_SESSION_TTL_MS,
    requiredRole: 'admin',
  }), null);
  assert.equal(repository.sessions.size, sessionCount);
});

test('已有 member 账号被配置为默认管理员时提升为 admin', () => {
  const repository = createMemoryRepository();
  repository.createUser('owner', 'hash');
  const admin = ensureDefaultAdmin(repository, { username: 'owner', password: 'unused' });
  assert.equal(admin.role, 'admin');
});

test('停用账号不能建立新会话', () => {
  const repository = createMemoryRepository();
  const member = repository.createUser('member', hashPassword('member-password'), 'member');
  repository.users.set(member.id, { ...member, disabled_at: Date.now() });
  assert.equal(loginWithPassword('member', 'member-password', repository), null);
  assert.equal(repository.sessions.size, 0);
});

test('管理员停用成员会原子标记并撤销全部会话，且不能停用自己或管理员', () => {
  const repository = createMemoryRepository();
  const admin = ensureDefaultAdmin(repository, { username: 'admin', password: 'admin-password' });
  const member = repository.createUser('member', hashPassword('member-password'), 'member');
  assert.ok(loginWithPassword('member', 'member-password', repository));
  assert.ok(loginWithPassword('member', 'member-password', repository));
  assert.deepEqual(setUserDisabledByAdmin(admin.id, admin.id, true, repository), { ok: false, reason: 'self_target' });
  const disabled = setUserDisabledByAdmin(admin.id, member.id, true, repository, 123);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.ok ? disabled.revokedSessions : -1, 2);
  assert.equal(repository.users.get(member.id)?.disabled_at, 123);
  assert.equal(repository.sessions.size, 0);
  assert.equal(loginWithPassword('member', 'member-password', repository), null);
  const enabled = setUserDisabledByAdmin(admin.id, member.id, false, repository);
  assert.equal(enabled.ok, true);
  assert.equal(repository.users.get(member.id)?.disabled_at, null);
  assert.ok(loginWithPassword('member', 'member-password', repository));
});

test('本人修改密码必须验证当前密码并撤销全部会话', () => {
  const repository = createMemoryRepository();
  const user = ensureDefaultAdmin(repository, { username: 'admin', password: 'old-password' });
  const first = loginWithPassword('admin', 'old-password', repository);
  const second = loginWithPassword('admin', 'old-password', repository);
  assert.ok(first && second);
  assert.deepEqual(changeOwnPassword(user.id, 'wrong', 'new-password', repository), { ok: false, reason: 'invalid_current_password' });
  assert.deepEqual(changeOwnPassword(user.id, 'old-password', 'old-password', repository), { ok: false, reason: 'same_password' });
  assert.deepEqual(changeOwnPassword(user.id, 'old-password', 'new-password', repository), { ok: true, revokedSessions: 2 });
  assert.equal(repository.users.get(user.id)?.must_change_password, 0);
  assert.equal(repository.sessions.size, 0);
  assert.equal(loginWithPassword('admin', 'old-password', repository), null);
  assert.ok(loginWithPassword('admin', 'new-password', repository));
});

test('本人修改登录名验证密码与唯一性，并只保留当前会话', () => {
  const repository = createMemoryRepository();
  const user = ensureDefaultAdmin(repository, { username: 'admin', password: 'admin-password' });
  repository.createUser('occupied', hashPassword('member-password'), 'member');
  const current = loginWithPassword('admin', 'admin-password', repository);
  const other = loginWithPassword('admin', 'admin-password', repository);
  assert.ok(current && other);
  const currentHash = [...repository.sessions.keys()][0];

  assert.deepEqual(changeOwnUsername(user.id, 'wrong', 'relay-admin', currentHash, repository), { ok: false, reason: 'invalid_current_password' });
  assert.deepEqual(changeOwnUsername(user.id, 'admin-password', 'occupied', currentHash, repository), { ok: false, reason: 'username_exists' });
  assert.deepEqual(changeOwnUsername(user.id, 'admin-password', 'admin', currentHash, repository), { ok: false, reason: 'same_username' });
  const changed = changeOwnUsername(user.id, 'admin-password', 'relay-admin', currentHash, repository);
  assert.equal(changed.ok, true);
  assert.equal(changed.ok ? changed.user.username : '', 'relay-admin');
  assert.equal(changed.ok ? changed.revokedSessions : -1, 1);
  assert.equal(authenticateSessionToken(current.token, repository)?.username, 'relay-admin');
  assert.equal(authenticateSessionToken(other.token, repository), null);
  assert.equal(loginWithPassword('relay-admin', 'admin-password', repository)?.user.username, 'relay-admin');
  const afterRestart = ensureDefaultAdmin(repository, { username: 'admin', password: 'default-password' });
  assert.equal(afterRestart.id, user.id);
  assert.equal(afterRestart.username, 'relay-admin');
  assert.equal([...repository.users.values()].filter((candidate) => candidate.role === 'admin').length, 1);
});

test('管理员只能重置其他账号密码并撤销目标账号会话', () => {
  const repository = createMemoryRepository();
  const admin = ensureDefaultAdmin(repository, { username: 'admin', password: 'admin-password' });
  const member = repository.createUser('member', hashPassword('member-password'), 'member');
  const memberLogin = loginWithPassword('member', 'member-password', repository);
  assert.ok(memberLogin);
  assert.deepEqual(adminResetUserPassword(admin.id, 'admin-password', admin.id, 'new-admin', repository), { ok: false, reason: 'self_target' });
  assert.deepEqual(adminResetUserPassword(admin.id, 'wrong', member.id, 'new-member', repository), { ok: false, reason: 'invalid_current_password' });
  assert.deepEqual(adminResetUserPassword(admin.id, 'admin-password', member.id, 'new-member', repository), { ok: true, revokedSessions: 1 });
  assert.equal(repository.users.get(member.id)?.must_change_password, 1);
  assert.equal(repository.sessions.size, 0);
  assert.ok(loginWithPassword('member', 'new-member', repository));
});

test('会话 Cookie 为 HttpOnly、Lax、三十天且支持安全清除', () => {
  const expiresAt = Date.UTC(2026, 8, 3);
  const cookie = serializeSessionCookie('secret-token', expiresAt, true);
  assert.match(cookie, /^relay_session=secret-token;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /Secure/);
  assert.equal(parseCookieHeader('theme=dark; relay_session=secret-token')?.relay_session, 'secret-token');
  assert.match(serializeClearSessionCookie(false), /Max-Age=0/);
  assert.match(serializeSessionCookie('acceptance-token', expiresAt, true, ACCEPTANCE_SESSION_TTL_MS), /Max-Age=15552000/);
});

test('验收长会话必须满足双层 loopback 且拒绝公网转发', () => {
  const normal = resolveLoginSessionPolicy({});
  assert.deepEqual(normal, { ttlMs: SESSION_TTL_MS });
  const localAcceptance = resolveLoginSessionPolicy({
    purpose: 'headless_acceptance',
    marker: 'headless-v1',
    remoteAddress: '::ffff:127.0.0.1',
    proxiedClientAddress: '127.0.0.1',
  });
  assert.deepEqual(localAcceptance, { ttlMs: ACCEPTANCE_SESSION_TTL_MS, requiredRole: 'admin' });
  for (const rejected of [
    { purpose: 'headless_acceptance', remoteAddress: '127.0.0.1' },
    { purpose: 'headless_acceptance', marker: 'headless-v1', remoteAddress: '192.168.1.5' },
    { purpose: 'headless_acceptance', marker: 'headless-v1', remoteAddress: '127.0.0.1', proxiedClientAddress: '192.168.1.5' },
    { purpose: 'headless_acceptance', marker: 'headless-v1', remoteAddress: '127.0.0.1', proxiedClientAddress: '127.0.0.1', forwardedHost: 'relay.example:443' },
    { purpose: 'headless_acceptance', marker: 'headless-v1', remoteAddress: '127.0.0.1', proxiedClientAddress: '127.0.0.1', forwardedProto: 'https' },
  ] as const) assert.equal(resolveLoginSessionPolicy(rejected), null);
  assert.equal(loginSchema.safeParse({ username: 'admin', password: 'secret', purpose: 'other' }).success, false);
});

test('登录客户端标识由服务端生成并通过长期 HttpOnly Cookie 保存', () => {
  const clientId = createClientId();
  assert.match(clientId, /^[0-9a-f-]{36}$/i);
  const cookie = serializeClientIdCookie(clientId, true);
  assert.match(cookie, /^relay_client_id=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /Secure/);
  assert.equal(getClientIdFromCookieHeader(`relay_client_id=${clientId}`), clientId);
  assert.equal(getClientIdFromCookieHeader('relay_client_id=invalid'), null);
});

test('登录失败限速在窗口结束后自动恢复', () => {
  const limiter = new LoginAttemptLimiter({ maxFailures: 3, windowMs: 60_000 });
  assert.equal(limiter.canAttempt('local', 0), true);
  limiter.recordFailure('local', 1);
  limiter.recordFailure('local', 2);
  limiter.recordFailure('local', 3);
  assert.equal(limiter.canAttempt('local', 4), false);
  assert.equal(limiter.getRetryAfterSeconds('local', 4), 60);
  assert.equal(limiter.getRetryAfterSeconds('local', 59_501), 1);
  assert.equal(limiter.canAttempt('local', 60_002), false);
  assert.equal(limiter.canAttempt('local', 60_003), true);
  assert.equal(limiter.getRetryAfterSeconds('local', 60_003), 0);
});

test('登录失败窗口从最后一次失败开始并返回剩余尝试次数', () => {
  const limiter = new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000 });
  assert.equal(limiter.recordFailure('client', 1), 4);
  assert.equal(limiter.recordFailure('client', 20_000), 3);
  assert.equal(limiter.recordFailure('client', 40_000), 2);
  assert.equal(limiter.getRemainingAttempts('client', 40_001), 2);
  assert.equal(limiter.recordFailure('client', 50_000), 1);
  assert.equal(limiter.recordFailure('client', 55_000), 0);
  assert.equal(limiter.getRetryAfterSeconds('client', 55_001), 60);
  assert.equal(limiter.canAttempt('client', 114_999), false);
  assert.equal(limiter.canAttempt('client', 115_000), true);
});

test('登录限速等待时间按分钟或秒生成用户提示', () => {
  assert.equal(formatLoginRetryAfter(300), '5 分钟');
  assert.equal(formatLoginRetryAfter(61), '2 分钟');
  assert.equal(formatLoginRetryAfter(59), '59 秒');
});

test('登录限速会清理过期记录并限制最大容量', () => {
  const limiter = new LoginAttemptLimiter({ maxFailures: 1, windowMs: 60_000, maxEntries: 2 });
  limiter.recordFailure('first', 1);
  limiter.recordFailure('second', 2);
  limiter.recordFailure('third', 3);
  assert.equal(limiter.canAttempt('first', 4), true);
  assert.equal(limiter.canAttempt('second', 4), false);
  assert.equal(limiter.canAttempt('third', 4), false);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.canAttempt('second', 60_002), true);
});

test('通知偏好 PATCH 严格限制开关、内置音色和分设备音量', () => {
  assert.deepEqual(notificationPreferencesPatchSchema.parse({ desktopSystemEnabled: true }), { desktopSystemEnabled: true });
  assert.deepEqual(notificationPreferencesPatchSchema.parse({ approvalSound: 'soft_chime', mobileSoundVolume: 80 }), { approvalSound: 'soft_chime', mobileSoundVolume: 80 });
  assert.deepEqual(notificationPreferencesPatchSchema.parse({ approvalSound: 'high_dual', sessionEndSound: 'rising_triple' }), { approvalSound: 'high_dual', sessionEndSound: 'rising_triple' });
  assert.equal(notificationPreferencesPatchSchema.safeParse({}).success, false);
  assert.equal(notificationPreferencesPatchSchema.safeParse({ desktopSystemEnabled: 'yes' }).success, false);
  assert.equal(notificationPreferencesPatchSchema.safeParse({ approvalSound: 'uploaded' }).success, false);
  assert.equal(notificationPreferencesPatchSchema.safeParse({ desktopSoundVolume: 47 }).success, false);
  assert.equal(notificationPreferencesPatchSchema.safeParse({ desktopSystemEnabled: true, extra: true }).success, false);
});

test('账号资料与密码输入使用严格白名单和长度限制', () => {
  assert.deepEqual(profilePatchSchema.parse({ displayName: '  Relay 用户  ' }), { displayName: 'Relay 用户' });
  assert.equal(profilePatchSchema.safeParse({ displayName: 'a'.repeat(41) }).success, false);
  assert.equal(profilePatchSchema.safeParse({ displayName: '用户', role: 'admin' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: '12345' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: '123456' }).success, true);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'x'.repeat(50) }).success, true);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'x'.repeat(51) }).success, false);
  assert.deepEqual(changeUsernameSchema.parse({ username: '  relay.admin-1  ', currentPassword: 'secret' }), { username: 'relay.admin-1', currentPassword: 'secret' });
  assert.equal(changeUsernameSchema.safeParse({ username: '中文账号', currentPassword: 'secret' }).success, false);
  assert.equal(changeUsernameSchema.safeParse({ username: 'admin', currentPassword: 'secret', role: 'admin' }).success, false);
  assert.equal(adminResetPasswordSchema.safeParse({ currentPassword: 'admin', newPassword: '123456', target: 'self' }).success, false);
  assert.equal(adminResetPasswordSchema.safeParse({ currentPassword: 'admin', newPassword: '12345' }).success, false);
  assert.equal(adminResetPasswordSchema.safeParse({ currentPassword: 'admin', newPassword: 'x'.repeat(51) }).success, false);
  assert.equal(createMemberSchema.safeParse({ username: 'member', initialPassword: '123456' }).success, true);
  assert.equal(createMemberSchema.safeParse({ username: 'member', initialPassword: '12345' }).success, false);
  assert.equal(createMemberSchema.safeParse({ username: 'member', initialPassword: 'x'.repeat(51) }).success, false);
});
