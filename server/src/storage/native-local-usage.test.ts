import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './storage-fixture.test-support.js';
import { nativeQueries } from './native-queries.js';
import { ensureCodexLocalUsageTables } from '../db/codex-local-usage-migration.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreStoragePort,CoreCommand,StoragePrincipal } from './contracts.js';
import type { CodexLocalUsageEvent } from '../system/codex-local-usage.js';
import { StoredLocalUsage } from '../system/stored-local-usage.js';
import { hashSessionToken } from '../auth/session.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { streamCodexLocalUsageEvents } from '../system/codex-local-usage-stream.js';
const actor={kind:'user' as const,userId:'admin',authSessionHash:hashSessionToken('synthetic-local-usage-admin')},maintenance={kind:'system' as const,purpose:'maintenance' as const};
const now=Date.parse('2026-11-06T04:00:00Z');
const event=(id:string,overrides:Partial<CodexLocalUsageEvent>={}):CodexLocalUsageEvent=>({fingerprint:createHash('sha256').update(id).digest('hex'),day:'2026-11-06',accountId:'account-a',tokens:10,inputTokens:7,cachedInputTokens:2,outputTokens:3,...overrides});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const f=fixture(),db=new DatabaseSync(f.filename);try{ensureCodexLocalUsageTables(nativeQueries(db));}finally{db.close();}
  f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${actor.authSessionHash}','admin',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'usage-test',generation:1,initialize:true});const services:StoredLocalUsage[]=[];
  const state={account:{email:'a@example.test',accountId:'account-a' as string|null},events:[event('first')],scans:0};
  const make=(overrides:Partial<ConstructorParameters<typeof StoredLocalUsage>[0]>={})=>{const service=new StoredLocalUsage({port,storeId:'usage-test',generation:1,now:()=>now,resolveAccount:async()=>({...state.account}),
    events:async function*(since,until){state.scans++;const start=new Date(since.getTime()+8*3600000).toISOString().slice(0,10),end=new Date(until.getTime()+8*3600000).toISOString().slice(0,10);for(const item of state.events)if(item.day>=start&&item.day<=end)yield item;},...overrides});services.push(service);return service;};
  const request=(command:CoreCommand,principal:StoragePrincipal=actor,key:string=randomUUID())=>({protocolVersion:1 as const,storeId:'usage-test',workerGeneration:1,requestId:randomUUID(),operationId:key,principal,command});
  const ok=async(command:CoreCommand,principal?:StoragePrincipal):Promise<any>=>{const result=await port.execute(request(command,principal));assert.equal(result.state,'committed');return result.state==='committed'?result.value:null;};
  const proxy=(overrides:Partial<CoreStoragePort>)=>new Proxy(port,{get(target,key){const value=Reflect.get(overrides,key)??Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as CoreStoragePort;
  return{f,port,state,make,request,ok,proxy,cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await port.close();f.cleanup();}};
}
test('usage streams bounded pages, atomically deduplicates fingerprints and reports 365 Shanghai buckets',async()=>{
  const p=await prepared();try{p.state.events=Array.from({length:257},(_,i)=>event('page-'+i));const service=p.make(),first=await service.getSnapshot(actor);
    assert.equal(first.dailyUsageBuckets.length,365);assert.equal(first.dailyUsageBuckets.at(-1)!.tokens,2570);assert.equal(first.sourceMeta!.state,'live');assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),257);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_usage_stage'),0);
    assert.equal((await service.getSnapshot(actor)).dailyUsageBuckets.at(-1)!.tokens,2570);assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),257);
  }finally{await p.cleanup();}
});
test('unknown accounts and unattributed current logs are skipped, known historical accounts retain their mapping',async()=>{
  const p=await prepared();try{p.f.mutate("INSERT INTO codex_local_usage_accounts VALUES('known-b','b@example.test')");p.state.events=[event('current'),event('known',{accountId:'known-b',tokens:20}),event('unknown',{accountId:'unknown'}),event('unattributed',{accountId:null})];
    assert.equal((await p.make().getSnapshot(actor)).dailyUsageBuckets.at(-1)!.tokens,10);assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),2);
    const b=await p.port.readLocalUsage({principal:actor,email:'b@example.test',sinceDay:'2026-11-01',untilDay:'2026-11-06'});assert.equal(b.rows[0]!.tokens,20);
  }finally{await p.cleanup();}
});
test('confirmed historical backfill needs matching account evidence and commits its marker with facts',async()=>{
  const p=await prepared();try{p.state.events=[event('proof',{day:'2026-09-24'}),event('legacy',{day:'2026-09-25',accountId:null,tokens:5}),event('unknown-later',{accountId:null,tokens:99}),event('current',{tokens:2})];
    const service=p.make(),snapshot=await service.getSnapshot(actor);assert.equal(snapshot.backfill!.email,'a@example.test');assert.equal(p.f.scalar("SELECT sum(tokens) FROM codex_local_usage_events WHERE email='a@example.test'"),17);
    assert.equal(p.f.scalar("SELECT count(*) FROM codex_local_usage_events WHERE attribution='confirmed_backfill'"),2);await service.getSnapshot(actor);assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),3);
  }finally{await p.cleanup();}
});
test('unproven or contradictory historical accounts roll the whole sync back and leave it unavailable',async()=>{
  for(const events of [[event('unknown',{day:'2026-09-24',accountId:null})],[event('a',{day:'2026-09-24'}),event('b',{day:'2026-09-25',accountId:'other-account'})]]){const p=await prepared();try{p.state.events=events;
    const result=await p.make().getSnapshot(actor);assert.equal(result.sourceMeta!.state,'unavailable');assert.deepEqual(result.dailyUsageBuckets,[]);for(const table of ['codex_local_usage_events','codex_local_usage_accounts','codex_local_usage_backfill','codex_local_usage_sync'])assert.equal(p.f.scalar(`SELECT count(*) FROM ${table}`),0);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_usage_stage'),0);
  }finally{await p.cleanup();}}
});
test('usage receipt failure rolls events, mappings, marker and sync time back instead of compensating committed facts',async()=>{
  const p=await prepared();try{p.state.events=[event('proof',{day:'2026-09-24'})];p.f.mutate("CREATE TRIGGER usage_receipt_failure BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='usage.commitSync' BEGIN SELECT RAISE(ABORT,'synthetic');END");
    assert.equal((await p.make().getSnapshot(actor)).sourceMeta!.state,'unavailable');for(const table of ['codex_local_usage_events','codex_local_usage_accounts','codex_local_usage_backfill','codex_local_usage_sync'])assert.equal(p.f.scalar(`SELECT count(*) FROM ${table}`),0);
    p.f.mutate('DROP TRIGGER usage_receipt_failure');assert.equal((await p.make().getSnapshot(actor)).sourceMeta!.state,'live');assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_backfill'),1);
  }finally{await p.cleanup();}
});
test('lost commit response is proven by the durable job; repeated sync never double counts',async()=>{
  const p=await prepared();try{const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);return request.command.name==='usage.commitSync'?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:result;},lookup:async()=>{throw new Error('unavailable');}} as any);
    const service=p.make({port});assert.equal((await service.getSnapshot(actor)).sourceMeta!.state,'live');assert.equal((await service.getSnapshot(actor)).dailyUsageBuckets.at(-1)!.tokens,10);assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),1);
  }finally{await p.cleanup();}
});
test('different raw facts behind the same fingerprint are refused without modifying older usage',async()=>{
  const p=await prepared();try{const service=p.make();await service.getSnapshot(actor);p.state.events=[event('first',{tokens:99})];
    const report=await service.getSnapshot(actor);assert.equal(report.sourceMeta!.state,'failed_snapshot');assert.equal(report.dailyUsageBuckets.at(-1)!.tokens,10);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_usage_stage'),0);
  }finally{await p.cleanup();}
});
test('unsafe aggregate and conflicting account mapping cannot commit usage or a fresh sync marker',async()=>{
  for(const conflict of ['mapping','sum','input']){const p=await prepared();try{
    if(conflict==='mapping')p.f.mutate("INSERT INTO codex_local_usage_accounts VALUES('account-a','different@example.test')");else if(conflict==='sum')p.state.events=[event('max',{tokens:Number.MAX_SAFE_INTEGER}),event('plus',{tokens:1})];else p.state.events=[event('input-max',{inputTokens:Number.MAX_SAFE_INTEGER}),event('input-plus',{inputTokens:1})];
    assert.equal((await p.make().getSnapshot(actor)).sourceMeta!.state,'unavailable');assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),0);assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_sync'),0);
  }finally{await p.cleanup();}}
});
test('older tickets and changed global backfill cannot advance a newer sync',async()=>{
  const p=await prepared();try{const first=await p.ok({name:'usage.beginSync',input:{jobId:randomUUID(),email:'a@example.test',accountId:'account-a',untilDay:'2026-11-06'}}),second=await p.ok({name:'usage.beginSync',input:{jobId:randomUUID(),email:'a@example.test',accountId:'account-a',untilDay:'2026-11-06'}});
    const old=await p.port.execute(p.request({name:'usage.commitSync',input:{jobId:first.jobId}}));assert.equal(old.state,'rejected');if(old.state==='rejected')assert.equal(old.code,'SUPERSEDED');
    p.f.mutate("INSERT INTO codex_local_usage_backfill VALUES(1,'b@example.test',1)");const changed=await p.port.execute(p.request({name:'usage.commitSync',input:{jobId:second.jobId}}));assert.equal(changed.state,'rejected');assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_sync'),0);
  }finally{await p.cleanup();}
});
test('current provider account changes during scanning reject the old response and preserve facts',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const service=p.make({events:async function*(){entered.resolve();await release.promise;yield event('late');}}),run=service.getSnapshot(actor);await Promise.race([entered.promise,run.then(()=>{throw new Error('SCAN_NOT_ENTERED');})]);p.state.account={email:'b@example.test',accountId:'account-b'};release.resolve();
    await assert.rejects(run,{code:'CONFLICT'});assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),0);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_usage_stage'),0);
  }finally{release.resolve();await p.cleanup();}
});
test('missing account ID keeps a previous snapshot without scanning or assigning unattributed logs',async()=>{
  const p=await prepared();try{const service=p.make();await service.getSnapshot(actor);const scans=p.state.scans;p.state.account.accountId=null;
    const result=await service.getSnapshot(actor);assert.equal(result.sourceMeta!.state,'failed_snapshot');assert.equal(result.dailyUsageBuckets.at(-1)!.tokens,10);assert.equal(p.state.scans,scans);
  }finally{await p.cleanup();}
});
test('maintenance only discards unfinished staging and current non-admin cannot read or commit source facts',async()=>{
  const p=await prepared();try{const job=await p.ok({name:'usage.beginSync',input:{jobId:randomUUID(),email:'a@example.test',accountId:'account-a',untilDay:'2026-11-06'}});await p.ok({name:'usage.appendSync',input:{jobId:job.jobId,events:[event('staged')]}});
    assert.equal((await p.make().rejectUnfinished(job.jobId))!.phase,'rejected');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_usage_stage'),0);assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),0);
    await assert.rejects(p.port.execute(p.request({name:'usage.commitSync',input:{jobId:job.jobId}},maintenance)),{code:'FORBIDDEN'});
    await assert.rejects(p.port.readLocalUsage({principal:{kind:'user',userId:'owner',authSessionHash:'auth-owner'},email:'a@example.test',sinceDay:'2026-11-01',untilDay:'2026-11-06'}),{code:'FORBIDDEN'});
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");await assert.rejects(p.port.readLocalUsageJob({principal:actor,jobId:job.jobId}),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});
test('same-principal concurrent reports share work and shutdown prevents late source commits',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const service=p.make({events:async function*(){entered.resolve();await release.promise;yield event('late');}}),first=service.getSnapshot(actor),second=service.getSnapshot(actor);assert.equal(first,second);await Promise.race([entered.promise,first.then(()=>{throw new Error('SCAN_NOT_ENTERED');})]);
    const closing=service.close();release.resolve();assert.equal((await first).sourceMeta!.state,'unavailable');await closing;assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),0);await assert.rejects(service.getSnapshot(actor),{code:'NOT_SUBMITTED'});
  }finally{release.resolve();await p.cleanup();}
});

