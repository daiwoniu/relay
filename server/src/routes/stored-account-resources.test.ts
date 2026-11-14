import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { CodexAccountSnapshotDtoSchema } from '../contracts/index.js';
import { createStoredAccountResourcesRouter } from './stored-account-resources.js';
import type { CodexLocalUsageSnapshot } from '../system/codex-local-usage-service.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { randomUUID } from 'node:crypto';
async function prepared(){
  const f=fixture();for(const id of ['admin','owner'])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hashSessionToken('synthetic-resources-'+id)}','${id}',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'resources-test',generation:1,initialize:true});
  const state={account:CodexAccountSnapshotDtoSchema.parse({fetchedAt:1000,status:'ready',authMode:'chatgpt',email:'a@example.test',planType:null,rateLimits:[],credits:null,rateLimitResetCredits:null,usage:null,errorMessage:null,identityVerified:true}),calls:0,scans:0,
    usage:{email:'a@example.test',timeZone:'Asia/Shanghai' as const,dailyUsageBuckets:[{startDate:'2026-11-06',tokens:10}],backfill:null} as CodexLocalUsageSnapshot};
  const hooks={local:async()=>{state.scans++;return state.usage;},reset:async()=> 'reset' as const};
  const app=new Hono().route('/api/system',createStoredAccountResourcesRouter({port,snapshots:{official:async(_principal,force)=>{state.calls++;if(force===undefined)assert.fail('explicit force required');return state.account;}},localUsage:{getSnapshot:()=>hooks.local()},creditReset:{run:()=>hooks.reset()}}));
  return{f,port,state,hooks,app,headers:(id='admin')=>({cookie:'relay_session=synthetic-resources-'+id}),cleanup:async()=>{await port.close();f.cleanup();}};
}
test('stored statistics routes require current admin, strict query scope and no-store responses',async()=>{
  const p=await prepared();try{const url='/api/system/codex-account';assert.equal((await p.app.request(url)).status,401);assert.equal((await p.app.request(url,{headers:p.headers('owner')})).status,403);assert.equal((await p.app.request(url+'?email=injected',{headers:p.headers()})).status,400);
    const response=await p.app.request(url+'?refresh=1',{headers:p.headers()});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.json() as any).email,'a@example.test');assert.equal(p.state.calls,1);
  }finally{await p.cleanup();}
});

test('Native reset HTTP retains current admin, origin, strict body and explicit unknown-result semantics',async()=>{
  const p=await prepared();let calls=0;p.hooks.reset=async()=>{calls++;return'reset';};
  const request=(body:unknown,owner='admin',origin='http://localhost:5173')=>p.app.request('/api/system/codex-account/reset-credit',{
    method:'POST',headers:{...p.headers(owner),origin,'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    const body={idempotencyKey:randomUUID()};
    assert.equal((await request(body,'owner')).status,403);assert.equal((await request(body,'admin','https://evil.invalid')).status,403);
    assert.equal((await request({...body,identityKey:'injected'})).status,400);assert.equal((await request({idempotencyKey:'invalid'})).status,400);assert.equal(calls,0);
    const ok=await request(body);assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{outcome:'reset'});assert.equal(ok.headers.get('cache-control'),'private, no-store');
    p.hooks.reset=async()=>{throw new StorageContractError('STORAGE_UNAVAILABLE');};
    const unknown=await request(body);assert.equal(unknown.status,503);assert.equal((await unknown.json()as any).code,'STORAGE_RESULT_UNKNOWN');
  }finally{await p.cleanup();}
});
test('combined statistics project matching verified identity and standalone usage preserves the same scope',async()=>{
  const p=await prepared();try{p.state.usage.email='A@EXAMPLE.TEST';for(const suffix of ['/resources','/local-usage']){const response=await p.app.request('/api/system/codex-account'+suffix,{headers:p.headers()});assert.equal(response.status,200);const value=await response.json() as any;assert.equal((value.localUsage??value).dailyUsageBuckets[0].tokens,10);}assert.equal(p.state.scans,2);}finally{await p.cleanup();}
});
test('unverified identities and API keys do not scan local history',async()=>{
  const p=await prepared();try{for(const mode of ['unverified','apikey']){p.state.account.identityVerified=mode!=='unverified';p.state.account.authMode=mode==='apikey'?'apikey':'chatgpt';const response=await p.app.request('/api/system/codex-account/resources',{headers:p.headers()});assert.equal(response.status,200);assert.equal((await response.json() as any).localUsage,null);assert.equal((await p.app.request('/api/system/codex-account/local-usage',{headers:p.headers()})).status,503);}assert.equal(p.state.scans,0);}finally{await p.cleanup();}
});
test('mixed-account usage is withheld from combined and standalone responses',async()=>{
  const p=await prepared();try{p.state.usage.email='b@example.test';const response=await p.app.request('/api/system/codex-account/resources',{headers:p.headers()});assert.equal(response.status,200);const value=await response.json() as any;assert.equal(value.localUsage,null);assert.ok(value.localUsageError);assert.equal(JSON.stringify(value).includes('b@example.test'),false);assert.equal((await p.app.request('/api/system/codex-account/local-usage',{headers:p.headers()})).status,409);}finally{await p.cleanup();}
});
test('role revocation while reading usage refuses the whole HTTP response rather than serving cached account data',async()=>{
  const p=await prepared();try{p.hooks.local=async()=>{p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");return p.state.usage;};const response=await p.app.request('/api/system/codex-account/resources',{headers:p.headers()});assert.equal(response.status,403);assert.equal(JSON.stringify(await response.json()).includes('a@example.test'),false);}finally{await p.cleanup();}
});
