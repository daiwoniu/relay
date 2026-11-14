import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectFileActivities } from './project-file-activities.js';
import type { UploadReadScope } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
const guard=async()=>{};
const reservation=()=>({uploadId:randomUUID(),messageId:randomUUID(),size:50});
async function prepared(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-file-owner-')),projectPath=path.join(root,'project');await fs.mkdir(projectPath);
  const owners=[new ProjectFileActivities(),new ProjectFileActivities()];
  const scope:UploadReadScope={projectId:randomUUID(),projectPath,ownerUserId:randomUUID(),viewerUserId:randomUUID(),viewerRole:'admin',active:false,revision:'synthetic'};
  return{root,scope,a:owners[0]!,b:owners[1]!,cleanup:async()=>{await Promise.all(owners.map(owner=>owner.close()));await fs.rm(root,{recursive:true,force:true});}};
}

test('file activity snapshots share real roots and preserve reservations until physical work settles',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const before=await p.a.snapshot(p.scope),item=reservation(),run=p.a.withUpload(p.scope,item,guard,async()=>{entered.resolve();await release.promise;return'complete';});await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);
    const alias={...p.scope,projectPath:path.join(p.scope.projectPath,'.')},during=await p.b.snapshot(alias);assert.deepEqual(during.reservations,[item]);assert.notEqual(during.version,before.version);assert.deepEqual(await fs.readdir(p.scope.projectPath),[]);release.resolve();assert.equal(await run,'complete');const after=await p.b.snapshot(alias);assert.deepEqual(after.reservations,[]);assert.notEqual(after.version,during.version);
  }finally{release.resolve();await p.cleanup();}
});

test('mutations are serialized across owner instances and snapshot reads cannot observe a publication in progress',async()=>{
  const p=await prepared(),entered=gate(),release=gate(),events:string[]=[];try{const first=p.a.withMutation(p.scope,guard,async()=>{events.push('first');entered.resolve();await release.promise;events.push('first-done');});await Promise.race([entered.promise,first.then(()=>assert.fail('not entered'))]);const second=p.b.withMutation(p.scope,guard,async()=>{events.push('second');});await assert.rejects(p.b.snapshot(p.scope),{code:'CONFLICT'});assert.deepEqual(events,['first']);release.resolve();await Promise.all([first,second]);assert.deepEqual(events,['first','first-done','second']);assert.deepEqual((await p.a.snapshot(p.scope)).reservations,[]);
  }finally{release.resolve();await p.cleanup();}
});

test('upload publication holds its reservation, excludes destructive work and rejects escaped capabilities',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{let escaped!:(action:(signal:AbortSignal)=>Promise<void>)=>Promise<void>;const item=reservation(),run=p.a.withUpload(p.scope,item,guard,async(capability)=>{
    escaped=capability.publish;entered.resolve();await release.promise;await capability.publish(async(signal)=>{assert.equal(signal.aborted,false);});
  });await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);await assert.rejects(p.b.withMutation(p.scope,guard,async()=>assert.fail('destructive operation entered')),{code:'CONFLICT'});assert.equal((await p.b.snapshot(p.scope)).reservations.length,1);release.resolve();await run;await assert.rejects(escaped(async()=>assert.fail('escaped publication')),{code:'NOT_SUBMITTED'});
  }finally{release.resolve();await p.cleanup();}
});

test('upload slots are bounded across instances and duplicate upload identities cannot reserve twice',async()=>{
  const p=await prepared(),entered=gate(),both=gate(),release=gate();try{const item=reservation(),first=p.a.withUpload(p.scope,item,guard,async()=>{entered.resolve();await release.promise;});await Promise.race([entered.promise,first.then(()=>assert.fail('not entered'))]);await assert.rejects(p.b.withUpload(p.scope,item,guard,async()=>assert.fail('duplicate')),{code:'CONFLICT'});
    const second=p.b.withUpload(p.scope,reservation(),guard,async()=>{both.resolve();await release.promise;});await Promise.race([both.promise,second.then(()=>assert.fail('not entered'))]);await assert.rejects(p.a.withUpload(p.scope,reservation(),guard,async()=>assert.fail('third slot')),{code:'OVERLOADED'});assert.equal((await p.a.snapshot(p.scope)).reservations.length,2);release.resolve();await Promise.all([first,second]);
  }finally{release.resolve();await p.cleanup();}
});

test('global mutation admission remains bounded even for different project roots',async()=>{
  const p=await prepared(),one=gate(),two=gate(),release=gate();try{const secondPath=path.join(p.root,'second'),thirdPath=path.join(p.root,'third');await fs.mkdir(secondPath);await fs.mkdir(thirdPath);
    const first=p.a.withMutation(p.scope,guard,async()=>{one.resolve();await release.promise;}),second=p.b.withMutation({...p.scope,projectPath:secondPath},guard,async()=>{two.resolve();await release.promise;});await Promise.all([one.promise,two.promise]);await assert.rejects(p.a.withMutation({...p.scope,projectPath:thirdPath},guard,async()=>assert.fail('third mutation')),{code:'OVERLOADED'});release.resolve();await Promise.all([first,second]);
  }finally{release.resolve();await p.cleanup();}
});

test('current authority is checked after receiving upload bytes and before publication',async()=>{
  const p=await prepared();let allowed=true,publications=0;try{const current=async()=>{if(!allowed)throw new StorageContractError('FORBIDDEN');};await assert.rejects(p.a.withUpload(p.scope,reservation(),current,async({publish})=>{allowed=false;await publish(async()=>{publications++;});}),{code:'FORBIDDEN'});assert.equal(publications,0);assert.deepEqual((await p.b.snapshot(p.scope)).reservations,[]);}finally{await p.cleanup();}
});

test('unawaited failed publications are drained and cannot turn the enclosing upload into success',async()=>{
  const p=await prepared();try{await assert.rejects(p.a.withUpload(p.scope,reservation(),guard,async({publish})=>{void publish(async()=>{throw new StorageContractError('CONFLICT');});return'should-not-succeed';}),{code:'CONFLICT'});assert.deepEqual((await p.b.snapshot(p.scope)).reservations,[]);}finally{await p.cleanup();}
});

test('shutdown aborts accepted work, drains physical completion and prevents queued mutations',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{let signal!:AbortSignal,secondCalls=0;const first=p.a.withMutation(p.scope,guard,async(value)=>{signal=value;entered.resolve();await release.promise;});await Promise.race([entered.promise,first.then(()=>assert.fail('not entered'))]);const second=p.a.withMutation(p.scope,guard,async()=>{secondCalls++;});const closing=p.a.close();assert.equal(signal.aborted,true);await assert.rejects(p.a.withMutation(p.scope,guard,async()=>assert.fail('closed')),{code:'NOT_SUBMITTED'});release.resolve();await first;await assert.rejects(second,{code:'NOT_SUBMITTED'});await closing;assert.equal(secondCalls,0);await p.b.withMutation(p.scope,guard,async()=>{});
  }finally{release.resolve();await p.cleanup();}
});

test('a replaced physical directory is rejected after current authority checks',async()=>{
  const p=await prepared();let calls=0,mutated=false;try{await assert.rejects(p.a.withMutation(p.scope,async()=>{if(++calls===2){await fs.rename(p.scope.projectPath,p.scope.projectPath+'.old');await fs.mkdir(p.scope.projectPath);}},async()=>{mutated=true;}),{code:'CONFLICT'});assert.equal(mutated,false);}finally{await p.cleanup();}
});
