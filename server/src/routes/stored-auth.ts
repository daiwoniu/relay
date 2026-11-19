import { PreviewPreferencesSchema, PreviewPreferencesPatchSchema } from '../contracts/preview-preferences.js';
import { randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getHttpClientIp } from '../http-client-ip.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { authenticateStoredSession, createRequireStoredUserSession } from '../auth/stored-session.js';
import { StoredCredentialService } from '../auth/stored-credentials.js';
import { LoginIntentTokens } from '../auth/login-intents.js';
import { LoginAttemptLimiter, formatLoginRetryAfter } from '../auth/login-limiter.js';
import { loginSchema, resolveLoginSessionPolicy, changePasswordSchema, changeUsernameSchema, adminResetPasswordSchema,
  createMemberSchema, profilePatchSchema, userDisabledPatchSchema, userProjectPermissionPatchSchema, defaultProjectPatchSchema,defaultEnginePatchSchema,defaultModelPatchSchema } from '../auth/http-contracts.js';
import { MAX_AVATAR_BYTES,validateAvatarUpload } from '../auth/avatar.js';
import type { EngineId } from '../engine/types.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import { EnginePreferencesValidationError,validateEnginePreferences } from '../engine/models/preferences.js';
import { createClientId, getClientIdFromCookieHeader, getSessionTokenFromCookieHeader,
  serializeClientIdCookie, serializeSessionCookie, serializeClearSessionCookie } from '../auth/cookie.js';
import { isAllowedOrigin, isSecureRelayRequest } from '../security.js';
import { AuthResponseDtoSchema, UserResponseDtoSchema, UserListResponseDtoSchema, OkDtoSchema, NotificationPreferencesResponseDtoSchema, presentApiError, type PublicUserDto } from '../contracts/index.js';
import { NotificationPreferencesPatchSchema } from '../storage/notification-preferences-contract.js';
import { ToolsActionSchema, ToolsStateSchema } from '../storage/tools-contract.js';
import { AccountThemeSettingsResponseDtoSchema,ThemeSettingsInputSchema } from '../contracts/index.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { recordCommittedOperation,recordTrustedResult } from '../analytics/command-collector.js';
import type { CoreCommandInputs, CoreCommandName, CoreStoragePort, StorageCommandEnvelope, StorageRejectionCode } from '../storage/contracts.js';
import type { CredentialRequest, CredentialResult, CredentialStoragePort } from '../storage/credential-contracts.js';

