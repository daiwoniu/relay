import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredThemeAssets } from './stored-theme-assets.js';
import { StoredStartupRecovery } from './stored-startup-recovery.js';

test('startup enumerates all pages, settles unused theme intents and retains unknown external operations without sending',async()=>{
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const theme=new StoredThemeAssets({port,storeId:'store',generation:1,root:path.join(f.directory,'themes'),assertExclusiveWriter:async()=>{}});
  const unused=new Proxy({},{get:()=>()=>{throw Error('startup must not send unknown provider effects');}}),jobId=randomUUID();
  try{
    f.mutate('CREATE TABLE user_theme_assets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL)');
    for(let index=0;index<70;index++){
      const sessionId=randomUUID();f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,engine,status,message_revision) VALUES('${sessionId}','owner','project','codex','idle',0);
        INSERT INTO _relay_external_operations VALUES('${randomUUID()}','unarchive','owner','${sessionId}','synthetic','external-${index}','dispatched',1,1)`);
    }
    assert.equal((await port.execute({...markRead(),operationId:'unused-theme',command:{name:'themeAsset.prepareUpload',input:{jobId,assetId:randomUUID(),desktop:{digest:'0'.repeat(64),size:1},mobile:{digest:'0'.repeat(64),size:1}}}})).state,'committed');
    const recovery=new StoredStartupRecovery({port,theme,purge:unused,softDelete:unused,uploads:unused,graph:unused,assertExclusiveWriter:async()=>{}} as any);
    const result=await recovery.recover();assert.equal(result.count,71);assert.equal(result.blockedCount,70);assert.equal(result.blocked.length,64);assert.equal(result.truncated,true);
    const job=await port.readThemeAssetJob({principal:{kind:'system',purpose:'maintenance'},jobId});assert.equal(job?.phase,'rejected');assert.equal(job?.filesFinished,true);
    assert.equal(f.scalar("SELECT count(*) FROM _relay_external_operations WHERE phase='dispatched'"),70);
    await assert.rejects(port.readStartupWorkPage({principal:markRead().principal,phase:'files',after:null,limit:32} as any),/INVALID_ARGUMENT/);
  }finally{await theme.close();await port.close();f.cleanup();}
});

test('startup dispatch enumeration includes each queued resource and inactive followup once',async()=>{
  const f=fixture();f.mutate('DELETE FROM engine_resource_leases;DELETE FROM messages;DELETE FROM sessions');
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':1}}),calls:string[]=[];
  try{
    for(let index=0;index<2;index++)assert.equal((await port.execute({...markRead(),operationId:'enqueue-'+index,command:{name:'turn.enqueue',input:{sessionId:'draft-'+index,attemptId:'attempt-'+index,messageId:'message-'+index,engineId:'codex',resourceKey:'codex:default',content:'queued',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:'project',title:'queued',titleManuallySet:false}}}})).state,'committed');
    for(let index=0;index<2;index++)assert.equal((await port.execute({...markRead(),operationId:'followup-'+index,command:{name:'followup.submit',input:{sessionId:'draft-0',messageId:'followup-'+index,content:'later',attachments:[],replyToAsyncQuestionId:null,origin:null}}})).state,'committed');
    assert.equal((await port.execute({...markRead(),operationId:'cancel-first',command:{name:'queue.cancel',input:{sessionId:'draft-0',expectedAttemptId:'attempt-0',messageId:'cancelled-first'}}})).state,'committed');
    const graph={followups:{recover:async(id:string)=>{calls.push('followup:'+id);}},scheduler:{drain:async(key:string)=>{calls.push('queue:'+key);}}};
    const unused=new Proxy({},{get:()=>()=>{throw Error('unrequested file recovery');}});
    const recovery=new StoredStartupRecovery({port,graph,purge:unused,theme:unused,softDelete:unused,uploads:unused,assertExclusiveWriter:async()=>{}} as any);
    assert.equal(await recovery.resume(),2);assert.deepEqual(calls,['followup:draft-0','queue:codex:default']);
    assert.equal(f.scalar("SELECT count(*) FROM engine_queue_entries WHERE state='queued'"),1);
  }finally{await port.close();f.cleanup();}
});
