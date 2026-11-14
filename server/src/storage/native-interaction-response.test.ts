import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs,CoreCommandName,StorageCommandEnvelope,StoragePrincipal } from './contracts.js';
const runtime={kind:'runtime',sessionId:'session',attemptId:'attempt',connectionId:'connection',runtimeVersion:1} as const;
const principal=(id='owner')=>markRead('read',id).principal as Extract<StoragePrincipal,{kind:'user'}>;
const maintenance={kind:'system',purpose:'maintenance'} as const;
const input={sessionId:'session',attemptId:'attempt',connectionId:'connection',runtimeVersion:1,interactionId:'interaction',requestDigest:'a'.repeat(64),responseDigest:'b'.repeat(64),claimToken:'private-claim'};
function command<K extends CoreCommandName>(operationId:string,name:K,body:CoreCommandInputs[K],actor:StoragePrincipal=principal()){
  return{...markRead(),operationId,principal:actor,command:{name,input:body}} as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}};
}
const prepare=(id='respond',actor='owner')=>command(id,'interaction.prepareResponse',input,principal(actor));
const confirm=()=>command('confirm','interaction.confirmResponse',{jobId:'respond',claimToken:input.claimToken,requestDigest:input.requestDigest,responseDigest:input.responseDigest},maintenance);
async function setup(){const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  await port.registerRuntime({storeId:'store',workerGeneration:1,leaseToken:'lease',runtime});
  return{f,port,read:(actor:StoragePrincipal=maintenance)=>port.readInteractionResponseJob({principal:actor,jobId:'respond'}),
    check:(actor='owner')=>port.checkInteractionDispatch({principal:principal(actor),jobId:'respond',claimToken:input.claimToken}),cleanup:async()=>{await port.close();f.cleanup();}};
}

test('interaction intent and current dispatch guard preserve only bounded identity/digests',async()=>{
  const p=await setup();try{const result=await p.port.execute(prepare());assert.equal(result.state,'committed');assert.equal((await p.read())!.phase,'prepared');assert.equal(await p.check(),true);
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_interaction_responses'),1);assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'),0);
    const json=String(p.f.scalar('SELECT job_json FROM _relay_interaction_responses'));assert.equal(json.includes('answers'),false);assert.equal(json.includes('params'),false);
    const replay=await p.port.execute(prepare());assert.equal(replay.state,'committed');if(replay.state==='committed')assert.equal(replay.replayed,true);
  }finally{await p.cleanup();}
});

test('another operation cannot claim the same pending interaction or overwrite its chosen response',async()=>{
  const p=await setup();try{await p.port.execute(prepare());assert.equal((await p.port.execute(prepare('second'))).state,'rejected');assert.equal((await p.port.execute(command('third','interaction.prepareResponse',{...input,responseDigest:'c'.repeat(64)}))).state,'rejected');
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_interaction_responses'),1);assert.equal((await p.read())!.responseDigest,input.responseDigest);
  }finally{await p.cleanup();}
});

test('stopping intent prevents a new approval even if a late projection reset session status',async()=>{
  const p=await setup();try{await p.port.execute(command('stop','turn.requestStop',{sessionId:'session',expectedAttemptId:'attempt'}));p.f.mutate("UPDATE sessions SET status='processing'");assert.equal((await p.port.execute(prepare())).state,'rejected');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_interaction_responses'),0);
  }finally{await p.cleanup();}
});

test('revocation, owner change and a different registered runtime invalidate prepared dispatch',async()=>{
  for(const change of ['expiry','demotion','owner','runtime']){const p=await setup();try{await p.port.execute(prepare('respond','admin'));
    if(change==='expiry')p.f.mutate("UPDATE auth_sessions SET expires_at=1 WHERE user_id='admin'");else if(change==='demotion')p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");else if(change==='owner')p.f.mutate("UPDATE sessions SET owner_user_id='other'");else await p.port.registerRuntime({storeId:'store',workerGeneration:1,leaseToken:'lease',runtime:{...runtime,runtimeVersion:2,connectionId:'new'}});
    let allowed=false;try{allowed=await p.check('admin');}catch{}assert.equal(allowed,false);assert.equal((await p.read())!.phase,'prepared');
  }finally{await p.cleanup();}}
});

