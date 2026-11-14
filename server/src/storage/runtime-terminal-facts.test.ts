import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import { RuntimeStorage } from './runtime-storage.js';
import type { EngineEventEnvelope } from '../engine/events.js';

const principal={kind:'runtime' as const,sessionId:'session',attemptId:'attempt',connectionId:'connection',runtimeVersion:1};
const event=(content='result'):EngineEventEnvelope=>({engineId:'codex',payload:{type:'message_complete',turnId:'final-turn',content},
  meta:{source:'realtime',sequence:1,observedAt:100,eventId:'finish',externalSessionId:'thread',externalTurnId:'final-turn'}});
const message=(content='result')=>({id:'result-message',turnId:'final-turn',content,items:null,metadata:null,durationMs:null});
async function setup(options:Partial<ConstructorParameters<typeof RuntimeStorage>[1]>={}){
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const storage=new RuntimeStorage(port,{storeId:'store',generation:1,leaseToken:'lease',engineId:'codex',runtime:{},principal,isCurrent:()=>true,onFailure:()=>{},...options});
  return{f,port,storage,close:async()=>{await storage.close().catch(()=>{});await port.close();f.cleanup();}};
}
test('authoritative terminal commits result, usage, host marker, revision and lease release before publication',async()=>{
  let h:Awaited<ReturnType<typeof setup>>;const order:string[]=[];
  h=await setup({beforeTerminal:()=>{assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);order.push('flush');},
    onTerminalCommitted:()=>{assert.equal(h.f.scalar('SELECT status FROM sessions'),'completed');assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);order.push('publish');}});
  try{await h.storage.process(event(),async(_,context)=>{
    await context.persistUsage({inputTokens:12});await context.persistHostContext({externalSessionId:'thread',compactionCount:0,delivered:true});
    const result=await context.finishTerminal(message());assert.equal(result.projection.decision.outcome,'completed');assert.equal(result.projection.revision,3);
  });assert.deepEqual(order,['flush','publish']);assert.equal(h.f.scalar("SELECT content FROM messages WHERE id='result-message'"),'result');
    assert.equal(h.f.scalar('SELECT active_turn_usage FROM sessions'),null);
  }finally{await h.close();}
});
test('missing final content becomes a durable failed result rather than completed',async()=>{
  const h=await setup();try{await h.storage.process(event(''),async(_,context)=>{
    const result=await context.finishTerminal(message(''));assert.equal(result.projection.decision.outcome,'failed');assert.equal(result.projection.decision.reasonCode,'FINAL_ANSWER_MISSING');
  });assert.equal(h.f.scalar('SELECT status FROM sessions'),'failed');assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);}finally{await h.close();}
});
test('real failure and confirmed local stop use the same authoritative terminal transaction',async()=>{
  for(const stopped of [false,true]){const h=await setup();try{
    if(stopped)await h.storage.processLocal({type:'interrupt_confirmed',userInitiated:true},async context=>{await context.finishTerminal(message(''));});
    else await h.storage.process({...event(),payload:{type:'error',diagnostic:{code:'CODEX_TURN_FAILED',phase:'stream',userMessage:'synthetic',originalMessage:'synthetic',retryable:false}}},async(_,context)=>{await context.finishTerminal(message(''));});
    assert.equal(h.f.scalar('SELECT status FROM sessions'),stopped?'stopped':'failed');assert.equal(h.f.scalar("SELECT stopped FROM messages WHERE id='result-message'"),Number(stopped));
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{await h.close();}}
});
test('snapshot content, turn identity and historical evidence cannot forge a successful result',async()=>{
  for(const kind of ['content','turn','history'] as const){const h=await setup();try{
    const captured=event();if(kind==='history')captured.meta.source='history';
    await assert.rejects(h.storage.process(captured,async(_,context)=>{await context.finishTerminal({...message(kind==='content'?'changed':'result'),...(kind==='turn'?{turnId:'another-turn'}:{})});}));
    assert.equal(h.f.scalar("SELECT count(*) FROM messages WHERE id='result-message'"),0);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await h.close();}}
});
test('receipt failure rolls back the entire terminal and retains accepted evidence and lease',async()=>{
  const h=await setup();h.f.mutate(`CREATE TRIGGER reject_finish BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='turn.finishFromFact'
    BEGIN SELECT RAISE(ABORT,'synthetic terminal receipt failure'); END;`);
  try{await assert.rejects(h.storage.process(event(),async(_,context)=>{await context.finishTerminal(message());}));
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),0);assert.equal(h.f.scalar('SELECT message_revision FROM sessions'),2);
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);assert.equal(h.f.scalar('SELECT count(*) FROM engine_turn_facts'),1);
  }finally{await h.close();}
});
test('lost terminal reply confirms its exact receipt; a missing receipt cannot publish or release',async()=>{
  for(const commit of [false,true]){let published=0;const h=await setup({onTerminalCommitted:()=>{published++;}}),execute=h.port.execute.bind(h.port);let finishCalls=0;
    h.port.execute=(async(request:any)=>{if(request.command.name!=='turn.finishFromFact')return execute(request);finishCalls++;if(commit)assert.equal((await execute(request)).state,'committed');
      return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};}) as typeof h.port.execute;
    try{const pending=h.storage.process(event(),async(_,context)=>{await context.finishTerminal(message());});if(commit)await pending;else await assert.rejects(pending);
      assert.equal(finishCalls,1);assert.equal(published,Number(commit));assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),commit?0:1);
    }finally{await h.close();}
  }
});
test('a retired runtime cannot publish a late committed terminal',async()=>{
  let owned=true,published=0;const h=await setup({isCurrent:()=>owned,onTerminalCommitted:()=>{published++;}}),execute=h.port.execute.bind(h.port);
  h.port.execute=(async(request:any)=>{const result=await execute(request);if(request.command.name==='turn.finishFromFact')owned=false;return result;}) as typeof h.port.execute;
  try{assert.deepEqual(await h.storage.process(event(),async(_,context)=>{await context.finishTerminal(message());}),{state:'stale'});
    assert.equal(published,0);assert.equal(h.f.scalar('SELECT status FROM sessions'),'completed');
  }finally{await h.close();}
});
test('an accepted pre-terminal flush failure retains the lease and cannot publish completion',async()=>{
  let published=0;const h=await setup({beforeTerminal:async()=>{throw new Error('synthetic flush failure');},onTerminalCommitted:()=>{published++;}});
  try{await assert.rejects(h.storage.process(event(),async(_,context)=>{await context.finishTerminal(message());}));
    assert.equal(published,0);assert.equal(h.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),0);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await h.close();}
});
test('publication failure preserves the committed result without rolling it back or invoking an engine',async()=>{
  const h=await setup({onTerminalCommitted:async()=>{throw new Error('synthetic publish failure');}});
  try{await assert.rejects(h.storage.process(event(),async(_,context)=>{await context.finishTerminal(message());}));
    assert.equal(h.f.scalar('SELECT status FROM sessions'),'completed');assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    assert.equal(h.f.scalar("SELECT content FROM messages WHERE id='result-message'"),'result');
    assert.equal(h.f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE command_name='turn.finishFromFact'"),1);
  }finally{await h.close();}
});
test('close evidence queued behind a committed terminal cannot poison the released attempt',async()=>{
  let failures=0,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const h=await setup({onFailure:()=>{failures++;}}),execute=h.port.execute.bind(h.port);
  h.port.execute=(async(request:any)=>{const result=await execute(request);if(request.command.name==='turn.finishFromFact'){entered();await gate;}return result;}) as typeof h.port.execute;
  try{const terminal=h.storage.process(event(),async(_,context)=>{await context.finishTerminal(message());});await waiting;
    const closed=h.storage.processLocal({type:'connection_closed',errorCode:'CODEX_CONNECTION_CLOSED'},()=>assert.fail('a committed attempt must not be failed again'));
    release();await terminal;assert.deepEqual(await closed,{state:'stale'});assert.equal(h.storage.isTerminalCommitted(),true);
    assert.equal(failures,0);assert.equal(h.storage.health().failed,false);assert.equal(h.f.scalar('SELECT count(*) FROM engine_turn_facts'),1);
    assert.deepEqual(await h.storage.updateUsage({inputTokens:99}),{state:'stale'});
    assert.deepEqual(await h.storage.setHostContext({externalSessionId:'thread',compactionCount:0,delivered:true}),{state:'stale'});
  }finally{release();await h.close();}
});
test('an error referring to a previous attempt turn cannot terminate the current pending attempt',async()=>{
  const h=await setup();h.f.mutate(`INSERT INTO engine_turn_facts(id,session_id,attempt_id,engine,connection_id,external_session_id,external_turn_id,fact_type,source,sequence,idempotency_key,observed_at,safe_payload_json,created_at)
    VALUES('prior-fact','session','prior-attempt','codex','prior-connection','thread','prior-turn','turn_started','realtime',1,'prior-key',1,'{}',1)`);
  try{await assert.rejects(h.storage.process({...event(),payload:{type:'error',diagnostic:{code:'CODEX_TURN_FAILED',phase:'send',retryable:false,userMessage:'synthetic stale error'}},
    meta:{...event().meta,externalTurnId:'prior-turn'}},()=>assert.fail('old turn must not become current evidence')));
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_turn_facts'),1);assert.equal(h.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),0);
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await h.close();}
});
