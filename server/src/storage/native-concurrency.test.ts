import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { StorageCommandEnvelope } from './contracts.js';

test('Native concurrency settings enforce fresh admin access, retain running leases and isolate member counts',async()=>{
  const f=fixture();
  f.mutate("INSERT INTO engine_queue_entries(id,session_id,attempt_id,user_message_id,engine_id,resource_key,requested_by_user_id,state,claim_token,created_at,claimed_at) VALUES('q','session','attempt','m1','codex','codex:default','owner','claimed','claim',1,1)");
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':4}});
  const owner={kind:'user' as const,userId:'owner',authSessionHash:'auth-owner'},admin={...owner,userId:'admin',authSessionHash:'auth-admin'};
  const request:StorageCommandEnvelope={...markRead(),operationId:'set-limit',principal:admin,command:{name:'concurrency.set',input:{resourceKey:'codex:default',engineId:'codex',maxActiveTurns:1}}};
  try{
    assert.equal((await port.readConcurrency({principal:owner,resourceKey:'codex:default'})).activeTurns,1);
    assert.equal((await port.readConcurrency({principal:{...owner,userId:'other',authSessionHash:'auth-other'},resourceKey:'codex:default'})).activeTurns,0);
    const denied=await port.execute({...request,operationId:'member-change',principal:owner});assert.equal(denied.state,'rejected');
    if(denied.state==='rejected')assert.equal(denied.code,'FORBIDDEN');
    const saved=await port.execute(request);assert.equal(saved.state,'committed');
    assert.equal(f.scalar("SELECT state FROM engine_resource_leases WHERE attempt_id='attempt'"),'running');
    assert.equal((await port.readConcurrency({principal:owner,resourceKey:'codex:default'})).maxActiveTurns,1);
    assert.equal((await port.execute(request)).state,'committed');
    f.mutate("UPDATE users SET role='member' WHERE id='admin'");
    assert.equal((await port.execute(request)).state,'rejected');
    await assert.rejects(port.lookup({storeId:'store',operationId:'set-limit',principal:admin}),/FORBIDDEN/);
    assert.equal(f.scalar('SELECT max_active_turns FROM engine_concurrency_settings'),1);
    await assert.rejects(port.readConcurrency({principal:owner,resourceKey:'codex:unknown'}),/NOT_FOUND/);
  }finally{await port.close();f.cleanup();}
});
