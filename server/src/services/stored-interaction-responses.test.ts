import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { createSessionRuntimeState } from '../engine/runtime.js';
import type { EngineConnection } from '../engine/adapter.js';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import type { StoredStopBinding } from './stored-runtime-stop.js';
import { StoredInteractionResponses } from './stored-interaction-responses.js';
import { createStoredInteractionProjection } from './stored-interaction-projection.js';
import { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import { createInteractionItem } from '../ws/frontend-interactions.js';
import { projectStoredRuntimeInteractions } from '../ws/stored-runtime-interactions.js';
import { StoredRuntimeStop } from './stored-runtime-stop.js';
import { finishStoredAssistant } from '../ws/stored-assistant-terminal.js';
import type { RespondInteractionCommand } from '../contracts/index.js';
import type { CoreStoragePort,StoragePrincipal,StorageCommandEnvelope,CommandResult,CoreCommandName } from '../storage/contracts.js';
type Options=ConstructorParameters<typeof StoredInteractionResponses>[1];
const sessionId=randomUUID(),interactionId='interaction:connection:1';
const owner=markRead().principal as Extract<StoragePrincipal,{kind:'user'}>,admin=markRead('read','admin').principal as typeof owner;
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
const command=():RespondInteractionCommand=>({type:'respond_interaction',operationId:randomUUID(),sessionId,interactionId,action:'accept'});
function proxy(port:CoreStoragePort,execute:(request:StorageCommandEnvelope)=>Promise<CommandResult<CoreCommandName>>):CoreStoragePort{
  return new Proxy(port,{get(target,key){if(key==='execute')return execute;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
}
async function setup(respond:(id:string|number,result:unknown)=>unknown=()=>{},real=false){
  const f=fixture();f.mutate(`DELETE FROM engine_resource_leases;DELETE FROM messages;DELETE FROM sessions;
    INSERT INTO sessions(id,owner_user_id,deleted_at,active_attempt_id,message_revision,engine,engine_session_id,engine_metadata,context_compaction_count,project_id,status)
      VALUES('${sessionId}','owner',NULL,'attempt',0,'codex','thread','{}',0,'project','awaiting_action');
    INSERT INTO engine_resource_leases VALUES('attempt','${sessionId}','lease','running','codex','codex:default',1,1)`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const runtime=createSessionRuntimeState({sessionId,projectId:'project',engine:'codex'});
  Object.assign(runtime,{attemptId:'attempt',engineConnectionId:'connection',leaseToken:'lease',isRunning:true,
    engineConnection:{respondToInteraction:respond} as EngineConnection});
  runtime.pendingInteractions.set(interactionId,{request:{requestId:1,method:'execCommandApproval',params:{command:'synthetic command'}},
    interaction:{id:'interaction:1',requestId:1,kind:'command',snapshot:{title:'synthetic approval'},availableActions:['accept_once','decline'],autoApprovable:true},
    standalone:false,createdAt:1,connectionId:'connection'});
  runtime.turnItems=[createInteractionItem(runtime.pendingInteractions.get(interactionId)!.interaction,'execCommandApproval','connection')];
  const events=real?new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:()=>true,onFailure:()=>{},onTerminalCommitted:()=>{runtime.isRunning=false;}}):undefined;
  let binding:StoredStopBinding|undefined={runtime,version:1,events:events!};
  const adapter:EngineInteractionAdapter={normalize:()=>runtime.pendingInteractions.get(interactionId)!.interaction,buildResponse:(_request,response)=>({decision:response.action})};
  if(!real)await port.registerRuntime({storeId:'store',workerGeneration:1,leaseToken:'lease',runtime:{kind:'runtime',sessionId,attemptId:'attempt',connectionId:'connection',runtimeVersion:1}});
  const services:StoredInteractionResponses[]=[];let projected=0;
  return{f,port,runtime,events,replace:()=>{binding=undefined;},get projected(){return projected;},make:(options:Partial<Options>={},custom:CoreStoragePort=port)=>{
    const service=new StoredInteractionResponses(custom,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},getBinding:()=>binding,getAdapter:()=>adapter,
      submitted:async({guard})=>{guard.assertCurrent();projected++;runtime.pendingInteractions.delete(interactionId);},...options});services.push(service);return service;},
    phase:()=>f.scalar('SELECT phase FROM _relay_interaction_responses'),cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await events?.close().catch(()=>{});await port.close();f.cleanup();}};
}