test('account changes or role revocation during the final aggregation cannot escape in a report',async()=>{
  for(const mode of ['account','role']){const p=await prepared();try{const port=p.proxy({readLocalUsage:async(input)=>{const value=await p.port.readLocalUsage(input);if(mode==='account')p.state.account={email:'b@example.test',accountId:'account-b'};else p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");return value;}});
    await assert.rejects(p.make({port}).getSnapshot(actor),{code:mode==='account'?'CONFLICT':'FORBIDDEN'});assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),1);
  }finally{await p.cleanup();}}
});
test('real bounded JSONL iterator and Native usage pipeline deduplicate fork copies end to end',async()=>{
  const p=await prepared();try{const root=path.join(p.f.directory,'synthetic-codex'),sessions=path.join(root,'sessions');await fs.mkdir(sessions,{recursive:true});
    const metadata=JSON.stringify({type:'session_meta',payload:{originator:'relay',model_provider:'openai',creator_account_id:'account-a'}}),line=JSON.stringify({timestamp:'2026-11-06T03:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:10},last_token_usage:{total_tokens:10,input_tokens:7,cached_input_tokens:2,output_tokens:3}}}});
    for(const name of ['a.jsonl','fork.jsonl'])await fs.writeFile(path.join(sessions,name),metadata+'\n'+line+'\n');
    const result=await p.make({events:(since,until)=>streamCodexLocalUsageEvents(root,since,until)}).getSnapshot(actor);assert.equal(result.sourceMeta!.state,'live');assert.equal(result.dailyUsageBuckets.at(-1)!.tokens,10);assert.equal(p.f.scalar('SELECT count(*) FROM codex_local_usage_events'),1);
  }finally{await p.cleanup();}
});
test('forced password change rejects a source report before reading provider account metadata',async()=>{
  const p=await prepared();try{let resolves=0;const service=p.make({resolveAccount:async()=>{resolves++;return p.state.account;}});p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='admin'");
    await assert.rejects(service.getSnapshot(actor),{code:'FORBIDDEN'});assert.equal(resolves,0);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_usage_jobs'),0);
  }finally{await p.cleanup();}
});
