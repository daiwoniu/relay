import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { StoredFrontendHub } from './stored-frontend-hub.js';
import type { FrontendClient } from './frontend-client-hub.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import { createStoredProjectMembersRouter } from '../routes/stored-project-members.js';
import { createStoredAuthModule } from '../routes/stored-auth.js';
import { RELAY_PROTOCOL_VERSION } from '../contracts/index.js';
import { RuntimeStorage } from '../storage/runtime-storage.js';

const project = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const token = (id: string) => `synthetic-ws-${id}`;
const principal = (id: string) => ({ kind: 'user' as const, userId: id, authSessionHash: hashSessionToken(token(id)) });
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
class Socket {
  readyState = 1; bufferedAmount = 0; messages: any[] = []; closes: unknown[] = []; fail = false;
  send(data: string, callback: (error?: Error) => void) {
    if (this.fail) { callback(new Error('private socket detail')); return; }
    this.messages.push(JSON.parse(data)); callback();
  }
  close(code: number, reason: string) { this.closes.push({ code, reason }); this.readyState = 3; }
}
async function prepared(loadAvailability?:ConstructorParameters<typeof StoredFrontendHub>[1]) {
  const f = fixture();
  f.mutate(`INSERT INTO users(id,role,username) VALUES('${member}','member','shared-user');
    INSERT INTO projects(id,owner_user_id,path) VALUES('${project}','owner','D:/ws-synthetic');
    INSERT INTO sessions(id,owner_user_id,project_id,deleted_at) VALUES('${session}','owner','${project}',NULL);
    INSERT INTO project_members VALUES('${project}','${member}','viewer',1,1,1);`);
  for (const id of ['owner', 'other', 'admin', member]) f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at)
    VALUES('${hashSessionToken(token(id))}','${id}',${Date.now()+600_000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const hub = new StoredFrontendHub(port,loadAvailability);
  async function client(id: string) {
    const auth = (await port.authenticateSession({ tokenHash: hashSessionToken(token(id)) }))!;
    const socket = new Socket();
    const c: FrontendClient = { ws: socket as any, actor: { userId: id, role: auth.user.role }, userId: id, user: auth.user,
      ip: '127.0.0.1', authTokenHash: hashSessionToken(token(id)), authExpiresAt: auth.expiresAt, authExpiryTimer: null,
      activeSubscriptionSessionId: null, subscribedSessionIds: new Set() };
    return { c, socket };
  }
  const delta = (content = 'synthetic') => hub.broadcastSession({ type: 'delta', sessionId: session, itemId: 'item', content });
  return { f, port, hub, client, delta, cleanup: async () => { hub.dispose(); await port.close(); f.cleanup(); } };
}

test('async live attachment probes preserve per-client message order and share one observation per publication',async()=>{
  const entered=deferred(),release=deferred();let calls=0;
  const p=await prepared(async paths=>{assert.deepEqual(paths,['D:/synthetic/present.txt']);if(++calls===1){entered.resolve();await release.promise;}return()=>true;});
  try{
    const clients=await Promise.all([p.client('owner'),p.client(member)]);for(const client of clients){await p.hub.add(client.c);await p.hub.subscribe(client.c,session);}
    const send=(revision:number)=>p.hub.broadcastMessage({revision,savedMessage:{id:randomUUID(),sessionId:session,turnId:'synthetic-turn',role:'user',content:'file '+revision,phase:null,items:null,
      metadata:JSON.stringify({attachments:[{kind:'uploaded_file',id:randomUUID(),path:'D:/synthetic/present.txt',name:'present.txt',mimeType:'text/plain',size:1,available:true}]}),createdAt:revision,durationMs:null,stopped:false}},
      {readSession:p.port.readSession.bind(p.port),attachmentAvailability:()=>{throw Error('sync filesystem callback must not run');},isCurrent:()=>true});
    const first=send(1),second=send(2);await entered.promise;assert.equal(clients[0].socket.messages.length,0);release.resolve();
    await Promise.all([first,second]);assert.equal(calls,2);
    for(const client of clients){const saved=client.socket.messages.filter(message=>message.type==='message_saved');assert.deepEqual(saved.map(message=>message.messageRevision),[1,2]);assert.equal(saved[0].message.attachments[0].available,true);}
  }finally{release.resolve();await p.cleanup();}
});

test('live attachment observation rechecks permissions after asynchronous filesystem work',async()=>{
  const entered=deferred(),release=deferred();const p=await prepared(async()=>{entered.resolve();await release.promise;return()=>true;});
  try{
    const client=await p.client(member);await p.hub.add(client.c);await p.hub.subscribe(client.c,session);
    const send=p.hub.broadcastMessage({revision:1,savedMessage:{id:randomUUID(),sessionId:session,turnId:'synthetic-turn',role:'user',content:'private file',phase:null,items:null,
      metadata:JSON.stringify({attachments:[{kind:'uploaded_file',id:randomUUID(),path:'D:/synthetic/file',name:'file',mimeType:'text/plain',size:1,available:true}]}),createdAt:1,durationMs:null,stopped:false}},
      {readSession:p.port.readSession.bind(p.port),attachmentAvailability:()=>false,isCurrent:()=>true});
    await entered.promise;p.f.mutate(`UPDATE project_members SET can_view_sessions=0 WHERE user_id='${member}'`);release.resolve();await send;
    assert.equal(client.socket.messages.some(message=>message.type==='message_saved'),false);
  }finally{release.resolve();await p.cleanup();}
});
test('resource publication sends current project/session changes only to their viewers and invalidates tombstones',async()=>{
  const p=await prepared();
  try{
    const owner=await p.client('owner'),viewer=await p.client(member),other=await p.client('other'),admin=await p.client('admin');
    for(const client of [owner,viewer,other,admin])await p.hub.add(client.c);
    await p.hub.subscribe(owner.c,session);await p.hub.subscribe(viewer.c,session);
    await p.hub.broadcastResource({kind:'project',id:project},p.port.readResourceEvent.bind(p.port));
    assert.equal(owner.socket.messages.at(-1).type,'project_updated');assert.equal(viewer.socket.messages.at(-1).type,'project_updated');
    assert.equal(other.socket.messages.length,0);assert.equal(admin.socket.messages.length,0);
    p.f.mutate(`UPDATE sessions SET deleted_at=1 WHERE id='${session}';UPDATE projects SET deleted_at=1 WHERE id='${project}'`);
    await p.hub.broadcastResource({kind:'session',id:session},p.port.readResourceEvent.bind(p.port));
    await p.hub.broadcastResource({kind:'project',id:project},p.port.readResourceEvent.bind(p.port));
    assert.equal(owner.socket.messages.at(-1).type,'project_deleted');assert.equal(viewer.socket.messages.at(-1).type,'project_deleted');
    assert.equal(owner.c.subscribedSessionIds.has(session),false);assert.equal(viewer.c.subscribedSessionIds.has(session),false);
    assert.equal(other.socket.messages.length,0);assert.equal(admin.socket.messages.length,0);
    p.f.mutate(`DELETE FROM project_members WHERE project_id='${project}' AND user_id='${member}'`);
    const before=viewer.socket.messages.length;await p.hub.broadcastResource({kind:'project',id:project},p.port.readResourceEvent.bind(p.port));assert.equal(viewer.socket.messages.length,before);
  }finally{await p.cleanup();}
});

test('a retired runtime publication is discarded after asynchronous access verification',async()=>{
  const p=await prepared();const entered=deferred(),release=deferred();let current=true;
  try{
    const viewer=await p.client('owner');await p.hub.add(viewer.c);await p.hub.subscribe(viewer.c,session);
    const read=p.port.readFrontendAccess.bind(p.port);
    p.port.readFrontendAccess=async request=>{entered.resolve();await release.promise;return read(request);};
    const pending=p.hub.broadcastSession({type:'delta',sessionId:session,itemId:'text',content:'old'},{isCurrent:()=>current});
    await entered.promise;current=false;release.resolve();
    assert.deepEqual(await pending,{sent:0,failed:0});assert.deepEqual(viewer.socket.messages,[]);
  }finally{release.resolve();await p.cleanup();}
});
test('a committed Native terminal publishes its result then freshly loads current session state per recipient',async()=>{
  const p=await prepared();let storage:RuntimeStorage|undefined;
  try{
    p.f.mutate(`UPDATE sessions SET active_attempt_id='attempt',engine='codex',engine_session_id='thread',status='processing',message_revision=2 WHERE id='${session}';
      UPDATE engine_resource_leases SET session_id='${session}' WHERE attempt_id='attempt'`);
    const owner=await p.client('owner'),shared=await p.client(member);for(const c of [owner,shared]){await p.hub.add(c.c);await p.hub.subscribe(c.c,session);}
    let summary:unknown;
    storage=new RuntimeStorage(p.port,{storeId:'store',generation:1,leaseToken:'lease',engineId:'codex',runtime:{},
      principal:{kind:'runtime',sessionId:session,attemptId:'attempt',connectionId:'connection',runtimeVersion:1},isCurrent:()=>true,onFailure:()=>assert.fail('unexpected terminal storage failure'),
      onTerminalCommitted:async(effect,guard)=>{
        assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
        // A new turn may already have arrived; the terminal receipt must not broadcast completed again.
        p.f.mutate(`UPDATE sessions SET status='pending' WHERE id='${session}'`);
        summary=await p.hub.broadcastTerminal(effect.projection,{readSession:p.port.readSession.bind(p.port),attachmentAvailability:()=>false,isCurrent:guard.isCurrent});
      }});
    await storage.process({engineId:'codex',payload:{type:'message_complete',turnId:'ws-final',content:'Native result'},
      meta:{source:'realtime',sequence:1,observedAt:100,eventId:'ws-final',externalSessionId:'thread',externalTurnId:'ws-final'}},async(_,context)=>{
      await context.finishTerminal({id:randomUUID(),turnId:'ws-final',content:'Native result',items:null,metadata:null,durationMs:null});
    });
    assert.deepEqual(summary,{sent:2,failed:0});
    for(const c of [owner,shared]){assert.deepEqual(c.socket.messages.map(message=>message.type),['message_saved','session_updated']);
      assert.equal(c.socket.messages[0].message.content,'Native result');assert.equal(c.socket.messages[0].message.requestTurnId,'attempt');assert.equal(c.socket.messages[0].messageRevision,3);assert.equal(c.socket.messages[1].session.status,'pending');}
  }finally{await storage?.close().catch(()=>{});await p.cleanup();}
});

test('terminal request association is published only for the matching session and turn',async()=>{
  const savedMessage={role:'assistant',sessionId:'s',turnId:'engine-turn'};
  for(const [decision,expected] of [
    [{sessionId:'s',externalTurnId:'engine-turn',attemptId:'request'},'request'],
    [{sessionId:'other',externalTurnId:'engine-turn',attemptId:'request'},undefined],
    [{sessionId:'s',externalTurnId:'other-turn',attemptId:'request'},undefined],
    [undefined,undefined],
  ] as const){
    let actual:unknown;
    await StoredFrontendHub.prototype.broadcastTerminal.call({broadcastMessage:async(_result:unknown,options:any)=>{actual=options.requestTurnId;return{sent:0,failed:0};}} as any,
      {savedMessage,revision:1,decision} as any,{readSession:async()=>null,attachmentAvailability:()=>false,isCurrent:()=>true});
    assert.equal(actual,expected);
  }
});

test('terminal session reload rechecks revocation and isolates a failed socket from other recipients',async()=>{
  const p=await prepared();try{
    const owner=await p.client('owner'),shared=await p.client(member),admin=await p.client('admin');
    for(const c of [owner,shared,admin]){await p.hub.add(c.c);await p.hub.subscribe(c.c,session);}admin.socket.fail=true;
    const result={revision:3,savedMessage:{id:randomUUID(),sessionId:session,turnId:'ws-final',role:'assistant' as const,content:'Native result',phase:'final_answer',items:null,
      metadata:'{"outcome":"completed"}',createdAt:100,durationMs:null,stopped:false}};
    const summary=await p.hub.broadcastTerminal(result,{attachmentAvailability:()=>false,isCurrent:()=>true,readSession:async request=>{
      const current=await p.port.readSession(request);if(request.principal.userId===member)p.f.mutate(`UPDATE project_members SET can_view_sessions=0 WHERE user_id='${member}'`);return current;
    }});
    assert.deepEqual(summary,{sent:1,failed:1});assert.equal(owner.socket.messages.at(-1).type,'session_updated');
    assert.equal(shared.socket.messages.some(message=>message.type==='session_updated'),false);assert.equal(shared.socket.messages.at(-1).code,'SESSION_NOT_FOUND');
    assert.equal(shared.c.subscribedSessionIds.has(session),false);
  }finally{await p.cleanup();}
});

test('terminal publication discards a retired runtime after an awaited session reload',async()=>{
  const p=await prepared();try{const owner=await p.client('owner');await p.hub.add(owner.c);await p.hub.subscribe(owner.c,session);let owned=true;
    const result={revision:3,savedMessage:{id:randomUUID(),sessionId:session,turnId:'ws-final',role:'assistant' as const,content:'Native result',phase:'final_answer',items:null,
      metadata:'{"outcome":"completed"}',createdAt:100,durationMs:null,stopped:false}};
    assert.deepEqual(await p.hub.broadcastTerminal(result,{attachmentAvailability:()=>false,isCurrent:()=>owned,readSession:async request=>{
      const current=await p.port.readSession(request);owned=false;return current;
    }}),{sent:0,failed:0});assert.deepEqual(owner.socket.messages.map(message=>message.type),['message_saved']);
  }finally{await p.cleanup();}
});

test('Worker visibility is current and distinct from authentication, ownership, membership and admin authority', async () => {
  const p = await prepared();
  try {
    for (const id of ['owner', 'admin', member]) assert.equal((await p.port.readFrontendAccess({ principal: principal(id), resource: { kind: 'session', id: session } }))?.allowed, true);
    assert.equal((await p.port.readFrontendAccess({ principal: principal('other'), resource: { kind: 'session', id: session } }))?.allowed, false);
    p.f.mutate(`UPDATE project_members SET can_view_sessions=0 WHERE user_id='${member}'`);
    assert.equal((await p.port.readFrontendAccess({ principal: principal(member), resource: { kind: 'project', id: project } }))?.allowed, true);
    assert.equal((await p.port.readFrontendAccess({ principal: principal(member), resource: { kind: 'session', id: session } }))?.allowed, false);
    p.f.mutate(`UPDATE sessions SET owner_user_id='${member}' WHERE id='${session}'`);
    assert.equal((await p.port.readFrontendAccess({ principal: principal(member), resource: { kind: 'session', id: session } }))?.allowed, true);
    assert.equal((await p.port.readFrontendAccess({ principal: principal('owner'), resource: { kind: 'session', id: session } }))?.allowed, true);
    p.f.mutate(`UPDATE projects SET owner_user_id=NULL WHERE id='${project}'`);
    assert.equal((await p.port.readFrontendAccess({ principal: principal('admin'), resource: { kind: 'session', id: session } }))?.allowed, false);
    p.f.mutate(`UPDATE projects SET owner_user_id='owner' WHERE id='${project}'`);
    p.f.mutate(`UPDATE projects SET deleted_at=1 WHERE id='${project}'`);
    for (const id of [member, 'owner', 'admin']) assert.equal((await p.port.readFrontendAccess({ principal: principal(id), resource: { kind: 'session', id: session } }))?.allowed, false);
    assert.equal(await p.port.readFrontendAccess({ principal: { ...principal('owner'), userId: 'other' }, resource: null }), null);
    await assert.rejects(p.port.readFrontendAccess({ principal: principal('owner'), resource: { kind: 'session', id: session, extra: 1 } } as any), { code: 'INVALID_ARGUMENT' });
  } finally { await p.cleanup(); }
});

test('native candidate subscribes only after authorization and rechecks every ordered session broadcast', async () => {
  const p = await prepared();
  try {
    const a = await p.client('owner'), b = await p.client(member), denied = await p.client('other');
    for (const c of [a, b, denied]) assert.equal(await p.hub.add(c.c), true);
    assert.equal(await p.hub.subscribe(a.c, session), true); assert.equal(await p.hub.subscribe(b.c, session, false), true);
    assert.equal(await p.hub.subscribe(denied.c, session), false);
    assert.deepEqual(await p.delta('first'), { sent: 2, failed: 0 });
    assert.deepEqual(await p.delta('second'), { sent: 2, failed: 0 });
    assert.deepEqual(a.socket.messages.map((m) => m.content), ['first', 'second']);
    p.f.mutate(`UPDATE project_members SET can_view_sessions=0 WHERE user_id='${member}'`);
    assert.deepEqual(await p.delta('private-after-revoke'), { sent: 1, failed: 0 });
    assert.equal(b.c.subscribedSessionIds.has(session), false);
    assert.equal(b.socket.messages.at(-1).code, 'SESSION_NOT_FOUND');
    assert.equal(b.socket.messages.some((m) => m.content === 'private-after-revoke'), false);
    assert.equal(b.socket.closes.length, 0); // Losing one project does not log out the account.
  } finally { await p.cleanup(); }
});

test('unsubscribe/re-subscribe while Worker is awaiting fences old payloads and old subscription intents', async () => {
  const p = await prepared();
  try {
    const a = await p.client('owner'); await p.hub.add(a.c); await p.hub.subscribe(a.c, session);
    const original = p.port.readFrontendAccess.bind(p.port); const entered = deferred(), release = deferred(); let pause = true;
    p.port.readFrontendAccess = async (request) => {
      const result = await original(request);
      if (pause) { pause = false; entered.resolve(); await release.promise; } return result;
    };
    const old = p.delta('must-not-arrive'); await entered.promise;
    p.hub.unsubscribe(a.c, session); const next = p.hub.subscribe(a.c, session, false);
    release.resolve(); assert.deepEqual(await old, { sent: 0, failed: 0 }); assert.equal(await next, true);
    assert.equal(a.socket.messages.length, 0); assert.equal(a.c.activeSubscriptionSessionId, null);
    assert.deepEqual(await p.delta('new'), { sent: 1, failed: 0 });
    // A pending subscribe cancelled by unsubscribe must not resurrect itself after its query finishes.
    const entered2 = deferred(), release2 = deferred(); pause = true;
    p.port.readFrontendAccess = async (request) => { const result = await original(request); entered2.resolve(); await release2.promise; return result; };
    const pending = p.hub.subscribe(a.c, session); await entered2.promise; p.hub.unsubscribe(a.c, session); release2.resolve();
    assert.equal(await pending, false); assert.equal(a.c.subscribedSessionIds.size, 0);
  } finally { await p.cleanup(); }
});

test('account/connection identity changes after await cannot receive old payloads, refresh or revocation', async () => {
  const p = await prepared();
  try {
    const a = await p.client('owner'); await p.hub.add(a.c); await p.hub.subscribe(a.c, session);
    const original = p.port.readFrontendAccess.bind(p.port), entered = deferred(), release = deferred();
    p.port.readFrontendAccess = async (request) => { const value = await original(request); entered.resolve(); await release.promise; return value; };
    const old = p.delta('old-account'); await entered.promise;
    a.c.authTokenHash = hashSessionToken('synthetic-replacement-token'); a.c.userId = 'other';
    release.resolve(); assert.deepEqual(await old, { sent: 0, failed: 0 });
    assert.equal(a.socket.messages.length, 0); assert.equal(a.socket.closes.length, 0); assert.equal(a.c.userId, 'other');
    p.hub.remove(a.c);
    p.port.readFrontendAccess = original;
    const b = await p.client('owner'); await p.hub.add(b.c); await p.hub.subscribe(b.c, session);
    const entered2 = deferred(), release2 = deferred();
    p.port.readFrontendAccess = async (request) => { const value = await original(request); entered2.resolve(); await release2.promise; return value; };
    const detached = p.delta('detached'); await entered2.promise; p.hub.remove(b.c); release2.resolve();
    assert.deepEqual(await detached, { sent: 0, failed: 0 }); assert.equal(b.c.authExpiryTimer, null); assert.equal(b.c.subscribedSessionIds.size, 0);
  } finally { await p.cleanup(); }
});

test('database failures preserve login and subscription, while actual revoked/initial-password/expired accounts close', async () => {
  const p = await prepared();
  try {
    const a = await p.client(member); await p.hub.add(a.c); await p.hub.subscribe(a.c, session);
    const original = p.port.readFrontendAccess.bind(p.port);
    p.port.readFrontendAccess = async () => { throw new Error('private database path'); };
    assert.deepEqual(await p.delta(), { sent: 0, failed: 1 });
    await assert.rejects(p.hub.recheckUserAccess(member), /FRONTEND_ACCESS_RECHECK_UNAVAILABLE/);
    assert.equal(a.socket.closes.length, 0); assert.equal(a.c.subscribedSessionIds.size, 1);
    p.port.readFrontendAccess = original; assert.deepEqual(await p.delta(), { sent: 1, failed: 0 });
    p.f.mutate(`UPDATE users SET must_change_password=1 WHERE id='${member}'`);
    await p.hub.recheckUserAccess(member); assert.equal(a.socket.closes.length, 1); assert.equal(a.c.subscribedSessionIds.size, 0);
    const b = await p.client('other'); await p.hub.add(b.c);
    p.f.mutate(`DELETE FROM auth_sessions WHERE token_hash='${hashSessionToken(token('other'))}'`);
    await p.hub.recheckUserAccess('other'); assert.equal(b.socket.closes.length, 1);
    const c = await p.client('owner'); await p.hub.add(c.c); c.c.authExpiresAt = Date.now()-1;
    await p.hub.recheckUserAccess('owner'); assert.equal(c.socket.closes.length, 1);
  } finally { await p.cleanup(); }
});

test('per-connection ordering survives blocked storage, failure, and bounded queue pressure', async () => {
  const p = await prepared();
  try {
    let a = await p.client('owner'), b = await p.client('admin');
    const reconnect=async(id:string)=>{const client=await p.client(id);await p.hub.add(client.c);await p.hub.subscribe(client.c,session);return client;};
    await p.hub.add(a.c); await p.hub.add(b.c); await p.hub.subscribe(a.c, session); await p.hub.subscribe(b.c, session);
    const original = p.port.readFrontendAccess.bind(p.port), entered = deferred(), release = deferred(); let pause = true;
    p.port.readFrontendAccess = async (request) => {
      if (pause && request.principal.userId === 'owner') { pause = false; entered.resolve(); await release.promise; }
      return original(request);
    };
    const one = p.delta('one'); await entered.promise; const two = p.delta('two');
    // Admin's independent queue still advances while owner's storage continuation is paused.
    await p.hub.recheckUserAccess('admin'); assert.deepEqual(b.socket.messages.map((m) => m.content), ['one', 'two']);
    release.resolve(); await one; await two; assert.deepEqual(a.socket.messages.map((m) => m.content), ['one', 'two']);
    a.socket.fail = true; assert.deepEqual(await p.delta('fail'), { sent: 1, failed: 1 });
    assert.deepEqual(a.socket.closes,[{code:1013,reason:'Synchronization required'}]);a=await reconnect('owner');
    a.socket.bufferedAmount = 8*1024*1024;
    assert.deepEqual(await p.delta('buffered'), { sent: 1, failed: 1 });
    assert.equal(a.socket.closes.length,1);a=await reconnect('owner');
    assert.deepEqual(await p.delta('next'), { sent: 2, failed: 0 });
    const entered2 = deferred(), release2 = deferred(); pause = true;
    p.port.readFrontendAccess = async (request) => {
      if (pause && request.principal.userId === 'owner') { pause = false; entered2.resolve(); await release2.promise; } return original(request);
    };
    const hold = p.hub.recheckUserAccess('owner'); await entered2.promise;
    const jobs = Array.from({ length: 130 }, () => p.delta('bounded'));
    release2.resolve(); await hold;
    const results = await Promise.all(jobs); assert.ok(results.some(r=>r.failed>0),'queue pressure must be reported before the connection is detached');
    assert.equal(a.socket.closes.length,1);assert.equal(b.socket.closes.length,1);
    a=await reconnect('owner');b=await reconnect('admin');
    assert.deepEqual(await p.delta('recovered'), { sent: 2, failed: 0 });
  } finally { await p.cleanup(); }
});

test('a send timeout detaches only the slow socket and a reconnected client receives subsequent events',async()=>{
  const p=await prepared();
  try{
    const slow=await p.client('owner'),fast=await p.client('admin');
    for(const client of [slow,fast]){await p.hub.add(client.c);await p.hub.subscribe(client.c,session);}
    slow.socket.send=()=>{};
    assert.deepEqual(await p.delta('timeout'),{sent:1,failed:1});
    assert.deepEqual(slow.socket.closes,[{code:1013,reason:'Synchronization required'}]);assert.deepEqual(fast.socket.closes,[]);
    const reconnected=await p.client('owner');await p.hub.add(reconnected.c);await p.hub.subscribe(reconnected.c,session);
    assert.deepEqual(await p.delta('after reconnect'),{sent:2,failed:0});
    assert.equal(reconnected.socket.messages.at(-1)?.content,'after reconnect');
  }finally{await p.cleanup();}
});

test('subscription capacity includes pending reservations and cleanup never controls an engine', async () => {
  const p = await prepared();
  try {
    const a = await p.client('owner'); await p.hub.add(a.c);
    await assert.rejects(p.hub.subscribe(a.c, 'invalid'), /FRONTEND_SESSION_ID_INVALID/);
    await assert.rejects(p.hub.recheckProjectAccess('invalid', 'owner'), /FRONTEND_PROJECT_ID_INVALID/);
    const original = p.port.readFrontendAccess.bind(p.port), entered = deferred(), release = deferred(); let pause = true;
    p.port.readFrontendAccess = async (request) => {
      if (pause) { pause = false; entered.resolve(); await release.promise; }
      return original(request);
    };
    const ids = Array.from({ length: 17 }, () => randomUUID());
    p.f.mutate(ids.map((id) => `INSERT INTO sessions(id,owner_user_id,project_id) VALUES('${id}','owner','${project}')`).join(';'));
    const subscriptions = ids.slice(0,16).map((id) => p.hub.subscribe(a.c, id, false)); await entered.promise;
    await assert.rejects(p.hub.subscribe(a.c, ids[16]), /FRONTEND_SUBSCRIPTION_LIMIT/);
    p.hub.unsubscribe(a.c, ids[0]); const replacement = p.hub.subscribe(a.c, ids[16]); release.resolve();
    assert.equal((await Promise.all(subscriptions)).filter(Boolean).length, 15); assert.equal(await replacement, true);
    assert.equal(a.c.subscribedSessionIds.size, 16);
    p.hub.dispose(); assert.equal(a.c.authExpiryTimer, null); assert.equal(a.c.subscribedSessionIds.size, 0);
    assert.equal(p.f.scalar("SELECT count(*) FROM engine_resource_leases WHERE state='running'"), 1);
  } finally { await p.cleanup(); }
});

test('project member HTTP changes drive current native hub permissions, not stale grant receipts', async () => {
  const p = await prepared();
  try {
    const a = await p.client(member); await p.hub.add(a.c); await p.hub.subscribe(a.c, session);
    const app = new Hono().route('/api', createStoredProjectMembersRouter({ port: p.port, storeId: 'store', generation: 1,
      recheckProjectAccess: (projectId, userId) => p.hub.recheckProjectAccess(projectId, userId) }));
    const mutate = (method: string, key: string) => app.request(`/api/projects/${project}/members/${member}`, { method,
      headers: { cookie: serializeSessionCookie(token('admin'), Date.now()+600_000, false), 'content-type': 'application/json', 'x-relay-operation-id': key },
      ...(method === 'PUT' ? { body: JSON.stringify({ role: 'collaborator', can_view_sessions: 1 }) } : {}) });
    assert.equal((await mutate('PUT', operation)).status, 200);
    assert.equal(a.socket.messages.at(-1).type, 'project_updated');
    assert.equal(a.socket.messages.at(-1).project.access_role, 'collaborator');
    assert.equal((await mutate('DELETE', randomUUID())).status, 200);
    assert.equal(a.c.subscribedSessionIds.size, 0); assert.equal(a.socket.messages.at(-1).type, 'project_deleted');
    assert.equal((await mutate('PUT', operation)).status, 200);
    assert.equal(a.socket.messages.at(-1).type, 'project_deleted');
    assert.equal(p.f.scalar(`SELECT count(*) FROM project_members WHERE user_id='${member}'`), 0);
    assert.equal(a.socket.closes.length, 0);
    assert.equal((await p.delta('secret-after-replay')).sent, 0);
  } finally { await p.cleanup(); }
});

test('auth HTTP disable revokes current socket, old disable replay preserves a newly authenticated socket', async () => {
  const p = await prepared();
  const module = createStoredAuthModule({ port: p.port, storeId: 'store', generation: 1, workspacePath: 'D:/synthetic',
    recheckUserAccess: (id) => p.hub.recheckUserAccess(id) });
  try {
    const a = await p.client(member); await p.hub.add(a.c); await p.hub.subscribe(a.c, session);
    const app = new Hono().route('/api/auth', module.router);
    const disable = (disabled: boolean, key: string) => app.request(`/api/auth/users/${member}/disabled`, { method: 'PATCH',
      headers: { cookie: serializeSessionCookie(token('admin'), Date.now()+600_000, false), 'content-type': 'application/json', 'x-relay-operation-id': key },
      body: JSON.stringify({ disabled }) });
    assert.equal((await disable(true, operation)).status, 200); assert.equal(a.socket.closes.length, 1);
    assert.equal((await disable(false, randomUUID())).status, 200);
    p.f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hashSessionToken(token(member))}','${member}',${Date.now()+600_000})`);
    const b = await p.client(member); await p.hub.add(b.c); await p.hub.subscribe(b.c, session);
    assert.equal((await disable(true, operation)).status, 200); assert.equal(b.socket.closes.length, 0);
    assert.equal((await p.delta('new-login')).sent, 1);
  } finally { module.dispose(); await p.cleanup(); }
});