test('a protocol reply trailing the terminal repairs its saved interaction without reviving the task',async()=>{
  const entered=gate(),release=gate(),p=await setup(async()=>{entered.resolve();await release.promise;},true);
  try{
    const scopedId='interaction:connection:attempt:1',pending=p.runtime.pendingInteractions.get(interactionId)!;
    p.runtime.pendingInteractions.delete(interactionId);p.runtime.pendingInteractions.set(scopedId,pending);
    p.runtime.turnItems=[createInteractionItem(pending.interaction,'execCommandApproval','connection:attempt')];
    const input={...command(),interactionId:scopedId,action:'decline' as const},service=p.make({submitted:createStoredInteractionProjection(p.port,{storeId:'store',generation:1})});
    const response=service.respond(owner,input);await entered.promise;
    await p.events!.route({engineId:'codex',payload:{type:'server_request_resolved',requestId:1},
      meta:{source:'realtime',sequence:1,observedAt:122,externalSessionId:'thread'}},async(event,context)=>{
        await projectStoredRuntimeInteractions(p.runtime,event,context,undefined);
      });
    await p.events!.route({engineId:'codex',payload:{type:'message_complete',turnId:'turn',content:'finished'},
      meta:{source:'realtime',sequence:2,observedAt:123,externalSessionId:'thread',externalTurnId:'turn'}},async(event,context)=>{
        if(event.payload.type==='message_complete')await finishStoredAssistant(p.runtime,event.payload,context,{messageId:'answer',now:123,fileChanges:{}});
      });
    assert.equal(p.runtime.isRunning,false);release.resolve();
    assert.deepEqual(await response,{state:'submitted',projectionPending:false});assert.equal(p.runtime.pendingInteractions.size,0);
    assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='answer'"),'finished');
    const saved=JSON.parse(String(p.f.scalar("SELECT items FROM messages WHERE id='answer'")))[0];
    assert.equal(saved.status,'completed');assert.equal(saved.details.resolvedAction,'decline');assert.equal(saved.details.decisionSource,'user');
    assert.equal(p.f.scalar('SELECT status FROM sessions'),'completed');
  }finally{release.resolve();await p.cleanup();}
});

