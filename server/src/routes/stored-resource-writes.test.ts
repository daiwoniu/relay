import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createStoredResourceWritesRouter } from './stored-resource-writes.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import type { StorageCommandEnvelope } from '../storage/contracts.js';
import { StoredSoftDelete,type SoftDeleteOutcome } from '../services/stored-soft-delete.js';
import { serve } from '@hono/node-server';

const project = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const operation = '33333333-3333-4333-8333-333333333333';
const cookie = (id = 'owner') => serializeSessionCookie(`synthetic-resource-${id}`, Date.now()+600_000, false);
async function prepared(softDelete?:Pick<StoredSoftDelete,'delete'>) {
  const f = fixture();
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','owner','D:/synthetic-http','HTTP');
    INSERT INTO sessions(id,owner_user_id,project_id,status,engine,message_revision) VALUES('${session}','owner','${project}','idle','codex',0);
    UPDATE users SET default_project_id='${project}' WHERE id='owner'`);
  for (const id of ['owner','other','admin']) f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hashSessionToken(`synthetic-resource-${id}`)}','${id}',${Date.now()+600_000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const initialized: string[] = [], changed: unknown[] = []; const blocked = new Set<string>();
  const hooks = { prepareProject: async (value: string) => value, initializeProjectFiles: async (value: string) => { initialized.push(value); },
    getCatalog: async () => ({ models: [{ id: 'valid-model', isDefault: true, reasoning: { options: [{ id: 'high' }] }, serviceTiers: [{ id: 'fast' }] }] } as any),
    isEngineAvailable: async () => true, assertNotDeleting: (_kind: 'project' | 'session', id: string) => { if (blocked.has(id)) throw new StorageContractError('CONFLICT'); },
    changed: async (kind: 'project' | 'session', id: string) => { changed.push({ kind, id }); } };
  // Indirection lets individual tests inject asynchronous failures into the actual candidate router.
  const app = new Hono().route('/api', createStoredResourceWritesRouter({ port, storeId: 'store', generation: 1,
    softDelete,
    prepareProject: (...args) => hooks.prepareProject(...args), initializeProjectFiles: (...args) => hooks.initializeProjectFiles(...args),
    getCatalog: (..._args) => hooks.getCatalog(), isEngineAvailable: (..._args) => hooks.isEngineAvailable(),
    assertNotDeleting: (...args) => hooks.assertNotDeleting(...args), changed: (...args) => hooks.changed(...args) }));
  app.get('/api/public-probe', (c) => c.text('public'));
  const request = (url: string, body: unknown, key = operation, user = 'owner', method = url === '/api/projects' || url === '/api/sessions' ? 'POST' : 'PATCH') => app.request(url, {
    method, headers: { cookie: cookie(user), 'content-type': 'application/json', 'x-relay-operation-id': key }, body: JSON.stringify(body),
  });
  return { f, port, app, request, initialized, changed, blocked, hooks, cleanup: async () => { await port.close(); f.cleanup(); } };
}

test('resource HTTP creates stable project/session identities across retries and returns current projections', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.app.request('/api/public-probe')).status, 200);
    const first = await p.request('/api/projects', { path: 'D:/new-http', name: 'First' }); assert.equal(first.status, 201);
    const projectDto = await first.json() as any; assert.equal(projectDto.owner.id, 'owner');
    assert.deepEqual(p.initialized, ['D:/new-http']);
    const updated = await p.request(`/api/projects/${projectDto.id}`, { name: 'Newer', pinned: 1 }, randomUUID()); assert.equal(updated.status, 200);
    const retry = await p.request('/api/projects', { path: 'D:/new-http', name: 'First' }); assert.equal(retry.status, 201);
    assert.equal((await retry.json() as any).name, 'Newer');
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE path='D:/new-http'"), 1);
    const key = randomUUID(); const body = { projectId: project, title: 'Draft' };
    const created = await p.request('/api/sessions', body, key); assert.equal(created.status, 201);
    const dto = await created.json() as any; assert.equal(dto.engine, null);
    const repeated = await p.request('/api/sessions', body, key); assert.equal(repeated.status, 201); assert.equal((await repeated.json() as any).id, dto.id);
    assert.equal((await p.request('/api/sessions', { ...body, title: 'Different' }, key)).status, 409);
    assert.equal((await p.request(`/api/sessions/${dto.id}`, { title: 'Latest' }, randomUUID())).status, 200);
    const replay = await p.request('/api/sessions', body, key); assert.equal((await replay.json() as any).title, 'Latest');
  } finally { await p.cleanup(); }
});

test('soft deletion HTTP validates retained keys, empty bodies, origin and current login before coordination',async()=>{
  const calls:unknown[]=[];const p=await prepared({delete:async(...args)=>{calls.push(args);return{state:'committed'};}});
  try{
    const url=`/api/sessions/${session}`,headers={cookie:cookie(),'x-relay-operation-id':operation};
    const send=(extra:RequestInit={})=>p.app.request(url,{method:'DELETE',headers,...extra});
    assert.equal((await send({headers:{'x-relay-operation-id':operation}})).status,401);
    assert.equal((await send({headers:{...headers,origin:'https://hostile.invalid'}})).status,403);
    assert.equal((await send({headers:{cookie:cookie()}})).status,400);
    assert.equal((await send({headers:{...headers,'x-relay-operation-id':'bad'}})).status,400);
    assert.equal((await send({body:JSON.stringify({principal:{kind:'system',purpose:'maintenance'},threadId:'injected'})})).status,400);
    assert.equal((await p.app.request(url+'?jobId=injected',{method:'DELETE',headers})).status,400);
    assert.equal(calls.length,0);
    const response=await send();assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-relay-operation-id'),operation);
    assert.deepEqual(calls,[[{kind:'user',userId:'owner',authSessionHash:hashSessionToken('synthetic-resource-owner')},{kind:'session',id:session},operation]]);
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");assert.equal((await send()).status,401);assert.equal(calls.length,1);
  }finally{await p.cleanup();}
});

test('soft deletion HTTP maps unknown and rejections without leaking private jobs or provider errors',async()=>{
  let outcome:SoftDeleteOutcome={state:'unknown'};let error:Error|undefined;
  const p=await prepared({delete:async()=>{if(error)throw error;return outcome;}});
  try{const send=()=>p.app.request(`/api/projects/${project}`,{method:'DELETE',headers:{cookie:cookie(),'x-relay-operation-id':operation}});
    const unknown=await send();assert.equal(unknown.status,503);assert.equal((await unknown.json() as any).code,'SOFT_DELETE_RESULT_UNKNOWN');assert.equal(unknown.headers.get('x-relay-operation-id'),operation);
    for(const [code,status]of [['FORBIDDEN',404],['NOT_FOUND',404],['CONFLICT',409],['OPERATION_EXPIRED',409],['OVERLOADED',503]] as const){outcome={state:'rejected',code};assert.equal((await send()).status,status);}
    error=new Error('private-thread-token-path');const unavailable=await send();assert.equal(unavailable.status,503);assert.ok(!(await unavailable.text()).includes('private-thread'));
  }finally{await p.cleanup();}
});

test('soft deletion HTTP without a coordinator is explicitly unavailable',async()=>{
  const p=await prepared();try{const result=await p.app.request(`/api/sessions/${session}`,{method:'DELETE',headers:{cookie:cookie(),'x-relay-operation-id':operation}});assert.equal(result.status,503);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),0);
  }finally{await p.cleanup();}
});

test('real candidate HTTP and Native Worker delete once, retain history, and reject foreign targets',async()=>{
  const p=await prepared();let calls=0,archived=false;
  const service=new StoredSoftDelete({port:p.port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},isThreadArchived:async()=>archived,
    archiveThread:async(_id,guard)=>{assert.equal(await guard(),true);calls++;archived=true;},closeIdleConnection:()=>{},changed:()=>{}});
  try{p.f.mutate(`UPDATE sessions SET status='completed',engine_bound=1,codex_thread_id='synthetic-http-thread',engine_session_id='synthetic-http-thread' WHERE id='${session}';
    INSERT INTO messages(id,session_id,role,content,created_at) VALUES('http-delete-message','${session}','user','retained',1)`);
    const app=new Hono().route('/api',createStoredResourceWritesRouter({port:p.port,storeId:'store',generation:1,...p.hooks,softDelete:service}));
    const send=(user='owner',key=operation)=>app.request(`/api/sessions/${session}`,{method:'DELETE',headers:{cookie:cookie(user),'x-relay-operation-id':key}});
    assert.equal((await send('other')).status,404);assert.equal(calls,0);
    assert.equal((await send()).status,200);assert.equal((await send()).status,200);assert.equal(calls,0);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),1);
    assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='http-delete-message'"),'retained');assert.notEqual(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${session}'`),null);
    const guard=()=>p.port.checkSoftDeleteClose({principal:{kind:'user',userId:'owner',authSessionHash:hashSessionToken('synthetic-resource-owner')},jobId:p.f.scalar('SELECT id FROM _relay_soft_delete_jobs') as string,sessionId:session,threadId:'synthetic-http-thread'});
    assert.equal(await guard(),true);
    // A later restore must survive replay of the original DELETE receipt.
    p.f.mutate(`UPDATE sessions SET deleted_at=NULL WHERE id='${session}'`);assert.equal(await guard(),false);assert.equal((await send()).status,200);assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${session}'`),null);assert.equal(calls,0);
  }finally{await service.close();await p.cleanup();}
});
test('browser request client deletes sessions and projects through the real Native coordinator',async()=>{
  // Load the browser client at runtime: its sources belong to the separate client TS project.
  const {requestJson}=await import(new URL('../../../client/src/api/client.ts',import.meta.url).href);
  const p=await prepared(),originalFetch=globalThis.fetch;
  let archived=false,archiveCalls=0;
  const service=new StoredSoftDelete({port:p.port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},isThreadArchived:async()=>archived,
    archiveThread:async(_id,guard)=>{assert.equal(await guard(),true);archiveCalls++;archived=true;},closeIdleConnection:()=>{},changed:()=>{}});
  const app=new Hono().route('/api',createStoredResourceWritesRouter({port:p.port,storeId:'store',generation:1,...p.hooks,softDelete:service}));
  let server:ReturnType<typeof serve>;
  const address=await new Promise<{port:number}>((resolve)=>{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0},resolve);});
  globalThis.fetch=(async(input,init)=>originalFetch(new URL(String(input),`http://127.0.0.1:${address.port}`),init)) as typeof fetch;
  try{
    p.f.mutate("UPDATE users SET default_project_id=NULL WHERE id='owner'");
    p.f.mutate(`UPDATE sessions SET status='completed',engine_bound=1,codex_thread_id='synthetic-browser-thread',engine_session_id='synthetic-browser-thread' WHERE id='${session}';
      INSERT INTO messages(id,session_id,role,content,created_at) VALUES('browser-delete-message','${session}','user','retained',1)`);
    const invalid=await originalFetch(`http://127.0.0.1:${address.port}/api/sessions/${session}`,{method:'DELETE',headers:{cookie:cookie(),'x-relay-operation-id':randomUUID()},body:'{}'});
    assert.equal(invalid.status,400);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),0);
    for(const [kind,id]of [['session',session],['project',project]]){
      assert.deepEqual(await requestJson(`/api/${kind}s/${id}`,{method:'DELETE',headers:{cookie:cookie()}}),{ok:true});
      assert.notEqual(p.f.scalar(`SELECT deleted_at FROM ${kind}s WHERE id='${id}'`),null);
    }
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),2);
    assert.equal(archiveCalls,0);
    assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='browser-delete-message'"),'retained');
  }finally{globalThis.fetch=originalFetch;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await service.close();await p.cleanup();}
});

