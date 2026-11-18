import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createStoredAuthModule } from './stored-auth.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredCredentialService } from '../auth/stored-credentials.js';
import { StoredAuthRevocations, type StoredAuthClient } from '../auth/stored-revocations.js';
import { LoginAttemptLimiter } from '../auth/login-limiter.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { hashSessionToken, ACCEPTANCE_SESSION_TTL_MS } from '../auth/session.js';
import type { CredentialRequest } from '../storage/credential-contracts.js';

const adminPassword = 'synthetic-admin-password';
const ownerPassword = 'synthetic-owner-password';
const nextPassword = 'synthetic-next-password';
const clientId = '11111111-1111-4111-8111-111111111111';
const operation = '22222222-2222-4222-8222-222222222222';
const raw = (id: string) => `synthetic-${id}-http`;
const cookie = (id = 'admin') => `relay_session=${raw(id)}; relay_client_id=${clientId}`;
const issuedCookie = (response: Response) => response.headers.get('set-cookie')?.match(/(?:^|[,\s])relay_session=([^;,\s]+)/)?.[1];
type Overrides = Partial<Pick<Parameters<typeof createStoredAuthModule>[0], 'remoteAddress' | 'limiters' | 'loginTokens' | 'recheckUserAccess' | 'getCatalog' | 'observeLogin'>>;