test('a resolved notification ahead of reply projection cannot poison completion or explicit stop',async()=>{
  for(const terminal of ['completed','stopped'] as const){
    let replies=0,cancels=0;const p=await setup(()=>{replies++;},true);
    let stop:StoredRuntimeStop|undefined;
    try{
      const scopedId='interaction:connection:attempt:1',pending=p.runtime.pendingInteractions.get(interactionId)!;
      p.runtime.pendingInteractions.delete(interactionId);p.runtime.pendingInteractions.set(scopedId,pending);
      p.runtime.turnItems=[createInteractionItem(pending.interaction,'execCommandApproval','connection:attempt')];
      const projection=createStoredInteractionProjection(p.port,{storeId:'store',generation:1});
      const service=p.make({submitted:async args=>{
        // The provider can resolve the request immediately after submission, before
        // the confirmed reply's local projection reaches the runtime queue.
        const resolved=p.events!.route({engineId:'codex',payload:{type:'server_request_resolved',requestId:1},
          meta:{source:'realtime',sequence:1,observedAt:123,externalSessionId:'thread'}},async(event,context)=>{
            await projectStoredRuntimeInteractions(p.runtime,event,context,undefined);
          });
        const projected=projection(args);
        await Promise.all([resolved,projected]);
      }});
      const action=terminal==='completed'?'accept':'decline';
      assert.deepEqual(await service.respond(owner,{...command(),interactionId:scopedId,action}),{state:'submitted',projectionPending:false});
      assert.equal(replies,1);assert.equal(p.phase(),'submitted');
      assert.equal(p.runtime.pendingInteractions.size,0);
      assert.equal((p.runtime.turnItems[0]!.details as Record<string,unknown>).resolvedAction,action);
      assert.equal((p.runtime.turnItems[0]!.details as Record<string,unknown>).decisionSource,'user');
      assert.equal(p.events!.storage.health().failed,false);
      if(terminal==='completed'){
        await p.events!.route({engineId:'codex',payload:{type:'message_complete',turnId:'turn',content:'finished'},
          meta:{source:'realtime',sequence:2,observedAt:124,externalSessionId:'thread',externalTurnId:'turn'}},async(event,context)=>{
            if(event.payload.type==='message_complete')await finishStoredAssistant(p.runtime,event.payload,context,{messageId:'answer',now:124,fileChanges:{}});
          });
        assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='answer'"),'finished');
        assert.equal(JSON.parse(String(p.f.scalar("SELECT items FROM messages WHERE id='answer'")))[0].details.resolvedAction,'accept');
      }else{
        p.runtime.engineConnection!.cancel=async()=>{cancels++;};
        // Stop bindings are stable identities for an attempt.
        const binding={runtime:p.runtime,version:1,events:p.events!};
        stop=new StoredRuntimeStop(p.port,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},getBinding:()=>binding,
          onStopped:async(_binding,context)=>{await context.finishTerminal({id:'answer',turnId:'turn',content:'已停止',items:null,metadata:null,durationMs:1});}});
        assert.deepEqual(await stop.request(owner,{sessionId,expectedAttemptId:'attempt'},randomUUID()),{state:'requested',confirmed:true});
        assert.equal(cancels,1);
      }
      assert.equal(p.f.scalar('SELECT status FROM sessions'),terminal);
      assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
      assert.equal(p.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),1);
    }finally{await stop?.close();await p.cleanup();}
  }
});

test('an unresolved replacement stays projection-pending without poisoning the queue before or after storage',async()=>{
  for(const stage of ['queued','committed'] as const){
    let replies=0,replaced=false;const p=await setup(()=>{replies++;},true);
    try{
      const replacePending=()=>{const pending=p.runtime.pendingInteractions.get(interactionId)!;
        p.runtime.pendingInteractions.set(interactionId,{...pending});replaced=true;};
      const custom=proxy(p.port,async request=>{
        const result=await p.port.execute<CoreCommandName>(request);
        if(stage==='committed'&&!replaced&&request.command.name==='interaction.projectSubmitted'&&result.state==='committed')replacePending();
        return result;
      });
      const projection=createStoredInteractionProjection(custom,{storeId:'store',generation:1});
      const input=command(),service=p.make({submitted:async args=>{
        if(stage==='queued'&&!replaced)replacePending();
        await projection(args);
      }});
      assert.deepEqual(await service.respond(owner,input),{state:'submitted',projectionPending:true});
      assert.equal(p.runtime.pendingInteractions.size,1,'unresolved replacement must remain visible');
      assert.equal(p.events!.storage.health().failed,false);
      assert.equal(p.phase(),'submitted');
      assert.deepEqual(await service.respond(owner,input),{state:'submitted',projectionPending:false});
      assert.equal(p.runtime.pendingInteractions.size,0);
      assert.equal(replies,1,'projection retry must never resend authorization');
    }finally{await p.cleanup();}
  }
});

