import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getHttpClientIp } from '../http-client-ip.js';
import path from 'node:path';
import { z } from 'zod';
import {
  createClientId,
  getClientIdFromCookieHeader,
  getSessionTokenFromCookieHeader,
  serializeClearSessionCookie,
  serializeClientIdCookie,
  serializeSessionCookie,
} from '../auth/cookie.js';
import { formatLoginRetryAfter, LoginAttemptLimiter } from '../auth/login-limiter.js';
import { adminResetUserPassword, authenticateSessionDetails, authenticateSessionToken, changeOwnPassword, changeOwnUsername, createMemberByAdmin, loginWithPassword, logoutSessionToken, setOwnDefaultEngine, setOwnDefaultModel, setOwnDefaultProject, setUserCanCreateProjectByAdmin, setUserDisabledByAdmin } from '../auth/service.js';
import { validateAvatarUpload } from '../auth/avatar.js';
import { AccountThemeSettingsResponseDtoSchema, AuthResponseDtoSchema, NotificationPreferencesResponseDtoSchema, OkDtoSchema, presentApiError, presentPublicUser, ThemeAssetResponseDtoSchema, UserListResponseDtoSchema, UserResponseDtoSchema } from '../contracts/index.js';
import { getProject, getUserById, listUsers, updateUserAvatar, updateUserDisplayName } from '../db/queries.js';
import { readNotificationPreferences, saveNotificationPreferences } from '../services/notification-preferences.js';
import { broadcastUserFrontendEvent } from '../ws/frontend.js';
import { isAllowedOrigin, isSecureRelayRequest } from '../security.js';
import { createThemeSettingsService } from '../services/theme-settings.js';
import { MAX_THEME_ASSET_BYTES, validateThemeBackgroundUpload, type ThemeAssetVariant } from '../theme/theme-assets.js';
import { loginSchema, profilePatchSchema, changePasswordSchema, changeUsernameSchema, adminResetPasswordSchema,
  createMemberSchema, userDisabledPatchSchema, userProjectPermissionPatchSchema, defaultProjectPatchSchema, defaultEnginePatchSchema, defaultModelPatchSchema, resolveLoginSessionPolicy } from '../auth/http-contracts.js';
export { loginSchema, profilePatchSchema, changePasswordSchema, changeUsernameSchema, adminResetPasswordSchema,
  createMemberSchema, userDisabledPatchSchema, userProjectPermissionPatchSchema, defaultProjectPatchSchema, defaultEnginePatchSchema, defaultModelPatchSchema, resolveLoginSessionPolicy } from '../auth/http-contracts.js';
import { resolveRelayRoot } from '../default-project.js';
import { recordAdminAudit, runAdminAuditedOutcome } from '../db/admin-audit.js';
import { defaultEngineSystem } from '../engine/default-system.js';
import { EnginePreferencesValidationError, validateEnginePreferences } from '../engine/models/preferences.js';

const auth = new Hono();
const clientLimiter = new LoginAttemptLimiter();
const ipLimiter = new LoginAttemptLimiter({ maxFailures: 50 });
const accountCredentialClientLimiter = new LoginAttemptLimiter();
const accountCredentialIpLimiter = new LoginAttemptLimiter();
const themeSettingsService = createThemeSettingsService();

