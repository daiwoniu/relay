import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeStore } from './native-store.js';
import { fixture,markRead } from './storage-fixture.test-support.js';
import type { StorageCommandEnvelope } from './contracts.js';
const identityKey='chatgpt:synthetic@example.test';

test('reset credit intents bind actor/account/input and unknown dispatch blocks other keys across restart',()=>{
  const f=fixture();let store=new NativeStore(f.filename,'store',1,true);const jobId=randomUUID(),claimToken=randomUUID();
  const command=(name:string,input:any,principal:any=markRead('x','admin').principal):StorageCommandEnvelope=>({...markRead(),operationId:randomUUID(),principal,command:{name,input}} as StorageCommandEnvelope);
  try{
    assert.equal(store.execute(command('creditReset.prepare',{jobId,identityKey,creditId:null},markRead().principal)).state,'rejected');
    assert.equal(store.execute(command('creditReset.prepare',{jobId,identityKey,creditId:null})).state,'committed');
    assert.equal(store.execute(command('creditReset.prepare',{jobId,identityKey,creditId:'different'})).state,'rejected');
    assert.equal(store.execute(command('creditReset.claim',{jobId,identityKey:'chatgpt:other@example.test',claimToken})).state,'rejected');
    const claim=command('creditReset.claim',{jobId,identityKey,claimToken});assert.equal(store.execute(claim).state,'committed');assert.equal(store.execute(claim).state,'committed');
    assert.equal(store.execute(command('creditReset.rejectPrepared',{jobId},{kind:'system',purpose:'maintenance'})).state,'rejected');
    store.close();store=new NativeStore(f.filename,'store',1);
    assert.equal(store.readCreditResetJob({principal:markRead('x','admin').principal as any,jobId})?.phase,'dispatched');
    assert.equal(store.execute(command('creditReset.prepare',{jobId:randomUUID(),identityKey,creditId:null})).state,'rejected');
    f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    assert.throws(()=>store.readCreditResetJob({principal:markRead('x','admin').principal as any,jobId}),/FORBIDDEN/);
    assert.throws(()=>store.lookup({storeId:'store',operationId:claim.operationId,principal:claim.principal}),/FORBIDDEN/);
    const confirmed=store.execute(command('creditReset.confirm',{jobId,claimToken,outcome:'reset'},{kind:'system',purpose:'maintenance'}));assert.equal(confirmed.state,'committed');
    assert.equal(f.scalar("SELECT outcome FROM _relay_credit_resets"),'reset','proven external outcome survives actor revocation');
  }finally{store.close();f.cleanup();}
});

test('credit reset preparation rolls back with receipt failure and may be rejected only before external dispatch',()=>{
  const f=fixture(),store=new NativeStore(f.filename,'store',1,true),jobId=randomUUID();
  const prepare:StorageCommandEnvelope={...markRead('x','admin'),command:{name:'creditReset.prepare',input:{jobId,identityKey,creditId:null}}};
  try{
    f.mutate("CREATE TRIGGER stop_reset_receipt BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'synthetic');END");
    assert.equal(store.execute(prepare).state,'unknown');assert.equal(f.scalar('SELECT COUNT(*) FROM _relay_credit_resets'),0);
    f.mutate('DROP TRIGGER stop_reset_receipt');assert.equal(store.execute(prepare).state,'committed');
    assert.equal(store.execute({...markRead('reject','admin'),command:{name:'creditReset.rejectPrepared',input:{jobId}}}).state,'committed');
    assert.equal(store.execute({...markRead('other','admin'),command:{name:'creditReset.prepare',input:{jobId:randomUUID(),identityKey,creditId:null}}}).state,'committed');
  }finally{store.close();f.cleanup();}
});

test('Codex maintenance fences prevent a prepared credit reset from crossing into provider dispatch',()=>{
  const f=fixture(),store=new NativeStore(f.filename,'store',1,true),jobId=randomUUID(),claimToken=randomUUID();
  try{
    assert.equal(store.execute({...markRead('prepare','admin'),command:{name:'creditReset.prepare',input:{jobId,identityKey,creditId:null}}}).state,'committed');
    assert.equal(store.execute({...markRead('fence'),principal:{kind:'system',purpose:'maintenance'},command:{name:'maintenance.acquire',input:{fenceId:'maintenance',engineId:'codex'}}}).state,'committed');
    const claim:StorageCommandEnvelope={...markRead('claim','admin'),command:{name:'creditReset.claim',input:{jobId,identityKey,claimToken}}};
    assert.equal(store.execute(claim).state,'rejected');assert.equal(f.scalar('SELECT phase FROM _relay_credit_resets'),'prepared');
    assert.equal(store.execute({...markRead('release'),principal:{kind:'system',purpose:'maintenance'},command:{name:'maintenance.release',input:{fenceId:'maintenance'}}}).state,'committed');
    assert.equal(store.execute(claim).state,'committed');assert.equal(store.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}}).byEngine.codex,2);
  }finally{store.close();f.cleanup();}
});