test('replaying a confirmed response repairs a provider-resolved item without a second engine response',async()=>{
  let replies=0;const p=await setup(()=>{replies++;},true);
  try{
    const scopedId='interaction:connection:attempt:1',pending=p.runtime.pendingInteractions.get(interactionId)!;
    p.runtime.pendingInteractions.delete(interactionId);p.runtime.pendingInteractions.set(scopedId,pending);
    p.runtime.turnItems=[createInteractionItem(pending.interaction,'execCommandApproval','connection:attempt')];
    const input={...command(),interactionId:scopedId,action:'decline' as const};
    const initial=p.make({submitted:async()=>{
      await p.events!.route({engineId:'codex',payload:{type:'server_request_resolved',requestId:1},
        meta:{source:'realtime',sequence:1,observedAt:123,externalSessionId:'thread'}},async(event,context)=>{
          await projectStoredRuntimeInteractions(p.runtime,event,context,undefined);
        });
      throw Error('synthetic interruption before projection');
    }});
    assert.deepEqual(await initial.respond(owner,input),{state:'submitted',projectionPending:true});
    assert.equal(p.runtime.pendingInteractions.size,0);
    const retry=p.make({submitted:createStoredInteractionProjection(p.port,{storeId:'store',generation:1})});
    assert.deepEqual(await retry.respond(owner,{...input,action:'accept'}),{state:'rejected',code:'CONFLICT'});
    assert.deepEqual(await retry.respond(owner,input),{state:'submitted',projectionPending:false});
    assert.equal((p.runtime.turnItems[0]!.details as Record<string,unknown>).resolvedAction,'decline');
    assert.equal(replies,1);
  }finally{await p.cleanup();}
});

test('a real projection write failure still fails closed without resending the known protocol response',async()=>{
  let replies=0;const p=await setup(()=>{replies++;},true);
  try{
    p.f.mutate("CREATE TRIGGER fail_response_projection BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='interaction.projectSubmitted' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const input=command(),service=p.make({submitted:createStoredInteractionProjection(p.port,{storeId:'store',generation:1})});
    assert.deepEqual(await service.respond(owner,input),{state:'submitted',projectionPending:true});
    assert.equal(p.events!.storage.health().failed,true,'storage failure must retain the authoritative queue fence');
    assert.equal(p.runtime.pendingInteractions.size,1);assert.equal(p.phase(),'submitted');
    assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    assert.deepEqual(await service.respond(owner,input),{state:'submitted',projectionPending:true});
    assert.equal(replies,1);
  }finally{await p.cleanup();}
});

test('an actual protocol response follows Native intent and submission confirmation precedes projection',async()=>{
  let replies=0;const p=await setup((id,result)=>{replies++;assert.equal(id,1);assert.deepEqual(result,{decision:'accept_once'});assert.equal(Object.isFrozen(result),true);assert.equal(p.phase(),'prepared');});try{
    const input=command(),service=p.make();assert.deepEqual(await service.respond(admin,input),{state:'submitted',projectionPending:false});assert.equal(replies,1);assert.equal(p.phase(),'submitted');assert.equal(p.projected,1);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);assert.deepEqual(await service.respond(admin,input),{state:'submitted',projectionPending:false});assert.equal(replies,1);
    assert.equal(String(p.f.scalar('SELECT job_json FROM _relay_interaction_responses')).includes('synthetic command'),false);
  }finally{await p.cleanup();}
});

test('identical multi-device requests coalesce while a conflicting choice cannot overwrite the operation',async()=>{
  const entered=gate(),release=gate();let replies=0;const p=await setup(()=>{replies++;});try{const input=command(),service=p.make({prepared:async()=>{entered.resolve();await release.promise;}}),first=service.respond(owner,input);await entered.promise;
    assert.equal(p.make().respond(owner,input),first);assert.deepEqual(await service.respond(owner,{...input,action:'decline'}),{state:'rejected',code:'CONFLICT'});release.resolve();assert.equal((await first).state,'submitted');assert.equal(replies,1);
  }finally{release.resolve();await p.cleanup();}
});