export const notificationPreferencesPatchSchema = z.object({
  desktopSystemEnabled: z.boolean().optional(),
  desktopSoundEnabled: z.boolean().optional(),
  desktopSessionEndSystemEnabled: z.boolean().optional(),
  desktopSessionEndSoundEnabled: z.boolean().optional(),
  mobileSystemEnabled: z.boolean().optional(),
  mobileSoundEnabled: z.boolean().optional(),
  mobileSessionEndSystemEnabled: z.boolean().optional(),
  mobileSessionEndSoundEnabled: z.boolean().optional(),
  approvalSound: z.enum(['gentle_dual', 'crisp', 'soft_chime', 'short_tone', 'high_dual', 'rising_triple', 'falling_low']).optional(),
  sessionEndSound: z.enum(['gentle_dual', 'crisp', 'soft_chime', 'short_tone', 'high_dual', 'rising_triple', 'falling_low']).optional(),
  desktopSoundVolume: z.number().int().min(10).max(100).multipleOf(5).optional(),
  mobileSoundVolume: z.number().int().min(10).max(100).multipleOf(5).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少更新一个通知偏好');

function isSecureRequest(c: { req: { url: string; header(name: string): string | undefined } }): boolean {
  return isSecureRelayRequest(
    c.req.url,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host'),
  );
}

function getLoginIp(c: Parameters<typeof getConnInfo>[0]): string {
  return getHttpClientIp(c);
}

auth.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('请输入用户名和密码'), 400);

  const sessionPolicy = resolveLoginSessionPolicy({
    purpose: parsed.data.purpose,
    marker: c.req.header('x-relay-acceptance'),
    remoteAddress: getConnInfo(c).remote.address,
    proxiedClientAddress: c.req.header('x-relay-client-address'),
    forwardedHost: c.req.header('x-forwarded-host'),
    forwardedProto: c.req.header('x-forwarded-proto'),
  });
  if (!sessionPolicy) return c.json(presentApiError('无头验收长会话只允许本机管理员认证'), 403);

  const secure = isSecureRequest(c);
  const ip = getLoginIp(c);
  let clientId = getClientIdFromCookieHeader(c.req.header('cookie'));
  if (!clientId) {
    clientId = createClientId();
    c.header('Set-Cookie', serializeClientIdCookie(clientId, secure), { append: true });
  }
  const clientKey = `${ip}|${clientId}`;
  const retryAfterSeconds = Math.max(
    clientLimiter.getRetryAfterSeconds(clientKey),
    ipLimiter.getRetryAfterSeconds(ip),
  );
  if (retryAfterSeconds > 0) {
    c.header('Retry-After', String(retryAfterSeconds));
    return c.json(presentApiError(`登录失败次数过多，请在 ${formatLoginRetryAfter(retryAfterSeconds)}后重试`), 429);
  }

  const login = loginWithPassword(parsed.data.username, parsed.data.password, undefined, Date.now(), sessionPolicy);
  if (!login) {
    const now = Date.now();
    const remainingAttempts = clientLimiter.recordFailure(clientKey, now);
    ipLimiter.recordFailure(ip, now);
    if (remainingAttempts === 0) {
      const retryAfter = Math.max(
        clientLimiter.getRetryAfterSeconds(clientKey, now),
        ipLimiter.getRetryAfterSeconds(ip, now),
      );
      c.header('Retry-After', String(retryAfter));
      return c.json(presentApiError(`登录失败次数过多，请在 ${formatLoginRetryAfter(retryAfter)}后重试`), 429);
    }
    const remainingHint = remainingAttempts <= 2 ? `，还可尝试 ${remainingAttempts} 次` : '';
    return c.json(presentApiError(`用户名或密码错误${remainingHint}`), 401);
  }

  clientLimiter.clear(clientKey);
  c.header('Set-Cookie', serializeSessionCookie(login.token, login.expiresAt, secure, login.ttlMs), { append: true });
  return c.json(AuthResponseDtoSchema.parse({ user: login.user, expiresAt: login.expiresAt }));
});

auth.get('/me', (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  return c.json(AuthResponseDtoSchema.parse({ user }));
});

auth.patch('/profile', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  const parsed = profilePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('昵称格式无效'), 400);
  const updated = updateUserDisplayName(user.id, parsed.data.displayName || null);
  return c.json(UserResponseDtoSchema.parse({ user: presentPublicUser(updated) }));
});

auth.put('/avatar', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  const mime = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const validation = validateAvatarUpload(mime, bytes);
  if (!validation.ok) return c.json(presentApiError(validation.error), 400);
  const updated = updateUserAvatar(user.id, validation.mime, bytes);
  return c.json(UserResponseDtoSchema.parse({ user: presentPublicUser(updated) }));
});

auth.delete('/avatar', (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  const updated = updateUserAvatar(user.id, null, null);
  return c.json(UserResponseDtoSchema.parse({ user: presentPublicUser(updated) }));
});