test('a missing receipt rolls back both interaction intent and admin start audit',async()=>{
  const p=await setup();try{p.f.mutate("CREATE TRIGGER fail_interaction BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='interaction.prepareResponse' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.equal((await p.port.execute(prepare('respond','admin'))).state,'unknown');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_interaction_responses'),0);assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'),0);
  }finally{await p.cleanup();}
});

test('maintenance can only confirm an exact known transport result and cannot prepare new responses',async()=>{
  const p=await setup();try{await p.port.execute(prepare());await assert.rejects(p.port.execute(command('forbidden','interaction.prepareResponse',input,maintenance)),{code:'FORBIDDEN'});
    await assert.rejects(p.port.execute({...confirm(),principal:principal()}),{code:'FORBIDDEN'});
    assert.equal((await p.port.execute(command('bad-proof','interaction.confirmResponse',{...confirm().command.input,responseDigest:'0'.repeat(64)},maintenance))).state,'rejected');
    assert.equal((await p.read())!.phase,'prepared');assert.equal((await p.port.execute(confirm())).state,'committed');assert.equal((await p.read())!.phase,'submitted');assert.equal(await p.check(),false);
  }finally{await p.cleanup();}
});

test('submission phase, successful admin audit and confirm receipt share one atomic transaction',async()=>{
  const p=await setup();try{await p.port.execute(prepare('respond','admin'));assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='started'"),1);
    p.f.mutate("CREATE TRIGGER fail_response_audit BEFORE INSERT ON admin_audit_events WHEN NEW.result='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.equal((await p.port.execute(confirm())).state,'unknown');assert.equal((await p.read())!.phase,'prepared');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),0);
    p.f.mutate('DROP TRIGGER fail_response_audit');assert.equal((await p.port.execute(confirm())).state,'committed');assert.equal((await p.port.execute(confirm())).state,'committed');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);
  }finally{await p.cleanup();}
});

test('known transport confirmation remains safe after runtime retirement and user session expiry',async()=>{
  const p=await setup();try{await p.port.execute(prepare('respond','admin'));await p.port.retireRuntime({storeId:'store',workerGeneration:1,runtime});p.f.mutate('UPDATE auth_sessions SET expires_at=1');
    assert.equal((await p.port.execute(confirm())).state,'committed');assert.equal((await p.read())!.phase,'submitted');await assert.rejects(p.read(principal('admin')),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});

test('an unconfirmed reply fences new work and file lifecycle but permits read receipts and explicit stop',async()=>{
  const p=await setup();try{await p.port.execute(prepare());
    await assert.rejects(p.port.readUploadScope({principal:principal(),projectId:'project'}),{code:'CONFLICT'});
    assert.equal((await p.port.execute(command('metadata','project.update',{projectId:'project',changes:{name:'changed'}}))).state,'rejected');
    assert.equal((await p.port.execute(command('new-turn','turn.enqueue',{sessionId:'new-draft',attemptId:'new-attempt',messageId:'new-message',engineId:'codex',resourceKey:'codex:default',content:'new',metadata:null,expectedPreferencesRevision:0,
      origin:{kind:'direct'},draft:{projectId:'project',title:'new',titleManuallySet:false}}))).state,'rejected');
    assert.equal(p.f.scalar("SELECT count(*) FROM sessions WHERE id='new-draft'"),0);
    assert.equal((await p.port.execute({...markRead(),operationId:'mark-read'})).state,'committed');
    assert.equal((await p.port.execute(command('explicit-stop','turn.requestStop',{sessionId:'session',expectedAttemptId:'attempt'}))).state,'committed');
    assert.equal((await p.port.execute(confirm())).state,'committed');assert.equal((await p.port.readUploadScope({principal:principal(),projectId:'project'})).active,true);
  }finally{await p.cleanup();}
});

test('a proven unsubmitted reply is rejected once, releases its slot and records a failed admin audit',async()=>{
  const p=await setup();try{await p.port.execute(prepare('respond','admin'));const reject=command('reject','interaction.rejectUnsubmitted',confirm().command.input,maintenance);
    assert.equal((await p.port.execute(reject)).state,'committed');assert.equal((await p.read())!.phase,'rejected');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"),1);
    assert.equal((await p.port.execute(reject)).state,'committed');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"),1);
    assert.equal((await p.port.execute(confirm())).state,'rejected');assert.equal((await p.port.execute(prepare('second','admin'))).state,'committed');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_interaction_responses'),2);
  }finally{await p.cleanup();}
});

test('a submitted response cannot be rejected or freed for a second protocol send',async()=>{
  const p=await setup();try{await p.port.execute(prepare('respond','admin'));await p.port.execute(confirm());
    assert.equal((await p.port.execute(command('late-reject','interaction.rejectUnsubmitted',confirm().command.input,maintenance))).state,'rejected');assert.equal((await p.read())!.phase,'submitted');assert.equal((await p.port.execute(prepare('second','admin'))).state,'rejected');
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);
  }finally{await p.cleanup();}
});