test('unknown Native preparation never sends a protocol reply on either a live retry or another coordinator',async()=>{
  let replies=0;const p=await setup(()=>{replies++;});try{const custom=proxy(p.port,async(request)=>{const result=await p.port.execute<CoreCommandName>(request);if(request.command.name==='interaction.prepareResponse'&&result.state==='committed'&&!result.replayed)return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};return result;});
    const input=command();assert.deepEqual(await p.make({},custom).respond(owner,input),{state:'unknown'});assert.deepEqual(await p.make().respond(owner,input),{state:'unknown'});assert.equal(replies,0);assert.equal(p.phase(),'prepared');
  }finally{await p.cleanup();}
});

test('an ambiguous protocol send retains the pending request and cannot be repeated with a new operation key',async()=>{
  let replies=0;const p=await setup(()=>{replies++;throw Error('ambiguous protocol submission');});try{const input=command(),service=p.make();assert.deepEqual(await service.respond(owner,input),{state:'unknown'});assert.deepEqual(await service.respond(owner,input),{state:'unknown'});
    assert.equal((await service.respond(owner,{...input,operationId:randomUUID()})).state,'rejected');assert.equal(replies,1);assert.equal(p.phase(),'prepared');assert.equal(p.runtime.pendingInteractions.has(interactionId),true);
  }finally{await p.cleanup();}
});

test('pending replacement, request mutation, registry replacement, expiry and explicit stop fence the old reply',async()=>{
  for(const change of ['pending','params','registry','expiry','stop']){let replies=0;const p=await setup(()=>{replies++;});try{
    const service=p.make({prepared:async()=>{const pending=p.runtime.pendingInteractions.get(interactionId)!;
      if(change==='pending')p.runtime.pendingInteractions.set(interactionId,{...pending});else if(change==='params')pending.request.params.command='changed';else if(change==='registry')p.replace();
      else if(change==='expiry')p.f.mutate("UPDATE auth_sessions SET expires_at=1 WHERE user_id='owner'");else await p.port.execute({...markRead(),operationId:'stop',command:{name:'turn.requestStop',input:{sessionId,expectedAttemptId:'attempt'}}});
    }});assert.deepEqual(await service.respond(owner,command()),{state:'rejected',code:'NOT_SUBMITTED'});assert.equal(replies,0);assert.equal(p.phase(),'rejected');
  }finally{await p.cleanup();}}
});