test('resource writes reject spoofed ownership, origins, malformed DTOs, disabled creation and deletion fences', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await p.request('/api/sessions', { projectId: project, owner_user_id: 'other' })).status, 400);
    assert.equal((await p.request(`/api/projects/${project}`, { pinned: true })).status, 400);
    assert.equal((await p.request(`/api/sessions/${session}`, { status: 'completed' })).status, 400);
    assert.equal((await p.request(`/api/sessions/${session}`, { title: 'no' }, 'invalid')).status, 400);
    assert.equal((await p.app.request('/api/projects', { method: 'POST', headers: { cookie: cookie(), origin: 'https://untrusted.invalid' }, body: '{}' })).status, 403);
    assert.equal((await p.app.request('/api/sessions', { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/json' }, body: '{' })).status, 400);
    p.f.mutate("UPDATE users SET can_create_project=0 WHERE id='owner'");
    assert.equal((await p.request('/api/projects', { path: 'D:/denied' })).status, 404); assert.equal(p.initialized.length, 0);
    assert.equal((await p.request(`/api/sessions/${session}`, { title: 'No access' }, randomUUID(), 'other')).status, 404);
    p.blocked.add(project); assert.equal((await p.request('/api/sessions', { projectId: project }, randomUUID())).status, 409);
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_storage_operations'), 0);
  } finally { await p.cleanup(); }
});
test('password and access changes during filesystem/catalog awaits are rechecked by the Worker', async () => {
  const p = await prepared();
  try {
    p.hooks.prepareProject = async (value) => { p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'"); return value; };
    assert.equal((await p.request('/api/projects', { path: 'D:/must-not-create' })).status, 404);
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE path='D:/must-not-create'"), 0);
    p.f.mutate("UPDATE users SET must_change_password=0 WHERE id='owner'");
    p.hooks.getCatalog = async () => { p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'"); return { models: [] } as any; };
    const result = await p.request(`/api/sessions/${session}/engine-preferences`, { modelId: null, reasoningEffort: null, expectedRevision: 0 }, randomUUID());
    assert.equal(result.status, 404); assert.equal(p.f.scalar(`SELECT engine_preferences_revision FROM sessions WHERE id='${session}'`), 0);
  } finally { await p.cleanup(); }
});
test('preference updates preserve omitted tier intents and old retries recover before new running/catalog checks', async () => {
  const p = await prepared();
  try {
    const url = `/api/sessions/${session}/engine-preferences`;
    const first = { modelId: 'valid-model', reasoningEffort: 'high', expectedRevision: 0 };
    assert.equal((await p.request(url, first)).status, 200);
    const newTier = { ...first, serviceTier: 'fast', expectedRevision: 1 };
    assert.equal((await p.request(url, newTier, randomUUID())).status, 200);
    p.f.mutate(`UPDATE sessions SET status='processing' WHERE id='${session}'`);
    p.hooks.getCatalog = async () => { throw new Error('must not validate old committed intent again'); };
    const old = await p.request(url, first); assert.equal(old.status, 200);
    const current = (await old.json() as any).session;
    assert.equal(current.engine_preferences.serviceTier, 'fast'); assert.equal(current.engine_preferences.revision, 2);
    assert.equal((await p.request(url, { ...first, modelId: 'different' })).status, 409);
  } finally { await p.cleanup(); }
});
test('known commit, response loss, notification failure and receipt rollback retain distinct HTTP outcomes', async () => {
  const p = await prepared(); const warn = console.warn; const warnings: unknown[] = []; console.warn = (...values) => { warnings.push(values); };
  try {
    const execute = p.port.execute.bind(p.port);
    p.port.execute = (async (request: StorageCommandEnvelope) => { const result = await execute(request);
      return result.state === 'committed' ? { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' } : result;
    }) as typeof p.port.execute;
    p.hooks.changed = async () => { throw new Error('private callback detail'); };
    assert.equal((await p.request(`/api/sessions/${session}`, { title: 'Recovered' })).status, 200);
    assert.equal(warnings.length, 1); assert.equal(JSON.stringify(warnings).includes('private callback detail'), false);
    p.port.readSession = async () => { throw new Error('private projection detail'); };
    const saved = await p.request(`/api/sessions/${session}`, { title: 'Saved' }, randomUUID());
    assert.equal(saved.status, 503); assert.equal((await saved.json() as any).code, 'RESOURCE_STATE_UNAVAILABLE');
    assert.equal(p.f.scalar(`SELECT title FROM sessions WHERE id='${session}'`), 'Saved');
    p.f.mutate("CREATE TRIGGER fail_receipt BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const unknown = await p.request(`/api/sessions/${session}`, { title: 'Rolled back' }, randomUUID());
    assert.equal(unknown.status, 503); assert.equal((await unknown.json() as any).code, 'STORAGE_RESULT_UNKNOWN');
    assert.equal(p.f.scalar(`SELECT title FROM sessions WHERE id='${session}'`), 'Saved');
  } finally { console.warn = warn; await p.cleanup(); }
});
test('project initialization is post-commit, repeatable, and guarded against path replacement and revoked sessions', async () => {
  const p = await prepared();
  try {
    p.hooks.initializeProjectFiles = async () => { throw new Error('private initialization error'); };
    const body = { path: 'D:/initialize-after-commit' };
    const incomplete = await p.request('/api/projects', body); assert.equal(incomplete.status, 503);
    assert.equal((await incomplete.json() as any).code, 'PROJECT_INITIALIZATION_INCOMPLETE');
    assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE path='D:/initialize-after-commit'"), 1);
    p.hooks.initializeProjectFiles = async (value) => { p.initialized.push(value); };
    assert.equal((await p.request('/api/projects', body, randomUUID())).status, 200); assert.equal(p.initialized.length, 1);
    assert.equal((await p.request('/api/projects', body)).status, 201); assert.equal(p.initialized.length, 2);
    let calls = 0; p.hooks.prepareProject = async (value) => ++calls === 1 ? value : 'D:/replacement';
    const changed = await p.request('/api/projects', { path: 'D:/replace-check' }, randomUUID());
    assert.equal(changed.status, 503); assert.equal(p.initialized.length, 2);
    calls = 0; p.hooks.prepareProject = async (value) => { if (++calls === 2) p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'"); return value; };
    const revoked = await p.request('/api/projects', { path: 'D:/revoked-check' }, randomUUID());
    assert.equal(revoked.status, 503); assert.equal(p.initialized.length, 2);
  } finally { await p.cleanup(); }
});