test('trust invalidations remain account-private and use current scope access before delivery', async () => {
  const p = await prepared();
  try {
    const a = await p.client('owner'), b = await p.client(member); await p.hub.add(a.c); await p.hub.add(b.c);
    const event = { type: 'approval_trust_updated' as const, scope: 'project' as const, scopeId: project };
    await p.hub.broadcastTrust(event, 'owner'); assert.equal(a.socket.messages.length, 1); assert.equal(b.socket.messages.length, 0);
    await assert.rejects(p.hub.broadcastSession({ type: 'interaction_response_result', operationId: randomUUID(), sessionId: session,
      interactionId: 'synthetic', outcome: 'accepted' } as any), /FRONTEND_SESSION_EVENT_INVALID/);
    await assert.rejects(p.hub.broadcastTrust({ type: 'protocol_info', protocolVersion: RELAY_PROTOCOL_VERSION } as any, 'owner'), /FRONTEND_TRUST_EVENT_INVALID/);
    p.f.mutate(`DELETE FROM project_members WHERE user_id='${member}'`);
    await p.hub.broadcastTrust(event, member); assert.equal(b.socket.messages.length, 0);
    await p.port.close(); await assert.rejects(p.hub.broadcastTrust(event, 'owner'), /FRONTEND_NOTIFICATION_UNAVAILABLE/);
    assert.equal(a.socket.closes.length, 0);
  } finally { await p.cleanup(); }
});