test('permission loss after a known submission preserves the transport fact and denies result access',async()=>{
  let replies=0;const p=await setup(()=>{replies++;p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");});try{
    assert.deepEqual(await p.make().respond(owner,command()),{state:'access-denied'});assert.equal(replies,1);assert.equal(p.phase(),'submitted');
  }finally{await p.cleanup();}
});

test('a failed Native confirmation is unknown and a later user retry does not resend the already written protocol response',async()=>{
  let replies=0;const p=await setup(()=>{replies++;});try{p.f.mutate("CREATE TRIGGER fail_response_confirmation BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='interaction.confirmResponse' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const input=command(),service=p.make();assert.deepEqual(await service.respond(owner,input),{state:'unknown'});assert.equal(p.phase(),'prepared');p.f.mutate('DROP TRIGGER fail_response_confirmation');assert.deepEqual(await service.respond(owner,input),{state:'unknown'});assert.equal(replies,1);
  }finally{await p.cleanup();}
});

test('known submission survives a failed projection and a later projection retry never resends',async()=>{
  let replies=0;const p=await setup(()=>{replies++;});try{const input=command();assert.deepEqual(await p.make({submitted:async()=>{throw Error('projection unavailable');}}).respond(owner,input),{state:'submitted',projectionPending:true});
    assert.deepEqual(await p.make().respond(owner,input),{state:'submitted',projectionPending:false});assert.equal(replies,1);assert.equal(p.projected,1);
  }finally{await p.cleanup();}
});

test('shutdown before Native preparation dispatch leaves no new response intent',async()=>{
  const entered=gate(),release=gate(),p=await setup();try{const service=p.make({assertExclusiveWriter:async()=>{entered.resolve();await release.promise;}}),run=service.respond(owner,command());await entered.promise;const closing=service.close();release.resolve();assert.equal((await run).state,'rejected');await closing;
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_interaction_responses'),0);
  }finally{release.resolve();await p.cleanup();}
});

test('shutdown drains an already started protocol promise and its Native submission before releasing ownership',async()=>{
  const entered=gate(),release=gate(),p=await setup(async()=>{entered.resolve();await release.promise;});try{const service=p.make(),run=service.respond(owner,command());await entered.promise;let closed=false;const closing=service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
    release.resolve();assert.deepEqual(await run,{state:'submitted',projectionPending:false});await closing;assert.equal(p.phase(),'submitted');
  }finally{release.resolve();await p.cleanup();}
});

test('standalone requests and actions absent from the normalized capability list are explicitly refused',async()=>{
  const p=await setup();try{const pending=p.runtime.pendingInteractions.get(interactionId)!;pending.standalone=true;assert.deepEqual(await p.make().respond(owner,command()),{state:'rejected',code:'NOT_SUPPORTED'});
    pending.standalone=false;assert.deepEqual(await p.make().respond(owner,{...command(),action:'accept_for_session'}),{state:'rejected',code:'INVALID_ARGUMENT'});assert.equal(p.f.scalar('SELECT count(*) FROM _relay_interaction_responses'),0);
  }finally{await p.cleanup();}
});

test('known pre-send rejection keeps the old operation negative while allowing a new valid response',async()=>{
  let replies=0;const p=await setup(()=>{replies++;});try{const input=command(),first=p.make({prepared:async()=>{p.runtime.pendingInteractions.get(interactionId)!.request.params.command='new pending content';}});
    assert.deepEqual(await first.respond(owner,input),{state:'rejected',code:'NOT_SUBMITTED'});assert.equal(p.phase(),'rejected');
    assert.deepEqual(await p.make().respond(owner,{...input,operationId:randomUUID()}),{state:'submitted',projectionPending:false});
    assert.deepEqual(await p.make().respond(owner,input),{state:'rejected',code:'NOT_SUBMITTED'});assert.equal(replies,1);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_interaction_responses'),2);
  }finally{await p.cleanup();}
});

test('a revoked admin response that never reached the method records only a failed final audit',async()=>{
  let replies=0;const p=await setup(()=>{replies++;});try{const service=p.make({prepared:async()=>{p.f.mutate("UPDATE auth_sessions SET expires_at=1 WHERE user_id='admin'");}});
    assert.deepEqual(await service.respond(admin,command()),{state:'rejected',code:'NOT_SUBMITTED'});assert.equal(replies,0);assert.equal(p.phase(),'rejected');
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='started'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),0);
  }finally{await p.cleanup();}
});

test('failure to commit a negative result preserves the prepared fence and remains unknown',async()=>{
  let replies=0;const p=await setup(()=>{replies++;});try{const service=p.make({prepared:async()=>{p.runtime.pendingInteractions.get(interactionId)!.request.params.command='changed';
    p.f.mutate("CREATE TRIGGER fail_response_reject BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='interaction.rejectUnsubmitted' BEGIN SELECT RAISE(ABORT,'synthetic'); END");}});
    assert.deepEqual(await service.respond(owner,command()),{state:'unknown'});assert.equal(replies,0);assert.equal(p.phase(),'prepared');await assert.rejects(p.port.readUploadScope({principal:owner,projectId:'project'}),{code:'CONFLICT'});
  }finally{await p.cleanup();}
});

test('shutdown after fresh preparation rejects only its own known uninvoked response and drains the negative write',async()=>{
  const entered=gate(),release=gate();let replies=0;const p=await setup(()=>{replies++;});try{const service=p.make({prepared:async()=>{entered.resolve();await release.promise;}}),run=service.respond(owner,command());await entered.promise;
    const closing=service.close();release.resolve();assert.deepEqual(await run,{state:'rejected',code:'NOT_SUBMITTED'});await closing;assert.equal(replies,0);assert.equal(p.phase(),'rejected');
  }finally{release.resolve();await p.cleanup();}
});