auth.get('/users/:id/avatar', (c) => {
  const viewer = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!viewer) return c.json(presentApiError('请先登录'), 401);
  const user = getUserById(c.req.param('id'));
  if (!user?.avatar_data || !user.avatar_mime) return c.json(presentApiError('头像不存在'), 404);
  return new Response(Buffer.from(user.avatar_data), {
    headers: {
      'Content-Type': user.avatar_mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

auth.post('/change-password', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = changePasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('密码格式无效，新密码需要 6 到 50 个字符'), 400);
  const result = changeOwnPassword(user.id, parsed.data.currentPassword, parsed.data.newPassword);
  if (!result.ok) {
    if (result.reason === 'invalid_current_password') return c.json(presentApiError('当前密码不正确'), 403);
    if (result.reason === 'same_password') return c.json(presentApiError('新密码不能与当前密码相同'), 400);
    return c.json(presentApiError('账号不存在'), 404);
  }
  c.header('Set-Cookie', serializeClearSessionCookie(isSecureRequest(c)));
  return c.json(OkDtoSchema.parse({ ok: true }));
});

auth.post('/change-username', async (c) => {
  const session = authenticateSessionDetails(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!session) return c.json(presentApiError('请先登录'), 401);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = changeUsernameSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('登录名格式无效，只能包含字母、数字、点、下划线和连字符'), 400);
  const ip = getLoginIp(c);
  let clientId = getClientIdFromCookieHeader(c.req.header('cookie'));
  if (!clientId) {
    clientId = createClientId();
    c.header('Set-Cookie', serializeClientIdCookie(clientId, isSecureRequest(c)), { append: true });
  }
  const clientCredentialKey = `${session.user.id}|${clientId}`;
  const ipCredentialKey = `${session.user.id}|${ip}`;
  const retryAfterSeconds = Math.max(
    accountCredentialClientLimiter.getRetryAfterSeconds(clientCredentialKey),
    accountCredentialIpLimiter.getRetryAfterSeconds(ipCredentialKey),
  );
  if (retryAfterSeconds > 0) {
    c.header('Retry-After', String(retryAfterSeconds));
    return c.json(presentApiError(`当前密码验证失败次数过多，请在 ${formatLoginRetryAfter(retryAfterSeconds)}后重试`), 429);
  }
  const result = changeOwnUsername(
    session.user.id,
    parsed.data.currentPassword,
    parsed.data.username,
    session.tokenHash,
  );
  if (!result.ok) {
    if (result.reason === 'invalid_current_password') {
      const now = Date.now();
      const clientRemainingAttempts = accountCredentialClientLimiter.recordFailure(clientCredentialKey, now);
      const ipRemainingAttempts = accountCredentialIpLimiter.recordFailure(ipCredentialKey, now);
      const remainingAttempts = Math.min(clientRemainingAttempts, ipRemainingAttempts);
      const retryAfter = Math.max(
        accountCredentialClientLimiter.getRetryAfterSeconds(clientCredentialKey, now),
        accountCredentialIpLimiter.getRetryAfterSeconds(ipCredentialKey, now),
      );
      if (retryAfter > 0) {
        c.header('Retry-After', String(retryAfter));
        return c.json(presentApiError(`当前密码验证失败次数过多，请在 ${formatLoginRetryAfter(retryAfter)}后重试`), 429);
      }
      const remainingHint = remainingAttempts <= 2 ? `，还可尝试 ${remainingAttempts} 次` : '';
      return c.json(presentApiError(`当前密码不正确${remainingHint}`), 403);
    }
    if (result.reason === 'username_exists') return c.json(presentApiError('该登录名已被使用'), 409);
    if (result.reason === 'same_username') return c.json(presentApiError('新登录名与当前登录名相同'), 400);
    return c.json(presentApiError('账号不存在'), 404);
  }
  accountCredentialClientLimiter.clear(clientCredentialKey);
  accountCredentialIpLimiter.clear(ipCredentialKey);
  return c.json(UserResponseDtoSchema.parse({ user: result.user }));
});

auth.get('/users', (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (user.role !== 'admin') return c.json(presentApiError('仅管理员可以查看账号列表'), 403);
  return c.json(UserListResponseDtoSchema.parse({ users: listUsers().map(presentPublicUser) }));
});

auth.post('/users', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (user.role !== 'admin') return c.json(presentApiError('仅管理员可以创建账号'), 403);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = createMemberSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('账号资料格式无效'), 400);
  const relayRoot = resolveRelayRoot(path.resolve(import.meta.dirname, '../../..'));
  if (parsed.data.projectIds.some((projectId) => !getProject(projectId))) return c.json(presentApiError('选择的协作项目不存在'), 400);
  const result = createMemberByAdmin(user.id, {
      ...parsed.data,
      workspacePath: path.join(relayRoot, 'workspace'),
  });
  if (!result.ok) {
    if (result.reason === 'username_exists') return c.json(presentApiError('账号名已存在'), 409);
    return c.json(presentApiError('无法创建账号'), result.reason === 'forbidden' ? 403 : 501);
  }
  // 创建账号时目标 ID 只有业务成功后才生成；失败不会产生可引用的目标资源。
  try { recordAdminAudit({ actorUserId: user.id, action: 'account.create', resourceType: 'user', resourceId: result.user.id, ownerUserId: result.user.id, result: 'succeeded' }); }
  catch (error) { console.error('[Relay] 管理员创建账号审计写入失败:', error); }
  return c.json(UserResponseDtoSchema.parse({ user: result.user }), 201);
});

