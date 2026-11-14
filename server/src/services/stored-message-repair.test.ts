import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { StoredMessageRepair } from './stored-message-repair.js';
import { createStoredMessageRepairRouter } from '../routes/stored-message-repair.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { nativeQueries } from '../storage/native-queries.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { NativeStore } from '../storage/native-store.js';
import { appendEngineTurnFactInDatabase, insertEngineTerminalDecisionInDatabase } from '../db/engine-turn-facts.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import type { RepairCandidate, RepairEntry, StorageCommandEnvelope } from '../storage/contracts.js';
import { RepairSourceReader } from '../storage/repair-source-reader.js';
const session = '11111111-1111-4111-8111-111111111111', thread = '22222222-2222-4222-8222-222222222222';
const body = 'restored synthetic reply';
const principal = (id = 'admin') => ({ kind: 'user' as const, userId: id, authSessionHash: hashSessionToken(`synthetic-repair-${id}`) });
async function prepared() {
  const f = fixture();
  f.mutate(`UPDATE sessions SET status='completed',active_attempt_id=NULL; DELETE FROM engine_resource_leases;
    INSERT INTO projects(id,owner_user_id,path) VALUES('repair-project','admin','D:/repair-synthetic');
    INSERT INTO sessions(id,owner_user_id,project_id,title,engine,engine_bound,engine_session_id,status,message_revision,created_at,updated_at)
      VALUES('${session}','admin','repair-project','Repair','codex',1,'${thread}','completed',1,1,200);
    INSERT INTO messages(id,session_id,turn_id,role,content,phase,metadata,created_at,stopped)
      VALUES('empty-card','${session}','repair-turn','assistant','','final_answer','{"outcome":"completed"}',50,0)`);
  for (const id of ['admin','owner']) f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600_000})`);
  const db = new DatabaseSync(f.filename), bridge = nativeQueries(db);
  appendEngineTurnFactInDatabase(bridge, { id: 'repair-fact', sessionId: session, attemptId: 'repair-attempt', engineId: 'codex', connectionId: 'repair-connection',
    externalTurnId: 'repair-turn', factType: 'final_answer_completed', source: 'realtime', sequence: 1, idempotencyKey: 'repair-fact', observedAt: 100,
    payload: { hasContent: true, contentLength: body.length, contentDigest: createHash('sha256').update(body).digest('hex') } });
  insertEngineTerminalDecisionInDatabase(bridge, { id: 'repair-decision', sessionId: session, attemptId: 'repair-attempt', engineId: 'codex', externalTurnId: 'repair-turn',
    outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', factId: 'repair-fact', decidedAt: 100, projectedAt: 100 }); db.close();
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const state = { busy: false, now: Date.now(), published: [] as string[] };
  const hooks = { load: async (candidates: readonly RepairCandidate[]): Promise<RepairEntry[]> => candidates.map((candidate) => ({ candidate,
    snapshot: { messageId: 'restored-message', content: body, items: null, durationMs: null, metadata: { executionStage: 'responding' } } })) };
  const createService = () => new StoredMessageRepair({ port, storeId: 'store', generation: 1, maintenanceBusy: () => state.busy, now: () => state.now,
    loadSnapshots: (...args) => hooks.load(...args), changed: async (id) => { state.published.push(id); } });
  const service = createService();
  const app = new Hono().route('/api/system', createStoredMessageRepairRouter({ port, service }));
  const request = (action: string, value: unknown, user = 'admin', origin = 'http://127.0.0.1:9081') => app.request('/api/system/message-repair/'+action,
    { method: 'POST', headers: { cookie: serializeSessionCookie(`synthetic-repair-${user}`,Date.now()+600_000,false), origin, 'content-type':'application/json' }, body: JSON.stringify(value) });
  const backups = () => fs.existsSync(path.join(f.directory,'repair-backups')) ? fs.readdirSync(path.join(f.directory,'repair-backups')) : [];
  return { f,port,state,hooks,service,createService,app,request,backups,cleanup: async () => { await port.close(); f.cleanup(); } };
}
test('repair preview is read-only and private; Worker backup, repair, revision and receipt commit safely', async () => {
  const p = await prepared();
  try {
    const plan = await p.service.preview(principal()); assert.equal(plan.turnCount,1); assert.equal(JSON.stringify(plan).includes(body),false); assert.deepEqual(p.backups(),[]);
    assert.equal((await p.service.apply(principal(),plan.planId!)).state,'committed');
    assert.equal(p.f.scalar(`SELECT content FROM messages WHERE session_id='${session}' AND content<>''`),body);
    assert.equal(p.f.scalar(`SELECT updated_at FROM sessions WHERE id='${session}'`),200);
    assert.equal(p.f.scalar(`SELECT message_revision FROM sessions WHERE id='${session}'`),2);
    assert.deepEqual(p.state.published,[session]); assert.equal(p.backups().length,1);
    const backup = new DatabaseSync(path.join(p.f.directory,'repair-backups',p.backups()[0]),{readOnly:true});
    try { assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check,'ok'); assert.equal(backup.prepare(`SELECT count(*) AS n FROM messages WHERE session_id='${session}' AND content<>''`).get()?.n,0); }
    finally { backup.close(); }
    assert.deepEqual(await p.createService().apply(principal(),plan.planId!),{state:'committed',restoredCount:1}); assert.equal(p.backups().length,1);
  } finally { await p.cleanup(); }
});
test('repair retry creates a fresh verified backup after an interruption and never trusts a damaged older backup', async () => {
  const p=await prepared();await p.port.close();
  const store=new NativeStore(p.f.filename,'store',2);
  try{
    const candidates=store.readRepairCandidates({principal:principal(),cursor:null}).candidates;
    const entries=await p.hooks.load(candidates),backupId=randomUUID();
    const request={protocolVersion:1,storeId:'store',workerGeneration:2,requestId:'repair-backup-review',operationId:'repair-backup-review',principal:principal(),
      command:{name:'repair.apply',input:{backupId,entries}}};
    const execute=store.execute.bind(store);store.execute=()=>{throw new Error('synthetic interruption after backup');};
    await assert.rejects(store.executeWithMaintenance(request),/synthetic interruption/);store.execute=execute;
    assert.equal(p.backups().length,1);
    const damaged=path.join(p.f.directory,'repair-backups',p.backups()[0]!);fs.writeFileSync(damaged,'damaged');
    assert.equal((await store.executeWithMaintenance(request)).state,'committed');
    assert.equal(p.backups().length,2);assert.equal(fs.readFileSync(damaged,'utf8'),'damaged');
    const current=String(p.f.scalar(`SELECT filename FROM _relay_repair_backups WHERE id='${backupId}'`));assert.notEqual(current,damaged);
    const checked=new DatabaseSync(current,{readOnly:true});try{assert.equal(checked.prepare('PRAGMA quick_check').get()?.quick_check,'ok');}finally{checked.close();}
  }finally{store.close();await p.cleanup();}
});

test('receipt failure rolls back messages and revision, retains the verified backup, and allows exact-intent recovery', async () => {
  const p = await prepared();
  try {
    const plan = await p.service.preview(principal());
    p.f.mutate("CREATE TRIGGER fail_repair_receipt BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='repair.apply' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.deepEqual(await p.service.apply(principal(),plan.planId!),{state:'unknown'});
    assert.equal(p.f.scalar(`SELECT message_revision FROM sessions WHERE id='${session}'`),1); assert.equal(p.backups().length,1);
    assert.equal(p.f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND content<>''`),0);
    p.f.mutate('DROP TRIGGER fail_repair_receipt');
    const execute = p.port.execute.bind(p.port);
    p.port.execute = (async (request: StorageCommandEnvelope) => { const result = await execute(request);
      return result.state === 'committed' ? {state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'} : result;
    }) as typeof p.port.execute;
    assert.deepEqual(await p.service.apply(principal(),plan.planId!),{state:'committed',restoredCount:1}); assert.equal(p.backups().length,2);
    assert.equal(p.f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND content<>''`),1);
  } finally { await p.cleanup(); }
});
test('active tasks, source changes, maintenance and expired plans reject before changing data', async () => {
  const p = await prepared();
  try {
    const plan = await p.service.preview(principal()); p.state.busy=true;
    await assert.rejects(p.service.apply(principal(),plan.planId!),{code:'CONFLICT'}); assert.equal(p.backups().length,0); p.state.busy=false;
    p.f.mutate(`UPDATE sessions SET status='processing',active_attempt_id='new-attempt' WHERE id='${session}'`);
    await assert.rejects(p.service.apply(principal(),plan.planId!),{code:'CONFLICT'}); assert.equal(p.backups().length,0);
    p.f.mutate(`UPDATE sessions SET status='completed',active_attempt_id=NULL,message_revision=2 WHERE id='${session}'`);
    await assert.rejects(p.service.apply(principal(),plan.planId!),{code:'CONFLICT'});
    assert.equal(p.f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND content<>''`),0);
    const next = await p.service.preview(principal()); p.state.now+=600001;
    await assert.rejects(p.service.apply(principal(),next.planId!),{code:'OPERATION_EXPIRED'});
  } finally { await p.cleanup(); }
});
test('unverifiable content and access revoked during source reads cannot produce a repair plan', async () => {
  const p = await prepared();
  try {
    p.hooks.load = async (candidates) => candidates.map((candidate) => ({candidate,snapshot:{messageId:'wrong',content:'wrong body',items:null,durationMs:null,metadata:null}}));
    const plan = await p.service.preview(principal()); assert.equal(plan.planId,null); assert.equal(plan.issues.length,1); assert.equal(p.backups().length,0);
    p.hooks.load = async () => { p.f.mutate("UPDATE users SET role='member' WHERE id='admin'"); return []; };
    await assert.rejects(p.service.preview(principal()),{code:'FORBIDDEN'});
    await assert.rejects(p.port.readRepairCandidates({principal:principal('owner'),cursor:null}),{code:'FORBIDDEN'});
  } finally { await p.cleanup(); }
});
test('backup creation failure cannot enter the business transaction or replace original messages', async () => {
  const p = await prepared();
  try {
    const plan = await p.service.preview(principal()); fs.writeFileSync(path.join(p.f.directory,'repair-backups'),'synthetic blocker');
    await assert.rejects(p.service.apply(principal(),plan.planId!),{code:'STORAGE_UNAVAILABLE'});
    assert.equal(p.f.scalar(`SELECT message_revision FROM sessions WHERE id='${session}'`),1);
    assert.equal(p.f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND content<>''`),0);
  } finally { await p.cleanup(); }
});
test('repair HTTP preserves administrator, trusted-origin and strict plan boundaries', async () => {
  const p = await prepared();
  try {
    assert.equal((await p.request('preview',{},'owner')).status,403);
    assert.equal((await p.request('preview',{},'admin','https://untrusted.invalid')).status,403);
    assert.equal((await p.request('apply',{planId:'bad'})).status,400);
    const response = await p.request('preview',{}); assert.equal(response.status,200); const plan=await response.json() as any;
    const applied = await p.request('apply',{planId:plan.planId}); assert.equal(applied.status,200); assert.deepEqual(await applied.json(),{restoredCount:1});
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'"); assert.equal((await p.request('apply',{planId:plan.planId})).status,403);
  } finally { await p.cleanup(); }
});

test('source I/O worker, private candidate query, verified backup and repair transaction form one synthetic recovery chain',async()=>{
  const p=await prepared();const reader=new RepairSourceReader({root:p.f.directory});
  try{
    fs.writeFileSync(path.join(p.f.directory,`rollout-${thread}.jsonl`),[
      JSON.stringify({type:'session_meta',payload:{id:thread}}),
      JSON.stringify({type:'event_msg',payload:{type:'item_completed',turn_id:'repair-turn',item:{id:'final',type:'AgentMessage',phase:'final_answer',content:[{text:body}]}}}),
    ].join('\n'));
    const service=new StoredMessageRepair({port:p.port,storeId:'store',generation:1,maintenanceBusy:()=>false,
      loadSnapshots:(candidates)=>reader.loadSnapshots(candidates),changed:async()=>{}});
    const plan=await service.preview(principal());assert.equal(plan.turnCount,1);
    assert.deepEqual(await service.apply(principal(),plan.planId!),{state:'committed',restoredCount:1});
    assert.equal(p.f.scalar(`SELECT content FROM messages WHERE session_id='${session}' AND content<>''`),body);
  }finally{await reader.dispose();await p.cleanup();}
});