type C = Context<RelayEnv>;
async function accountBody(c:C,maxBytes:number):Promise<Uint8Array>{
  const reader=c.req.raw.body?.getReader();if(!reader)throw new StorageContractError('INVALID_ARGUMENT');
  let size=0;const chunks:Uint8Array[]=[];
  try{
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;
      if(size>maxBytes){void reader.cancel().catch(()=>undefined);throw new StorageContractError('PAYLOAD_TOO_LARGE');}chunks.push(item.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return bytes;
  }finally{reader.releaseLock();}
}
async function accountSettingsBody(c:C):Promise<unknown>{
  const bytes=await accountBody(c,4096);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new StorageContractError('INVALID_ARGUMENT');}
}
export function createStoredAuthModule(options: {
  port: CoreStoragePort & CredentialStoragePort; storeId: string; generation: number; workspacePath: string;
  recheckUserAccess: (userId: string) => void | Promise<void>;
  publishUser?: (user: PublicUserDto) => void | Promise<void>;
  notificationPreferencesChanged?:(userId:string)=>void|Promise<void>;
  themeSettingsChanged?:(userId:string)=>void|Promise<void>;
  getCatalog?:(engine:EngineId)=>Promise<EngineModelCatalog>;
  remoteAddress?: (c: C) => string | undefined;
  observeLogin?:(c:C,input:{id:string;result:'success'|'rejected'|'throttled'|'error';userId?:string;role?:'admin'|'member'})=>void;
  loginTokens?: LoginIntentTokens;
  limiters?: { loginClient?: LoginAttemptLimiter; loginIp?: LoginAttemptLimiter;
    credentialClient?: LoginAttemptLimiter; credentialIp?: LoginAttemptLimiter };
}) {
  options = Object.freeze({ ...options });
  const router = new Hono<RelayEnv>();
  const credentials = new StoredCredentialService(options.port, options);
  const tokens = options.loginTokens ?? new LoginIntentTokens();
  const loginClient = options.limiters?.loginClient ?? new LoginAttemptLimiter();
  const loginIp = options.limiters?.loginIp ?? new LoginAttemptLimiter({ maxFailures: 50 });
  const credentialClient = options.limiters?.credentialClient ?? new LoginAttemptLimiter();
  const credentialIp = options.limiters?.credentialIp ?? new LoginAttemptLimiter();
  const uuid = z.string().uuid();
  const secure = (c: C) => isSecureRelayRequest(c.req.url, c.req.header('x-forwarded-proto'), c.req.header('x-forwarded-host'));
  const peer = options.remoteAddress ?? ((c: C) => { try { return getConnInfo(c).remote.address; } catch { return undefined; } });
  const ip = (c: C) => getHttpClientIp(c, peer(c));
  const clientId = (c: C) => {
    const current = getClientIdFromCookieHeader(c.req.header('cookie')); if (current) return current;
    const created = createClientId(); c.header('Set-Cookie', serializeClientIdCookie(created, secure(c)), { append: true }); return created;
  };
  const key = (c: C): string | Response => {
    const parsed = uuid.safeParse(c.req.header('x-relay-operation-id') ?? randomUUID());
    if (!parsed.success) return c.json(presentApiError('操作标识无效'), 400);
    c.header('x-relay-operation-id', parsed.data); return parsed.data;
  };
  const unavailable = (c: C, unknown = false) => c.json(presentApiError(unknown ? '操作结果暂时无法确认，请刷新状态核对' : '存储暂不可用，请稍后重试',
    { code: unknown ? 'STORAGE_RESULT_UNKNOWN' : 'STORAGE_UNAVAILABLE' }), 503);
  const error = (c: C, code: StorageRejectionCode) => {
    if (code === 'FORBIDDEN') return c.json(presentApiError('没有权限执行该操作'), 403);
    if (code === 'NOT_FOUND') return c.json(presentApiError('账号或项目不存在'), 404);
    if (code === 'INVALID_ARGUMENT') return c.json(presentApiError('请求参数无效'), 400);
    if(code==='PAYLOAD_TOO_LARGE')return c.json(presentApiError('请求内容过大',{code}),413);
    if (code === 'CONFLICT' || code === 'OPERATION_EXPIRED') return c.json(presentApiError('操作冲突或已过期，请刷新状态', { code }), 409);
    return unavailable(c);
  };
  router.onError((failure, c) => failure instanceof StorageContractError ? error(c, failure.code) : unavailable(c));
  const origin = (c: C) => isAllowedOrigin(c.req.header('origin')) ? null : c.json(presentApiError('请求来源不受允许', { code: 'ACCOUNT_ORIGIN_FORBIDDEN' }), 403);
  const guard = createRequireStoredUserSession(options.port);
  for (const path of ['/me', '/profile', '/change-password', '/change-username', '/users', '/users/:id/disabled',
    '/users/:id/project-permission', '/users/:id/reset-password', '/default-project','/default-engine','/default-model','/avatar','/users/:id/avatar','/notification-preferences','/preview-preferences','/theme-settings','/tools-settings']) router.use(path, guard);
  const actor = (c: C) => c.get('relayAuthSession')!;
  const principal = (c: C) => c.get('relayStoragePrincipal')!;
  const admin = (c: C) => actor(c).user.role === 'admin' ? null : c.json(presentApiError('仅管理员可以管理账号'), 403);
  function limited(c: C, first: LoginAttemptLimiter, a: string, second: LoginAttemptLimiter, b: string, message: string) {
    const retry = Math.max(first.getRetryAfterSeconds(a), second.getRetryAfterSeconds(b));
    if (!retry) return null;
    c.header('Retry-After', String(retry)); return c.json(presentApiError(`${message}，请在 ${formatLoginRetryAfter(retry)}后重试`), 429);
  }
  function failed(c: C, first: LoginAttemptLimiter, a: string, second: LoginAttemptLimiter, b: string, login: boolean) {
    first.recordFailure(a); second.recordFailure(b);
    return limited(c, first, a, second, b, login ? '登录失败次数过多' : '当前密码验证失败次数过多')
      ?? c.json(presentApiError(login ? '用户名或密码错误' : '当前密码不正确'), login ? 401 : 403);
  }
  async function changed(userId: string) {
    try { await options.recheckUserAccess(userId); } catch { console.warn('[Auth] 连接权限重核暂不可用'); }
  }
  async function currentUser(c: C, userId: string, status: 200 | 201 = 200) {
    await changed(userId); // Revocation cannot depend on the optional public projection succeeding.
    let user: PublicUserDto;
    try { user = await options.port.readPublicUser({ principal: principal(c), userId }); }
    catch { return c.json(presentApiError('操作已保存，账号状态暂时无法刷新', { code: 'ACCOUNT_STATE_UNAVAILABLE' }), 503); }
    if (options.publishUser) try { await options.publishUser(user); } catch { console.warn('[Auth] 账号操作已提交，用户状态通知失败'); }
    return c.json(UserResponseDtoSchema.parse({ user }), status);
  }
  function credentialError(c: C, result: Exclude<CredentialResult, { state: 'committed' }>): Response {
    if (result.state === 'unknown') return unavailable(c, true);
    if (result.reason === 'same_password' || result.reason === 'same_username' || result.reason === 'self_target') return c.json(presentApiError('新值与当前值相同或目标账号无效'), 400);
    if (result.reason === 'username_exists') return c.json(presentApiError('该登录名已被使用'), 409);
    if (result.reason === 'invalid_current_password') return c.json(presentApiError('当前密码不正确'), 403);
    if (result.reason === 'project_unavailable') return c.json(presentApiError('选择的协作项目不存在'), 400);
    return error(c, result.code);
  }
  const core = <K extends CoreCommandName>(c: C, id: string, name: K, input: CoreCommandInputs[K]) => executeStoredCommand<K>(options.port, {
    protocolVersion: 1, storeId: options.storeId, workerGeneration: options.generation, requestId: randomUUID(), operationId: `account:${id}`,
    principal: principal(c), command: { name, input },
  } as StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } });

  router.post('/login', async (c) => {
    const denied = origin(c); if (denied) return denied;
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('请输入用户名和密码'), 400);
    const policy = resolveLoginSessionPolicy({ purpose: parsed.data.purpose, marker: c.req.header('x-relay-acceptance'), remoteAddress: peer(c),
      proxiedClientAddress: c.req.header('x-relay-client-address'), forwardedHost: c.req.header('x-forwarded-host'), forwardedProto: c.req.header('x-forwarded-proto') });
    if (!policy) return c.json(presentApiError('无头验收长会话只允许本机管理员认证'), 403);
    const eventIntent=uuid.safeParse(c.req.header('x-relay-operation-id'));
    const eventId=eventIntent.success?eventIntent.data:randomUUID();
    const report=(result:'success'|'rejected'|'throttled'|'error',user?:PublicUserDto)=>{
      if(parsed.data.purpose==='headless_acceptance')return;
      try{options.observeLogin?.(c,{id:eventId,result,userId:user?.id,role:user?.role});}catch{/* Statistics cannot block login. */}
    };
    const address = ip(c), client = clientId(c), scope = `${address}|${client}`;
    const wait = limited(c, loginClient, scope, loginIp, address, '登录失败次数过多'); if (wait) {report('throttled');return wait;}
    const id = key(c); if (id instanceof Response) return id;
    const held = tokens.acquire(id, scope);
    const request: CredentialRequest<'auth.login'> = { protocolVersion: 1, storeId: options.storeId, workerGeneration: options.generation,
      requestId: randomUUID(), operationId: `credential:${id}`, principal: { kind: 'login' }, command: { name: 'auth.login',
        input: { username: parsed.data.username, password: parsed.data.password, tokenHash: held.tokenHash, ...policy } } };
    const result = await credentials.run(request).catch(error=>{report('error');throw error;});
    if (result.state !== 'committed') {
      if (result.state === 'rejected' && result.reason === 'invalid_credentials') {const response=failed(c, loginClient, scope, loginIp, address, true);report(response.status===429?'throttled':'rejected');return response;}
      if (result.state === 'rejected' && result.code === 'CONFLICT') {
        const attempt = failed(c, loginClient, scope, loginIp, address, true);
        report(attempt.status===429?'throttled':'error');
        return attempt.status === 429 ? attempt : error(c, 'CONFLICT');
      }
      report('error');
      if (result.state === 'rejected' && result.code === 'FORBIDDEN') return error(c, 'OPERATION_EXPIRED');
      return credentialError(c, result);
    }
    loginClient.clear(scope);
    report('success',result.value.user);
    c.header('Set-Cookie', serializeSessionCookie(held.token, result.value.expiresAt, secure(c), result.value.ttlMs), { append: true });
    return c.json(AuthResponseDtoSchema.parse({ user: result.value.user, expiresAt: result.value.expiresAt }));
  });
  router.get('/me', (c) => c.json(AuthResponseDtoSchema.parse({ user: actor(c).user })));
  router.get('/users/:id/avatar',async c=>{
    const id=z.string().min(1).max(256).safeParse(c.req.param('id'));if(!id.success)return error(c,'INVALID_ARGUMENT');
    const avatar=await options.port.readUserAvatar({principal:principal(c),userId:id.data});
    if(!avatar)return c.json(presentApiError('头像不存在'),404);
    return c.body(Buffer.from(avatar.data,'base64'),200,{'Content-Type':avatar.mime,'Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});
  });
  router.put('/avatar',async c=>{
    const denied=origin(c);if(denied)return denied;
    const bytes=await accountBody(c,MAX_AVATAR_BYTES),validation=validateAvatarUpload(c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase()??'',bytes);
    if(!validation.ok)return c.json(presentApiError(validation.error),400);
    const id=key(c);if(id instanceof Response)return id;
    const result=await core(c,id,'account.setAvatar',{mime:validation.mime,data:Buffer.from(bytes).toString('base64')});
    if(result.state!=='committed')return result.state==='unknown'?unavailable(c,true):error(c,result.code);
    return currentUser(c,actor(c).user.id);
  });
  router.delete('/avatar',async c=>{
    const denied=origin(c);if(denied)return denied;const id=key(c);if(id instanceof Response)return id;
    const result=await core(c,id,'account.setAvatar',{mime:null,data:null});
    if(result.state!=='committed')return result.state==='unknown'?unavailable(c,true):error(c,result.code);
    return currentUser(c,actor(c).user.id);
  });
  router.patch('/default-engine',async c=>{
    const denied=origin(c);if(denied)return denied;
    const body=defaultEnginePatchSchema.safeParse(await accountSettingsBody(c));if(!body.success)return c.json(presentApiError('默认引擎格式无效'),400);
    const id=key(c);if(id instanceof Response)return id;const result=await core(c,id,'account.setDefaultEngine',body.data);
    if(result.state!=='committed')return result.state==='unknown'?unavailable(c,true):error(c,result.code);
    return currentUser(c,actor(c).user.id);
  });
  router.patch('/default-model',async c=>{
    const denied=origin(c);if(denied)return denied;
    const body=defaultModelPatchSchema.safeParse(await accountSettingsBody(c));if(!body.success)return c.json(presentApiError('默认模型格式无效'),400);
    const expectedEngine=actor(c).user.defaultEngine;
    if(body.data.modelId!==null){
      try{if(!options.getCatalog)throw new StorageContractError('STORAGE_UNAVAILABLE');validateEnginePreferences(await options.getCatalog(expectedEngine),{modelId:body.data.modelId,reasoningEffort:null});}
      catch(failure){return failure instanceof EnginePreferencesValidationError?c.json(presentApiError(failure.message,{code:failure.code}),422):unavailable(c);}
    }
    const id=key(c);if(id instanceof Response)return id;
    const result=await core(c,id,'account.setDefaultModel',{expectedEngine,modelId:body.data.modelId});
    if(result.state==='rejected'&&result.code==='CONFLICT'){
      const current=await options.port.readPublicUser({principal:principal(c),userId:actor(c).user.id});
      if(current.defaultEngine!==expectedEngine)return c.json(presentApiError('默认引擎已变化，请重新选择模型',{code:'DEFAULT_ENGINE_CHANGED'}),409);
    }
    if(result.state!=='committed')return result.state==='unknown'?unavailable(c,true):error(c,result.code);
    return currentUser(c,actor(c).user.id);
  });
  router.post('/logout', async (c) => {
    const denied = origin(c); if (denied) return denied;
    const session = await authenticateStoredSession(getSessionTokenFromCookieHeader(c.req.header('cookie')), options.port);
    if (session) {
      const id = key(c); if (id instanceof Response) return id;
      const request = credentials.prepareLogout({ kind: 'user', userId: session.user.id, authSessionHash: session.tokenHash });
      request.operationId = `credential:${id}`;
      const result = await credentials.run(request);
      if (result.state !== 'committed') { if (result.state === 'unknown') await changed(session.user.id); return credentialError(c, result); }
      recordTrustedResult(options.port,{userId:session.user.id,role:session.user.role},'auth','logout',request.operationId);
      await changed(session.user.id);
    }
    c.header('Set-Cookie', serializeClearSessionCookie(secure(c)), { append: true }); return c.json(OkDtoSchema.parse({ ok: true }));
  });
  router.get('/users', async (c) => { const denied = admin(c); if (denied) return denied;
    return c.json(UserListResponseDtoSchema.parse({ users: await options.port.listPublicUsers({ principal: principal(c) }) })); });
  router.post('/users', async (c) => {
    const denied = admin(c) ?? origin(c); if (denied) return denied;
    const body = createMemberSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(presentApiError('账号资料格式无效'), 400);
    const id = key(c); if (id instanceof Response) return id;
    const request = credentials.prepareCreateMember(principal(c), { ...body.data, projectIds: [...new Set(body.data.projectIds)], workspacePath: options.workspacePath });
    request.operationId = `credential:${id}`;
    const result = await credentials.run(request); if (result.state !== 'committed') return credentialError(c, result);
    recordCommittedOperation('account_admin','create',request.operationId);
    return currentUser(c, result.value.user.id, 201);
  });
  router.patch('/profile', async (c) => {
    const denied = origin(c); if (denied) return denied;
    const body = profilePatchSchema.safeParse(await c.req.json().catch(() => null)); if (!body.success) return c.json(presentApiError('昵称格式无效'), 400);
    const id = key(c); if (id instanceof Response) return id;
    const result = await core(c, id, 'account.setDisplayName', { displayName: body.data.displayName || null });
    if (result.state !== 'committed') return result.state === 'unknown' ? unavailable(c, true) : error(c, result.code);
    return currentUser(c, actor(c).user.id);
  });
  router.get('/notification-preferences',async(c)=>{
    c.header('Cache-Control','private, no-store');
    return c.json(NotificationPreferencesResponseDtoSchema.parse({preferences:await options.port.readNotificationPreferences({principal:principal(c)})}));
  });
  router.get('/tools-settings',async(c)=>{
    c.header('Cache-Control','private, no-store');
    return c.json(ToolsStateSchema.parse(await options.port.readToolsSettings({principal:principal(c)})));
  });
  router.patch('/tools-settings',async(c)=>{
    c.header('Cache-Control','private, no-store');const denied=origin(c);if(denied)return denied;
    const body=ToolsActionSchema.safeParse(await accountSettingsBody(c));if(!body.success)return error(c,'INVALID_ARGUMENT');
    const id=key(c);if(id instanceof Response)return id;
    const result=await core(c,id,'account.changeTools',body.data);
    if(result.state!=='committed')return result.state==='unknown'?unavailable(c,true):error(c,result.code);
    return c.json(ToolsStateSchema.parse(await options.port.readToolsSettings({principal:principal(c)})));
  });
  router.patch('/notification-preferences',async(c)=>{
    c.header('Cache-Control','private, no-store');const denied=origin(c);if(denied)return denied;
    const body=NotificationPreferencesPatchSchema.safeParse(await accountSettingsBody(c));if(!body.success)return error(c,'INVALID_ARGUMENT');
    const id=key(c);if(id instanceof Response)return id;
    const result=await core(c,id,'account.setNotifications',{changes:body.data});
    if(result.state!=='committed')return result.state==='unknown'?unavailable(c,true):error(c,result.code);
    try{await options.notificationPreferencesChanged?.(actor(c).user.id);}catch{/* Committed preference is recovered on GET/reconnect. */}
    return c.json(NotificationPreferencesResponseDtoSchema.parse({preferences:await options.port.readNotificationPreferences({principal:principal(c)})}));
  });
  router.get('/preview-preferences',async(c)=>{
    c.header('Cache-Control','private, no-store');
    return c.json(PreviewPreferencesSchema.parse(await options.port.readPreviewPreferences({principal:principal(c)})));
  });
  router.patch('/preview-preferences',async(c)=>{
    c.header('Cache-Control','private, no-store');const denied=origin(c);if(denied)return denied;
    const body=PreviewPreferencesPatchSchema.safeParse(await accountSettingsBody(c));if(!body.success)return error(c,'INVALID_ARGUMENT');
    const id=key(c);if(id instanceof Response)return id;
    const result=await core(c,id,'account.setPreviewPreferences',{changes:body.data});
    if(result.state!=='committed')return result.state==='unknown'?unavailable(c,true):error(c,result.code);
    return c.json(PreviewPreferencesSchema.parse(await options.port.readPreviewPreferences({principal:principal(c)})));
  });
  router.get('/theme-settings',async(c)=>{
    c.header('Cache-Control','private, no-store');return c.json(AccountThemeSettingsResponseDtoSchema.parse({settings:await options.port.readThemeSettings({principal:principal(c)})}));
  });
  router.put('/theme-settings',async(c)=>{
    c.header('Cache-Control','private, no-store');const denied=origin(c);if(denied)return denied;
    const body=ThemeSettingsInputSchema.safeParse(await accountSettingsBody(c));if(!body.success)return error(c,'INVALID_ARGUMENT');
    const id=key(c);if(id instanceof Response)return id;const result=await core(c,id,'account.setTheme',{settings:body.data});
    if(result.state!=='committed')return result.state==='unknown'?unavailable(c,true):error(c,result.code);
    try{await options.themeSettingsChanged?.(actor(c).user.id);}catch{/* GET and reconnect reload committed truth. */}
    return c.json(AccountThemeSettingsResponseDtoSchema.parse({settings:await options.port.readThemeSettings({principal:principal(c)})}));
  });
  for (const route of ['/change-password', '/change-username', '/users/:id/reset-password'] as const) router.post(route, async (c) => {
    const reset = route.includes('/users/'), rename = route === '/change-username';
    const denied = (reset ? admin(c) : null) ?? origin(c); if (denied) return denied;
    const schema = rename ? changeUsernameSchema : reset ? adminResetPasswordSchema : changePasswordSchema;
    const body = schema.safeParse(await c.req.json().catch(() => null)); if (!body.success) return c.json(presentApiError('登录名或密码格式无效'), 400);
    const clientKey = `${actor(c).user.id}|${clientId(c)}`, ipKey = `${actor(c).user.id}|${ip(c)}`;
    const wait = limited(c, credentialClient, clientKey, credentialIp, ipKey, '当前密码验证失败次数过多'); if (wait) return wait;
    const id = key(c); if (id instanceof Response) return id;
    const target = reset ? c.req.param('id')! : actor(c).user.id;
    if (reset && !uuid.safeParse(target).success) return c.json(presentApiError('账号标识无效'), 400);
    const input = body.data;
    const request = rename && 'username' in input ? credentials.prepareRename(principal(c), input.currentPassword, input.username)
      : reset && 'newPassword' in input ? credentials.preparePasswordReset(principal(c), input.currentPassword, target, input.newPassword)
      : 'newPassword' in input ? credentials.preparePasswordChange(principal(c), input.currentPassword, input.newPassword) : null;
    if (!request) return c.json(presentApiError('凭据参数无效'), 400);
    request.operationId = `credential:${id}`;
    const result = await credentials.run(request);
    if (result.state !== 'committed') {
      if (result.state === 'unknown') await changed(target);
      if (result.state === 'rejected' && result.reason === 'invalid_current_password') return failed(c, credentialClient, clientKey, credentialIp, ipKey, false);
      return credentialError(c, result);
    }
    credentialClient.clear(clientKey); credentialIp.clear(ipKey);
    recordCommittedOperation(reset?'account_admin':'auth',reset?'reset_password':rename?'change_username':'change_password',request.operationId);
    if (rename) return currentUser(c, target);
    await changed(target);
    if (!reset) c.header('Set-Cookie', serializeClearSessionCookie(secure(c)), { append: true });
    return c.json(OkDtoSchema.parse({ ok: true }));
  });
  for (const route of ['/users/:id/disabled', '/users/:id/project-permission', '/default-project'] as const) router.patch(route, async (c) => {
    const ownDefault = route === '/default-project';
    const denied = (ownDefault ? null : admin(c)) ?? origin(c); if (denied) return denied;
    const schema = ownDefault ? defaultProjectPatchSchema : route.endsWith('/disabled') ? userDisabledPatchSchema : userProjectPermissionPatchSchema;
    const body = schema.safeParse(await c.req.json().catch(() => null)); if (!body.success) return c.json(presentApiError('账号或项目参数无效'), 400);
    const target = ownDefault ? actor(c).user.id : c.req.param('id')!;
    if (!ownDefault && !uuid.safeParse(target).success) return c.json(presentApiError('账号标识无效'), 400);
    const id = key(c); if (id instanceof Response) return id;
    const input = body.data;
    const result = 'projectId' in input ? await core(c, id, 'account.setDefaultProject', input)
      : 'disabled' in input ? await core(c, id, 'account.setDisabled', { userId: target, disabled: input.disabled })
      : await core(c, id, 'account.setProjectCreation', { userId: target, allowed: input.canCreateProject });
    if (result.state !== 'committed') {
      if (result.state === 'unknown') await changed(target);
      return result.state === 'unknown' ? unavailable(c, true) : error(c, result.code);
    }
    return currentUser(c, target);
  });
  return { router, dispose: () => tokens.dispose() };
}