auth.patch('/users/:id/disabled', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (user.role !== 'admin') return c.json(presentApiError('仅管理员可以启用或停用账号'), 403);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = userDisabledPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('账号状态格式无效'), 400);
  const target = getUserById(c.req.param('id'));
  const action = () => setUserDisabledByAdmin(user.id, c.req.param('id'), parsed.data.disabled);
  const result = target ? runAdminAuditedOutcome({
    actorUserId: user.id, action: parsed.data.disabled ? 'account.disable' : 'account.enable',
    resourceType: 'user', resourceId: target.id, ownerUserId: target.id,
  }, action, (value) => value.ok) : action();
  if (!result.ok) {
    if (result.reason === 'self_target' || result.reason === 'admin_target') return c.json(presentApiError('管理员账号不能被停用'), 400);
    if (result.reason === 'user_not_found') return c.json(presentApiError('账号不存在'), 404);
    return c.json(presentApiError('无法更新账号状态'), result.reason === 'forbidden' ? 403 : 501);
  }
  return c.json(UserResponseDtoSchema.parse({ user: result.user }));
});

auth.patch('/users/:id/project-permission', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user || user.role !== 'admin') return c.json(presentApiError('仅管理员可以修改账号权限'), 403);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = userProjectPermissionPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('账号权限格式无效'), 400);
  const result = setUserCanCreateProjectByAdmin(user.id, c.req.param('id'), parsed.data.canCreateProject);
  if (!result.ok) return c.json(presentApiError(result.reason === 'user_not_found' ? '账号不存在' : '无法更新账号权限'), result.reason === 'user_not_found' ? 404 : 501);
  return c.json(UserResponseDtoSchema.parse({ user: result.user }));
});

auth.patch('/default-project', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = defaultProjectPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('默认项目格式无效'), 400);
  const result = setOwnDefaultProject(user.id, parsed.data.projectId);
  if (!result.ok) {
    if (result.reason === 'invalid_project') return c.json(presentApiError('只能选择自己拥有的有效项目'), 403);
    if (result.reason === 'user_not_found') return c.json(presentApiError('账号不存在'), 404);
    return c.json(presentApiError('无法更新默认项目'), 501);
  }
  broadcastUserFrontendEvent(user.id, { type: 'conversation_defaults_updated', user: result.user });
  return c.json(UserResponseDtoSchema.parse({ user: result.user }));
});

auth.patch('/default-engine', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = defaultEnginePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('默认引擎格式无效'), 400);
  const result = setOwnDefaultEngine(user.id, parsed.data.engine);
  if (!result.ok) {
    if (result.reason === 'user_not_found') return c.json(presentApiError('账号不存在'), 404);
    return c.json(presentApiError('无法更新默认引擎'), 501);
  }
  broadcastUserFrontendEvent(user.id, { type: 'conversation_defaults_updated', user: result.user });
  return c.json(UserResponseDtoSchema.parse({ user: result.user }));
});

auth.patch('/default-model', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = defaultModelPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('默认模型格式无效'), 400);
  try {
    if (parsed.data.modelId !== null) {
      const catalog = await defaultEngineSystem.modelCatalog.get(user.defaultEngine);
      validateEnginePreferences(catalog, { modelId: parsed.data.modelId, reasoningEffort: null });
    }
  } catch (error) {
    if (error instanceof EnginePreferencesValidationError) {
      return c.json(presentApiError(error.message, { code: error.code }), 422);
    }
    return c.json(presentApiError('模型目录暂时不可用，无法更新默认模型'), 503);
  }
  const result = setOwnDefaultModel(user.id, user.defaultEngine, parsed.data.modelId);
  if (!result.ok) {
    if (result.reason === 'user_not_found') return c.json(presentApiError('账号不存在'), 404);
    if (result.reason === 'engine_changed') return c.json(presentApiError('默认引擎已变化，请重新选择模型', { code: 'DEFAULT_ENGINE_CHANGED' }), 409);
    return c.json(presentApiError('无法更新默认模型'), 501);
  }
  broadcastUserFrontendEvent(user.id, { type: 'conversation_defaults_updated', user: result.user });
  return c.json(UserResponseDtoSchema.parse({ user: result.user }));
});

