import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredFollowups } from './stored-followups.js';
import { createSessionRuntimeState } from '../engine/runtime.js';
import type { StoredStopBinding } from './stored-runtime-stop.js';
import type { CoreCommandInputs,StoragePrincipal } from '../storage/contracts.js';
const actor=markRead().principal as Extract<StoragePrincipal,{kind:'user'}>;
const input=(messageId='next'):CoreCommandInputs['followup.submit']=>({sessionId:'session',messageId,content:'next input',attachments:[],replyToAsyncQuestionId:null,origin:null});
async function setup(outcome:'accepted'|'unsupported'|'unknown'='accepted',live=true,failPublication=false){
  const f=fixture();f.mutate("UPDATE sessions SET status='processing',active_turn_id='turn'");
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:'codex'});let calls=0;const published:string[]=[];
  Object.assign(runtime,{isRunning:true,currentTurnId:'turn',attemptId:'attempt',engineConnectionId:'connection',leaseToken:'lease',engineConnection:{steer:async()=>{calls++;if(outcome==='unknown')throw Error('unknown provider response');return outcome;}}});
  const binding={runtime,version:1,events:undefined!} as StoredStopBinding;
  const service=new StoredFollowups(port,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},getBinding:()=>live?binding:undefined,
    changed:async()=>{},diagnostic:()=>{},accepted:async result=>{published.push(result.savedMessage.id);if(failPublication)throw Error('synthetic publication failure');},enqueue:async(record,state)=>{
      const result=await port.execute({...markRead(),operationId:`deliver:${record.id}`,principal:{kind:'system',purpose:'scheduler'},command:{name:'turn.enqueue',input:{sessionId:record.sessionId,
        attemptId:randomUUID(),messageId:record.id,engineId:state.engineId,resourceKey:'codex:default',content:record.content.trim(),metadata:null,expectedPreferencesRevision:state.preferencesRevision,origin:{kind:'followup',followupId:record.id}}}});
      assert.equal(result.state,'committed');
    }});
  return{f,port,service,published,calls:()=>calls,close:async()=>{await service.close();await port.close();f.cleanup();}};
}
test('a confirmed steer saves its user message once and replayed submission never invokes the provider again',async()=>{
  const h=await setup();try{
    assert.equal((await h.service.submit(actor,input())).state,'steered');assert.equal(h.calls(),1);
    assert.deepEqual(h.published,['next']);
    assert.equal(h.f.scalar("SELECT content FROM messages WHERE id='next'"),'next input');
    assert.equal((await h.service.submit(actor,input())).state,'steered');assert.equal(h.calls(),1);
  }finally{await h.close();}
});
test('unknown steer survives recovery without resending and requires explicit cancellation',async()=>{
  const h=await setup('unknown');try{
    assert.equal((await h.service.submit(actor,input())).state,'uncertain');await h.service.recover('session');assert.equal(h.calls(),1);
    assert.equal((await h.service.cancel(actor,'session','next')).state,'cancelled');
  }finally{await h.close();}
});
test('failed previous turns pause FIFO messages; explicit resume consumes only the first atomically',async()=>{
  const h=await setup('unsupported',false);try{
    await h.service.submit(actor,input('a'));await h.service.submit(actor,input('b'));await h.service.onTerminal('session',false);
    assert.equal(h.f.scalar("SELECT count(*) FROM session_followups WHERE state='paused'"),2);
    h.f.mutate("DELETE FROM engine_resource_leases;UPDATE sessions SET active_attempt_id=NULL,active_turn_id=NULL,status='completed'");
    await h.service.resume(actor,'session');
    assert.equal(h.f.scalar("SELECT state FROM session_followups WHERE id='a'"),'delivered');assert.equal(h.f.scalar("SELECT state FROM session_followups WHERE id='b'"),'queued');
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_queue_entries'),1);
  }finally{await h.close();}
});
test('positive steer with a failed local save recovers only the idempotent save, not the engine request',async()=>{
  const h=await setup();try{
    h.f.mutate("CREATE TRIGGER fail_followup_receipt BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='followup.confirmSteer' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const result=await h.service.submit(actor,input());assert.equal(result.state,'uncertain');assert.equal(result.errorCode,'STEER_MESSAGE_SAVE_FAILED');
    assert.deepEqual(h.published,[],'uncommitted user messages must not be published');
    h.f.mutate('DROP TRIGGER fail_followup_receipt');await h.service.recover('session');
    assert.equal(h.f.scalar("SELECT state FROM session_followups WHERE id='next'"),'steered');assert.equal(h.calls(),1);
    assert.deepEqual(h.published,['next'],'recovered local confirmation must publish the newly saved user message');
    await h.service.recover('session');assert.deepEqual(h.published,['next']);assert.equal(h.calls(),1);
  }finally{await h.close();}
});

test('publication failure cannot turn a confirmed steer into an uncertain message or resend it',async()=>{
  const h=await setup('accepted',true,true);try{
    assert.equal((await h.service.submit(actor,input())).state,'steered');
    assert.equal((await h.service.submit(actor,input())).state,'steered');
    assert.equal(h.calls(),1);assert.equal(h.f.scalar("SELECT count(*) FROM messages WHERE id='next'"),1);
    assert.deepEqual(h.published,['next']);
  }finally{await h.close();}
});