async function prepared(overrides: Overrides = {}) {
  const f = fixture();
  f.mutate(`UPDATE users SET password_hash='${hashPassword(adminPassword)}' WHERE id='admin';
    UPDATE users SET password_hash='${hashPassword(ownerPassword)}' WHERE id='owner'; DELETE FROM auth_sessions;
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES
      ('${hashSessionToken(raw('admin'))}','admin',${Date.now()+600_000}),
      ('${hashSessionToken(raw('owner'))}','owner',${Date.now()+600_000}),
      ('${hashSessionToken(raw('owner-second'))}','owner',${Date.now()+600_000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const revoked: string[] = [], refreshed: string[] = [], rechecks: string[] = [];
  const clients: StoredAuthClient[] = [];
  const addClient = (name: string, userId: string, token: string) => {
    let alive = true;
    clients.push({ userId, tokenHash: hashSessionToken(token), isCurrent: () => alive,
      revoke: (guard) => { if (guard()) { alive = false; revoked.push(name); } },
      refresh: (_, __, guard) => { if (guard()) refreshed.push(name); } });
  };
  addClient('owner', 'owner', raw('owner')); addClient('owner-second', 'owner', raw('owner-second'));
  const bridge = new StoredAuthRevocations(port, () => clients);
  const module = createStoredAuthModule({ port, storeId: 'store', generation: 1, workspacePath: 'D:/synthetic-workspace',
    remoteAddress: () => '127.0.0.1', recheckUserAccess: async (id) => { rechecks.push(id); await bridge.recheckUser(id); }, ...overrides });
  const app = new Hono().route('/api/auth', module.router);
  app.get('/api/public-probe', (c) => c.text('public'));
  const request = (path: string, method = 'GET', body?: unknown, user = 'admin', headers: Record<string,string> = {}) =>
    app.request(`/api/auth${path}`, { method, headers: { cookie: cookie(user), origin: 'http://localhost',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = (username = 'admin', password = adminPassword, headers: Record<string,string> = {}, purpose?: 'headless_acceptance') =>
    request('/login', 'POST', { username, password, ...(purpose ? { purpose } : {}) }, 'admin', { 'x-relay-operation-id': operation, ...headers });
  const member = async () => {
    const result = await new StoredCredentialService(port, { storeId: 'store', generation: 1 }).run(
      new StoredCredentialService(port, { storeId: 'store', generation: 1 }).prepareCreateMember(
        { kind: 'user', userId: 'admin', authSessionHash: hashSessionToken(raw('admin')) },
        { username: 'created-member', initialPassword: nextPassword, workspacePath: 'D:/synthetic-workspace', canCreateProject: true, projectIds: [] }));
    if (result.state !== 'committed') throw new Error('fixture member creation failed');
    return result.value.user;
  };
  return { f, port, app, request, login, member, revoked, refreshed, rechecks, addClient,
    cleanup: async () => { module.dispose(); await port.close(); f.cleanup(); } };
}

test('HTTP login replay issues the same bounded-held token, exports public user only, and logout cannot resurrect it', async () => {
  const observed:Array<{id:string;result:string}>=[];
  const p = await prepared({observeLogin:(_c,event)=>observed.push(event)});
  try {
    const first = await p.login(); assert.equal(first.status, 200);
    const token = issuedCookie(first); assert.ok(token);
    const body = await first.json() as any;
    assert.equal(body.user.id, 'admin'); assert.equal('password_hash' in body.user, false); assert.equal('token' in body, false);
    assert.match(first.headers.get('set-cookie')!, /HttpOnly/); assert.match(first.headers.get('set-cookie')!, /SameSite=Lax/);
    const replay = await p.login(); assert.equal(replay.status, 200); assert.equal(issuedCookie(replay), token);
    assert.equal(observed.length,2);assert.equal(observed[0].id,observed[1].id);assert.equal(observed[0].result,'success');
    assert.equal(p.f.scalar('SELECT count(*) FROM auth_sessions'), 4);
    const conflict = await p.login('admin', 'different-input-password'); assert.equal(conflict.status, 409);
    const me = await p.request('/me', 'GET', undefined, 'admin', { cookie: `relay_session=${token}; relay_client_id=${clientId}` });
    assert.equal(me.status, 200);
    const logout = await p.request('/logout', 'POST', undefined, 'admin', { cookie: `relay_session=${token}; relay_client_id=${clientId}` });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal((await p.login()).status, 409);
    assert.equal((await p.app.request('/api/public-probe')).status, 200);
    const invalid = await p.request('/logout', 'POST', undefined, 'invalid'); assert.equal(invalid.status, 200);
  } finally { await p.cleanup(); }
});

test('登录统计观察失败不会改变真实登录结果',async()=>{
  const p=await prepared({observeLogin:()=>{throw Error('statistics-down');}});
  try{assert.equal((await p.login()).status,200);}finally{await p.cleanup();}
});

test('Native avatar upload/read/delete preserves binary content, access rules and bounded validation',async()=>{
  const p=await prepared();try{
    const png=Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
    const upload=(body:Uint8Array,contentType='image/png',user='owner')=>p.app.request('/api/auth/avatar',{method:'PUT',headers:{cookie:cookie(user),origin:'http://localhost','content-type':contentType},body:new Uint8Array(body).buffer});
    assert.equal((await upload(png,'image/jpeg')).status,400);assert.equal((await upload(new Uint8Array(512*1024+1))).status,413);
    assert.equal((await upload(png,'image/png','invalid')).status,401);
    const saved=await upload(png);assert.equal(saved.status,200);const user=(await saved.json() as any).user;
    assert.equal(user.id,'owner');assert.equal(typeof user.avatarUpdatedAt,'number');assert.equal('avatar_data' in user,false);
    assert.equal((await p.app.request('/api/auth/users/owner/avatar')).status,401);
    const image=await p.request('/users/owner/avatar');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()),png);
    const largest=new Uint8Array(512*1024);largest.set(png);
    assert.equal((await upload(largest)).status,200);
    const fullImage=await p.request('/users/owner/avatar');assert.equal(fullImage.status,200);
    assert.deepEqual(new Uint8Array(await fullImage.arrayBuffer()),largest);
    assert.equal((await p.request('/avatar','DELETE',undefined,'owner',{origin:'https://invalid.example'})).status,403);
    const removed=await p.request('/avatar','DELETE',undefined,'owner');assert.equal(removed.status,200);assert.equal((await removed.json() as any).user.avatarUpdatedAt,null);
    assert.equal((await p.request('/users/owner/avatar')).status,404);
  }finally{await p.cleanup();}
});

test('Native conversation defaults retain same-engine model, clear on engine change and validate the current catalog',async()=>{
  let calls=0;
  const p=await prepared({getCatalog:async engine=>{calls++;return{engineId:engine,fetchedAt:1,stale:false,models:[{id:'synthetic-model',label:'Synthetic',isDefault:true,reasoning:{options:[],default:null}}]} as any;}});
  try{
    const patch=(path:string,body:unknown)=>p.request(path,'PATCH',body,'owner');
    assert.equal((await patch('/default-model',{modelId:'missing'})).status,422);
    const selected=await patch('/default-model',{modelId:'synthetic-model'});assert.equal(selected.status,200);assert.equal((await selected.json() as any).user.defaultModelId,'synthetic-model');
    assert.equal((await patch('/default-engine',{engine:'codex'})).status,200);assert.equal(p.f.scalar("SELECT default_model_id FROM users WHERE id='owner'"),'synthetic-model');
    const switched=await patch('/default-engine',{engine:'codebuddy'});assert.equal(switched.status,200);assert.equal((await switched.json() as any).user.defaultModelId,null);
    assert.equal((await patch('/default-engine',{engine:'unsupported'})).status,400);
    const previousCalls=calls;assert.equal((await patch('/default-model',{modelId:null})).status,200);assert.equal(calls,previousCalls);
    assert.equal(p.f.scalar("SELECT default_engine FROM users WHERE id='admin'"),'codex');
    assert.equal((await p.request('/default-engine','PATCH',{engine:'codex'},'owner',{origin:'https://invalid.example'})).status,403);
    const headers={'x-relay-operation-id':operation};
    assert.equal((await p.request('/default-model','PATCH',{modelId:'synthetic-model'},'owner',headers)).status,200);
    const reused=await p.request('/default-model','PATCH',{modelId:null},'owner',headers);assert.equal(reused.status,409);
    assert.equal((await reused.json() as any).code,'CONFLICT');
  }finally{await p.cleanup();}
});

test('default model cannot commit after a concurrent default-engine change during catalog lookup',async()=>{
  let change=()=>{};
  const p=await prepared({getCatalog:async engine=>{change();return{engineId:engine,fetchedAt:1,stale:false,models:[{id:'synthetic-model'}]} as any;}});
  try{
    change=()=>p.f.mutate("UPDATE users SET default_engine='codebuddy',default_model_id=NULL WHERE id='owner'");
    const response=await p.request('/default-model','PATCH',{modelId:'synthetic-model'},'owner');assert.equal(response.status,409);
    assert.equal((await response.json() as any).code,'DEFAULT_ENGINE_CHANGED');
    assert.equal(p.f.scalar("SELECT default_model_id FROM users WHERE id='owner'"),null);
  }finally{await p.cleanup();}
});

test('login preserves source and local-admin acceptance policy; successful HTTPS cookies are Secure', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.login('admin', adminPassword, { origin: 'https://forbidden-source.invalid' })).status, 403);
    assert.equal((await p.login('admin', adminPassword, {}, 'headless_acceptance')).status, 403);
    assert.equal((await p.login('admin', adminPassword, { 'x-relay-acceptance': 'headless-v1', 'x-forwarded-host': 'remote.invalid' }, 'headless_acceptance')).status, 403);
    const accepted = await p.login('admin', adminPassword, { 'x-relay-acceptance': 'headless-v1' }, 'headless_acceptance');
    assert.equal(accepted.status, 200); const dto = await accepted.json() as any;
    assert.ok(dto.expiresAt > Date.now() + ACCEPTANCE_SESSION_TTL_MS - 60_000);
    const https = await p.app.request('https://localhost/api/auth/login', { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPassword }) });
    assert.equal(https.status, 200); assert.match(https.headers.get('set-cookie')!, /Secure/);
  } finally { await p.cleanup(); }
  const remote = await prepared({ remoteAddress: () => '203.0.113.5' });
  try { assert.equal((await remote.login('admin', adminPassword, { 'x-relay-acceptance': 'headless-v1' }, 'headless_acceptance')).status, 403); }
  finally { await remote.cleanup(); }
});

test('login and current-password limits throttle only definite failures, with Retry-After and no forbidden mutation', async () => {
  const p = await prepared({ limiters: { loginClient: new LoginAttemptLimiter({ maxFailures: 2 }), loginIp: new LoginAttemptLimiter({ maxFailures: 50 }),
    credentialClient: new LoginAttemptLimiter({ maxFailures: 2 }), credentialIp: new LoginAttemptLimiter({ maxFailures: 2 }) } });
  try {
    assert.equal((await p.login('admin', 'wrong-password')).status, 401);
    const locked = await p.login('admin', 'wrong-password'); assert.equal(locked.status, 429); assert.ok(locked.headers.get('retry-after'));
    assert.equal((await p.login()).status, 429); assert.equal(p.f.scalar('SELECT count(*) FROM auth_sessions'), 3);
    const wrong = { currentPassword: 'wrong-password', newPassword: nextPassword };
    assert.equal((await p.request('/change-password', 'POST', wrong, 'owner')).status, 403);
    assert.equal((await p.request('/change-password', 'POST', wrong, 'owner')).status, 429);
    assert.equal((await p.request('/change-password', 'POST', { currentPassword: ownerPassword, newPassword: nextPassword }, 'owner')).status, 429);
    assert.equal(verifyPassword(ownerPassword, String(p.f.scalar("SELECT password_hash FROM users WHERE id='owner'"))), true);
  } finally { await p.cleanup(); }
});

test('登录IP限流采用网关规范来源，不将不同公网访客合并且不接受原始XFF改号', async () => {
  const loginIp = new LoginAttemptLimiter({ maxFailures: 1 });
  const p = await prepared({ limiters: { loginClient: new LoginAttemptLimiter({ maxFailures: 50 }), loginIp } });
  try {
    assert.equal((await p.login('admin', 'wrong-password', { 'x-relay-client-address': '203.0.113.9',
      'x-forwarded-for': '198.51.100.1' })).status, 429);
    assert.ok(loginIp.getRetryAfterSeconds('203.0.113.9') > 0);
    assert.equal(loginIp.getRetryAfterSeconds('127.0.0.1'), 0);
    assert.equal(loginIp.getRetryAfterSeconds('198.51.100.1'), 0);
    assert.equal((await p.login('admin', adminPassword, { 'x-relay-client-address': '203.0.113.9',
      'x-forwarded-for': '198.51.100.2' })).status, 429);
    const other = await p.login('admin', adminPassword, { 'x-relay-client-address': '203.0.113.10',
      'x-relay-operation-id': '33333333-3333-4333-8333-333333333333' });
    assert.equal(other.status, 200);
  } finally { await p.cleanup(); }
});

test('own credential and profile routes await commit, preserve the current rename login and revoke only invalid peers', async () => {
  const p = await prepared();
  try {
    const renamed = await p.request('/change-username', 'POST', { username: 'renamed-owner', currentPassword: ownerPassword }, 'owner');
    assert.equal(renamed.status, 200); assert.equal((await renamed.json() as any).user.username, 'renamed-owner');
    assert.deepEqual(p.revoked, ['owner-second']);
    const profile = await p.request('/profile', 'PATCH', { displayName: 'Fresh Name' }, 'owner'); assert.equal(profile.status, 200);
    assert.equal((await profile.json() as any).user.displayName, 'Fresh Name');
    const password = await p.request('/change-password', 'POST', { currentPassword: ownerPassword, newPassword: nextPassword }, 'owner');
    assert.equal(password.status, 200); assert.match(password.headers.get('set-cookie')!, /Max-Age=0/);
    assert.deepEqual(p.revoked, ['owner-second', 'owner']);
    assert.equal((await p.request('/me', 'GET', undefined, 'owner')).status, 401);
    assert.equal(verifyPassword(nextPassword, String(p.f.scalar("SELECT password_hash FROM users WHERE id='owner'"))), true);
  } finally { await p.cleanup(); }
});

test('admin HTTP member creation, flags and password reset use current projections and record denied reset audit', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.request('/users', 'GET', undefined, 'owner')).status, 403);
    const created = await p.request('/users', 'POST', { username: 'http-member', initialPassword: nextPassword, canCreateProject: false });
    assert.equal(created.status, 201); const user = (await created.json() as any).user;
    assert.equal(user.role, 'member'); assert.equal(user.mustChangePassword, true); assert.equal(user.canCreateProject, false);
    assert.equal((await p.request(`/users/${user.id}/project-permission`, 'PATCH', { canCreateProject: true })).status, 200);
    const wrong = await p.request(`/users/${user.id}/reset-password`, 'POST', { currentPassword: 'wrong-password', newPassword: 'other-target-password' });
    assert.equal(wrong.status, 403);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='account.reset_password' AND result='failed'"), 1);
    const reset = await p.request(`/users/${user.id}/reset-password`, 'POST', { currentPassword: adminPassword, newPassword: 'other-target-password' });
    assert.equal(reset.status, 200);
    const list = await p.request('/users'); assert.equal(list.status, 200);
    assert.equal((await list.json() as any).users.length, 4);
    const inactive = await p.request(`/users/${user.id}/disabled`, 'PATCH', { disabled: true }, 'admin', { 'x-relay-operation-id': operation });
    assert.equal(inactive.status, 200);
    await p.request(`/users/${user.id}/disabled`, 'PATCH', { disabled: false });
    const old = await p.request(`/users/${user.id}/disabled`, 'PATCH', { disabled: true }, 'admin', { 'x-relay-operation-id': operation });
    assert.equal(old.status, 200); assert.equal((await old.json() as any).user.disabledAt, null);
  } finally { await p.cleanup(); }
});

test('RPC reply loss recovers login token; receipt rollback and storage outages never issue false login cookies', async () => {
  const p = await prepared();
  try {
    const execute = p.port.executeCredential.bind(p.port);
    p.port.executeCredential = (async (request: CredentialRequest) => {
      const result = await execute(request);
      return result.state === 'committed' ? { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' } : result;
    }) as typeof p.port.executeCredential;
    assert.equal((await p.login()).status, 200); assert.equal(p.f.scalar('SELECT count(*) FROM auth_sessions'), 4);
    const cold = createStoredAuthModule({ port: p.port, storeId: 'store', generation: 1, workspacePath: 'D:/synthetic-workspace',
      remoteAddress: () => '127.0.0.1', recheckUserAccess: () => undefined });
    try {
      const freshProcess = new Hono().route('/api/auth', cold.router);
      const expired = await freshProcess.request('/api/auth/login', { method: 'POST', headers: {
        cookie: cookie(), 'content-type': 'application/json', 'x-relay-operation-id': operation },
        body: JSON.stringify({ username: 'admin', password: adminPassword }) });
      assert.equal(expired.status, 409); assert.equal(issuedCookie(expired), undefined);
      assert.equal((await expired.json() as any).code, 'OPERATION_EXPIRED');
      assert.equal(p.f.scalar('SELECT count(*) FROM auth_sessions'), 4);
    } finally { cold.dispose(); }
    p.f.mutate("CREATE TRIGGER fail_auth BEFORE INSERT ON _relay_credential_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const rolledBack = await p.login('admin', adminPassword, { 'x-relay-operation-id': '33333333-3333-4333-8333-333333333333' });
    assert.equal(rolledBack.status, 503); assert.equal(issuedCookie(rolledBack), undefined); assert.equal(p.f.scalar('SELECT count(*) FROM auth_sessions'), 4);
    await p.port.close();
    const outage = await p.request('/me'); assert.equal(outage.status, 503);
    assert.equal((await outage.json() as any).code, 'STORAGE_UNAVAILABLE');
    assert.equal(issuedCookie(await p.login('admin', adminPassword, { 'x-relay-operation-id': '44444444-4444-4444-8444-444444444444' })), undefined);
  } finally { await p.cleanup(); }
});

test('post-commit refresh failure still attempts revocation and reports saved state without rollback', async () => {
  const p = await prepared();
  try {
    const user = await p.member();
    p.port.readPublicUser = async () => { throw new Error('synthetic private query error'); };
    const response = await p.request(`/users/${user.id}/disabled`, 'PATCH', { disabled: true });
    assert.equal(response.status, 503); assert.equal((await response.json() as any).code, 'ACCOUNT_STATE_UNAVAILABLE');
    assert.ok(p.rechecks.includes(user.id)); assert.ok(p.f.scalar(`SELECT disabled_at FROM users WHERE id='${user.id}'`));
  } finally { await p.cleanup(); }
});

test('old disable replay rechecks live tokens and cannot disconnect a later legitimate login', async () => {
  const p = await prepared();
  try {
    const user = await p.member();
    const initial = await p.login('created-member', nextPassword);
    const firstToken = issuedCookie(initial); assert.ok(firstToken);
    const change = await p.request('/change-password', 'POST', { currentPassword: nextPassword, newPassword: 'fresh-member-password' }, 'admin',
      { cookie: `relay_session=${firstToken}; relay_client_id=${clientId}` });
    assert.equal(change.status, 200);
    const valid = await p.login('created-member', 'fresh-member-password', { 'x-relay-operation-id': '33333333-3333-4333-8333-333333333333' });
    const oldToken = issuedCookie(valid); assert.ok(oldToken); p.addClient('member-old', user.id, oldToken);
    assert.equal((await p.request(`/users/${user.id}/disabled`, 'PATCH', { disabled: true }, 'admin', { 'x-relay-operation-id': operation })).status, 200);
    assert.ok(p.revoked.includes('member-old'));
    await p.request(`/users/${user.id}/disabled`, 'PATCH', { disabled: false });
    const fresh = await p.login('created-member', 'fresh-member-password', { 'x-relay-operation-id': '44444444-4444-4444-8444-444444444444' });
    const newToken = issuedCookie(fresh); assert.ok(newToken); p.addClient('member-new', user.id, newToken);
    const replay = await p.request(`/users/${user.id}/disabled`, 'PATCH', { disabled: true }, 'admin', { 'x-relay-operation-id': operation });
    assert.equal(replay.status, 200); assert.equal((await replay.json() as any).user.disabledAt, null);
    assert.equal(p.revoked.includes('member-new'), false); assert.ok(p.refreshed.includes('member-new'));
    const selected = await p.request('/default-project', 'PATCH', { projectId: user.defaultProjectId }, 'admin',
      { cookie: `relay_session=${newToken}; relay_client_id=${clientId}` });
    assert.equal(selected.status, 200);
  } finally { await p.cleanup(); }
});

test('denial audit failure is not reported as a verified credential rejection; repeated denied intent audits once', async () => {
  const p = await prepared();
  try {
    const user = await p.member();
    const path = `/users/${user.id}/reset-password`, body = { currentPassword: 'wrong-password', newPassword: 'another-member-password' };
    p.f.mutate("CREATE TRIGGER fail_rejected_audit BEFORE INSERT ON admin_audit_events BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const blocked = await p.request(path, 'POST', body, 'admin', { 'x-relay-operation-id': operation });
    assert.equal(blocked.status, 503); assert.equal((await blocked.json() as any).code, 'STORAGE_RESULT_UNKNOWN');
    assert.equal(verifyPassword(nextPassword, String(p.f.scalar(`SELECT password_hash FROM users WHERE id='${user.id}'`))), true);
    p.f.mutate('DROP TRIGGER fail_rejected_audit');
    for (let i=0; i<2; i++) assert.equal((await p.request(path, 'POST', body, 'admin', { 'x-relay-operation-id': operation })).status, 403);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"), 1);
    await assert.rejects(p.port.readPublicUser({ principal: { kind: 'user', userId: 'owner', authSessionHash: hashSessionToken(raw('owner')) }, userId: 'admin' }), /FORBIDDEN/);
  } finally { await p.cleanup(); }
});