auth.post('/users/:id/reset-password', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (user.role !== 'admin') return c.json(presentApiError('仅管理员可以重置账号密码'), 403);
  if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const parsed = adminResetPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('密码格式无效，新密码需要 6 到 50 个字符'), 400);
  const target = getUserById(c.req.param('id'));
  const action = () => adminResetUserPassword(user.id, parsed.data.currentPassword, c.req.param('id'), parsed.data.newPassword);
  const result = target ? runAdminAuditedOutcome({
    actorUserId: user.id, action: 'account.reset_password', resourceType: 'user',
    resourceId: target.id, ownerUserId: target.id,
  }, action, (value) => value.ok) : action();
  if (!result.ok) {
    if (result.reason === 'self_target') return c.json(presentApiError('不能在账号管理中重置自己的密码'), 400);
    if (result.reason === 'invalid_current_password') return c.json(presentApiError('管理员当前密码不正确'), 403);
    if (result.reason === 'same_password') return c.json(presentApiError('新密码不能与目标账号当前密码相同'), 400);
    if (result.reason === 'user_not_found') return c.json(presentApiError('目标账号不存在'), 404);
    return c.json(presentApiError('仅管理员可以重置账号密码'), 403);
  }
  return c.json(OkDtoSchema.parse({ ok: true }));
});

auth.get('/notification-preferences', (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  return c.json(NotificationPreferencesResponseDtoSchema.parse({ preferences: readNotificationPreferences(user.id) }));
});

auth.patch('/notification-preferences', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  const parsed = notificationPreferencesPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('通知偏好格式无效'), 400);
  const preferences = saveNotificationPreferences(user.id, parsed.data);
  broadcastUserFrontendEvent(user.id, { type: 'notification_preferences_updated', preferences });
  return c.json(NotificationPreferencesResponseDtoSchema.parse({ preferences }));
});

auth.get('/theme-settings', (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  return c.json(AccountThemeSettingsResponseDtoSchema.parse({ settings: themeSettingsService.read(user.id) }));
});

auth.put('/theme-settings', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  try {
    const settings = themeSettingsService.save(user.id, await c.req.json().catch(() => null));
    broadcastUserFrontendEvent(user.id, { type: 'theme_settings_updated', settings });
    return c.json(AccountThemeSettingsResponseDtoSchema.parse({ settings }));
  } catch (error) {
    return c.json(presentApiError(error instanceof Error ? error.message : '主题设置格式无效'), 400);
  }
});

auth.post('/theme-assets', async (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  const body = await c.req.parseBody().catch(() => null);
  const desktopFile = body?.desktop;
  const mobileFile = body?.mobile;
  if (!(desktopFile instanceof File) || !(mobileFile instanceof File)) {
    return c.json(presentApiError('请提供桌面和移动背景图片'), 400);
  }
  if (desktopFile.size > MAX_THEME_ASSET_BYTES || mobileFile.size > MAX_THEME_ASSET_BYTES) {
    return c.json(presentApiError('处理后的背景图片不能超过 4 MiB'), 400);
  }
  const desktop = new Uint8Array(await desktopFile.arrayBuffer());
  const mobile = new Uint8Array(await mobileFile.arrayBuffer());
  for (const [variant, bytes] of [['desktop', desktop], ['mobile', mobile]] as const) {
    const validation = validateThemeBackgroundUpload(variant, bytes);
    if (!validation.ok) return c.json(presentApiError(validation.error), 400);
  }
  const assetId = themeSettingsService.createAsset(user.id, desktop, mobile);
  return c.json(ThemeAssetResponseDtoSchema.parse({ assetId }), 201);
});

auth.get('/theme-assets/:assetId/:variant', (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  const variant = c.req.param('variant') as ThemeAssetVariant;
  if (variant !== 'desktop' && variant !== 'mobile') return c.json(presentApiError('背景版本不存在'), 404);
  const data = themeSettingsService.readAsset(user.id, c.req.param('assetId'), variant);
  if (!data) return c.json(presentApiError('背景资源不存在'), 404);
  const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return new Response(body, { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
});

auth.delete('/theme-assets/:assetId', (c) => {
  const user = authenticateSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  try {
    return themeSettingsService.deleteAsset(user.id, c.req.param('assetId'))
      ? c.json(OkDtoSchema.parse({ ok: true }))
      : c.json(presentApiError('背景资源不存在'), 404);
  } catch (error) {
    return c.json(presentApiError(error instanceof Error ? error.message : '背景资源删除失败'), 409);
  }
});

auth.post('/logout', (c) => {
  logoutSessionToken(getSessionTokenFromCookieHeader(c.req.header('cookie')));
  c.header('Set-Cookie', serializeClearSessionCookie(isSecureRequest(c)));
  return c.json(OkDtoSchema.parse({ ok: true }));
});

export default auth;
