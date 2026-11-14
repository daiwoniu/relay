import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JournaledUploadQuarantine, type QuarantineRequest } from './journaled-quarantine.js';
import { ProjectUploadStore } from './project-uploads.js';

const projectId='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222';
async function exists(p:string){try{await fs.lstat(p);return true;}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT')return false;throw e;}}
async function fixture(count=2){
  const created=await fs.mkdtemp(path.join(os.tmpdir(),'relay-quarantine-journal-')),root=await fs.realpath(created);
  const messages=path.join(root,'.relay_upload','messages');await fs.mkdir(messages,{recursive:true});
  const entries=Array.from({length:count},()=>({messageId:randomUUID(),ownerUserId:owner})).sort((a,b)=>a.messageId.localeCompare(b.messageId));
  for(const entry of entries){const dirname=path.join(messages,entry.messageId);await fs.mkdir(dirname);
    await fs.writeFile(path.join(dirname,'payload.txt'),'synthetic managed data');
    await fs.writeFile(path.join(dirname,'manifest.json'),JSON.stringify({version:2,messageId:entry.messageId,projectId,userId:owner,createdAt:1,updatedAt:1,
      attachments:[{uploadId:randomUUID(),attachmentId:randomUUID(),name:'payload.txt',storedName:'payload.txt',size:22,mimeType:'text/plain',createdAt:1}]}));
  }
  await fs.writeFile(path.join(root,'user-source.txt'),'preserve source');
  const request:QuarantineRequest={operationId:randomUUID(),projectPath:root,projectId,sourceDigest:'a'.repeat(64),entries};
  const operation=path.join(root,'.relay_upload','.trash-quarantine',request.operationId);
  let outcome:'committed'|'rejected'|'unknown'='unknown';
  const instances:JournaledUploadQuarantine[]=[];
  const make=(overrides:Partial<ConstructorParameters<typeof JournaledUploadQuarantine>[0]>={})=>{
    const q=new JournaledUploadQuarantine({assertWriter:async()=>{},resolveDecision:async()=>outcome,...overrides});instances.push(q);return q;};
  return {root,messages,operation,request,entries,make,decide:(value:typeof outcome)=>{outcome=value;},cleanup:async()=>{
    await Promise.all(instances.map(q=>q.close()));const resolved=path.resolve(root);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('relay-quarantine-journal-'));await fs.rm(resolved,{recursive:true,force:true});
  }};
}
test('prepare persists intent before moving archives; independent instances resume the same immutable request',async()=>{
  const f=await fixture();try{
    const result=await f.make().run(f.request,'prepare');assert.equal(result.state,'prepared');assert.match(result.intentDigest!,/^[a-f0-9]{64}$/);
    for(const entry of f.entries){assert.equal(await exists(path.join(f.messages,entry.messageId)),false);assert.equal(await exists(path.join(f.operation,entry.messageId,'payload.txt')),true);}
    assert.equal(await exists(path.join(f.operation,'intent.json')),true);assert.equal(await exists(path.join(f.operation,'prepared.json')),true);
    assert.deepEqual(await f.make().run(f.request,'prepare'),result);
    assert.equal(await fs.readFile(path.join(f.root,'user-source.txt'),'utf8'),'preserve source');
    await assert.rejects(f.make().run({...f.request,sourceDigest:'b'.repeat(64)},'prepare'),{code:'QUARANTINE_CONFLICT'});
  }finally{await f.cleanup();}
});
test('unknown database outcome never rolls back or cleans up a prepared archive',async()=>{
  const f=await fixture();try{
    await f.make().run(f.request,'prepare');assert.equal((await f.make().run(f.request,'reconcile')).state,'unknown');
    assert.equal(await exists(path.join(f.operation,'decision.json')),false);assert.equal(await exists(path.join(f.operation,f.entries[0]!.messageId,'payload.txt')),true);
  }finally{await f.cleanup();}
});
test('known rejection restores original directories and a durable tombstone prevents a later retry from moving them again',async()=>{
  const f=await fixture();try{
    await f.make().run(f.request,'prepare');f.decide('rejected');const result=await f.make().run(f.request,'reconcile');assert.equal(result.state,'rolled-back');
    for(const entry of f.entries)assert.equal(await exists(path.join(f.messages,entry.messageId,'payload.txt')),true);
    assert.deepEqual(await f.make().run(f.request,'prepare'),result);assert.deepEqual(await f.make().run(f.request,'reconcile'),result);
  }finally{await f.cleanup();}
});
test('only confirmed commit permits exact-file cleanup; retries leave any newly created source untouched',async()=>{
  const f=await fixture();try{
    await f.make().run(f.request,'prepare');f.decide('committed');const result=await f.make().run(f.request,'reconcile');assert.equal(result.state,'committed');
    for(const entry of f.entries)assert.equal(await exists(path.join(f.operation,entry.messageId)),false);
    const newSource=path.join(f.messages,f.entries[0]!.messageId);await fs.mkdir(newSource);await fs.writeFile(path.join(newSource,'new.txt'),'new content');
    assert.deepEqual(await f.make().run(f.request,'reconcile'),result);assert.equal(await fs.readFile(path.join(newSource,'new.txt'),'utf8'),'new content');
    assert.equal(await fs.readFile(path.join(f.root,'user-source.txt'),'utf8'),'preserve source');
  }finally{await f.cleanup();}
});
test('interruption after a partial move is resumable and cannot be cleaned up before full preparation',async()=>{
  const f=await fixture();try{
    const broken=f.make({assertWriter:async()=>{if(await exists(path.join(f.operation,f.entries[0]!.messageId)))throw new Error('synthetic interruption');}});
    await assert.rejects(broken.run(f.request,'prepare'),{code:'QUARANTINE_UNCONFIRMED'});
    assert.equal(await exists(path.join(f.operation,f.entries[0]!.messageId)),true);assert.equal(await exists(path.join(f.messages,f.entries[1]!.messageId)),true);
    f.decide('committed');await assert.rejects(f.make().run(f.request,'reconcile'),{code:'QUARANTINE_CONFLICT'});
    assert.equal((await f.make().run(f.request,'prepare')).state,'prepared');assert.equal((await f.make().run(f.request,'reconcile')).state,'committed');
  }finally{await f.cleanup();}
});
test('partial cleanup survives an interrupted writer and resumes without deleting the journal',async()=>{
  const f=await fixture(1);try{
    await f.make().run(f.request,'prepare');f.decide('committed');const dirname=path.join(f.operation,f.entries[0]!.messageId);
    const broken=f.make({assertWriter:async()=>{if(await exists(path.join(f.operation,'decision.json'))&&!await exists(path.join(dirname,'manifest.json')))throw new Error('stop after first unlink');}});
    await assert.rejects(broken.run(f.request,'reconcile'),{code:'QUARANTINE_UNCONFIRMED'});
    assert.equal(await exists(path.join(dirname,'payload.txt')),true);assert.equal((await f.make().run(f.request,'reconcile')).state,'committed');
    assert.equal(await exists(path.join(f.operation,'intent.json')),true);assert.equal(await exists(path.join(f.operation,'done.json')),true);
  }finally{await f.cleanup();}
});
test('partial rollback resumes; occupied original directories are never overwritten',async()=>{
  const f=await fixture();try{
    await f.make().run(f.request,'prepare');f.decide('rejected');const source=path.join(f.messages,f.entries[0]!.messageId);
    await fs.mkdir(source);await fs.writeFile(path.join(source,'new.txt'),'preserve occupant');
    await assert.rejects(f.make().run(f.request,'reconcile'),{code:'QUARANTINE_CONFLICT'});assert.equal(await fs.readFile(path.join(source,'new.txt'),'utf8'),'preserve occupant');
    await fs.unlink(path.join(source,'new.txt'));await fs.rmdir(source);
    const broken=f.make({assertWriter:async()=>{if(await exists(source))throw new Error('stop after rollback move');}});
    await assert.rejects(broken.run(f.request,'reconcile'),{code:'QUARANTINE_UNCONFIRMED'});assert.equal((await f.make().run(f.request,'reconcile')).state,'rolled-back');
  }finally{await f.cleanup();}
});
test('content changes and unexpected files fail closed even after the database committed',async()=>{
  const f=await fixture(1);try{
    await f.make().run(f.request,'prepare');f.decide('committed');const dirname=path.join(f.operation,f.entries[0]!.messageId);
    await fs.writeFile(path.join(dirname,'unexpected.txt'),'preserve unexpected');
    await assert.rejects(f.make().run(f.request,'reconcile'),{code:'QUARANTINE_CONFLICT'});assert.equal(await exists(path.join(dirname,'payload.txt')),true);
    await fs.unlink(path.join(dirname,'unexpected.txt'));await fs.writeFile(path.join(dirname,'payload.txt'),'changed contents!!!!!!');
    await assert.rejects(f.make().run(f.request,'reconcile'),{code:'QUARANTINE_CONFLICT'});assert.equal(await fs.readFile(path.join(dirname,'payload.txt'),'utf8'),'changed contents!!!!!!');
  }finally{await f.cleanup();}
});
test('foreign manifests and missing project roots are rejected before any archive is moved',async()=>{
  const f=await fixture(1);try{
    await assert.rejects(f.make().run({...f.request,projectId:randomUUID()},'prepare'),{code:'QUARANTINE_CONFLICT'});
    assert.equal(await exists(path.join(f.messages,f.entries[0]!.messageId)),true);
    await assert.rejects(f.make().run({...f.request,projectPath:path.join(f.root,'missing')},'prepare'),{code:'QUARANTINE_CONFLICT'});
    await assert.rejects(f.make().run({...f.request,projectPath:'relative'},'prepare'),{code:'QUARANTINE_INVALID'});
    await assert.rejects(f.make().run({...f.request,entries:[f.entries[0]!,f.entries[0]!] },'prepare'),{code:'QUARANTINE_INVALID'});
  }finally{await f.cleanup();}
});
test('message-directory junctions and quarantine-root junctions cannot redirect managed operations',async()=>{
  const f=await fixture(1);try{
    const source=path.join(f.messages,f.entries[0]!.messageId),outside=path.join(f.root,'user-directory');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep.txt'),'preserve');
    const saved=source+'-saved';await fs.rename(source,saved);await fs.symlink(outside,source,process.platform==='win32'?'junction':'dir');
    await assert.rejects(f.make().run(f.request,'prepare'),{code:'QUARANTINE_CONFLICT'});assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'preserve');
    await fs.unlink(source);await fs.rename(saved,source);
    const quarantine=path.dirname(f.operation);await fs.rmdir(f.operation);await fs.rmdir(quarantine);await fs.symlink(outside,quarantine,process.platform==='win32'?'junction':'dir');
    await assert.rejects(f.make().run(f.request,'prepare'),{code:'QUARANTINE_CONFLICT'});assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'preserve');
    await fs.unlink(quarantine);
  }finally{await f.cleanup();}
});
test('a directory replacement invalidates the persisted root identities',async()=>{
  const f=await fixture(1);try{
    await f.make().run(f.request,'prepare');f.decide('committed');const saved=f.messages+'-saved';await fs.rename(f.messages,saved);await fs.mkdir(f.messages);
    await assert.rejects(f.make().run(f.request,'reconcile'),{code:'QUARANTINE_CONFLICT'});assert.equal(await exists(path.join(f.operation,f.entries[0]!.messageId,'payload.txt')),true);
  }finally{await f.cleanup();}
});
test('HTTP deadline retains writer ownership across instances; close waits for accepted work',async()=>{
  const f=await fixture(1);try{
    let release!:()=>void,blocked=true;const gate=new Promise<void>(resolve=>{release=resolve;});
    const q=f.make({timeoutMs:5,assertWriter:async()=>{if(blocked){blocked=false;await gate;}}});
    const keepAlive=setTimeout(()=>release(),1000);
    try{
      assert.equal((await q.run(f.request,'prepare')).state,'unknown');
      await assert.rejects(f.make().run({...f.request,operationId:randomUUID()},'prepare'),{code:'QUARANTINE_OVERLOADED'});
      const joined=f.make().run(f.request,'prepare');let closed=false;const closing=q.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,5));assert.equal(closed,false);
      release();assert.equal((await joined).state,'prepared');await closing;await assert.rejects(q.run(f.request,'prepare'),{code:'QUARANTINE_CLOSED'});
    }finally{clearTimeout(keepAlive);release();}
  }finally{await f.cleanup();}
});
test('missing archives remain absent; a later replacement is never added to the original delete intent',async()=>{
  const f=await fixture(0);try{
    const messageId=randomUUID();f.request.entries.push({messageId,ownerUserId:owner});
    assert.equal((await f.make().run(f.request,'prepare')).state,'prepared');
    const replacement=path.join(f.messages,messageId);await fs.mkdir(replacement);await fs.writeFile(path.join(replacement,'keep.txt'),'new archive');
    f.decide('committed');await assert.rejects(f.make().run(f.request,'reconcile'),{code:'QUARANTINE_CONFLICT'});
    assert.equal(await fs.readFile(path.join(replacement,'keep.txt'),'utf8'),'new archive');
  }finally{await f.cleanup();}
});
test('database resolution receives the exact disk proof and conflicting decisions never change settled files',async()=>{
  const f=await fixture(1);try{
    const prepared=await f.make().run(f.request,'prepare');
    const q=f.make({resolveDecision:async(request,intentDigest)=>{assert.equal(request.operationId,f.request.operationId);assert.equal(intentDigest,prepared.intentDigest);return 'committed';}});
    assert.equal((await q.run(f.request,'reconcile')).state,'committed');
    assert.equal((await f.make().run(f.request,'reconcile')).state,'unknown');
    f.decide('rejected');await assert.rejects(f.make().run(f.request,'reconcile'),{code:'QUARANTINE_CONFLICT'});
    assert.equal(await exists(path.join(f.operation,f.entries[0]!.messageId)),false);
  }finally{await f.cleanup();}
});
test('revoked writer fencing stops before the first move and does not erase the recovery intent',async()=>{
  const f=await fixture(1);try{
    const q=f.make({assertWriter:async()=>{if(await exists(path.join(f.operation,'intent.json')))throw new Error('writer revoked');}});
    await assert.rejects(q.run(f.request,'prepare'),{code:'QUARANTINE_UNCONFIRMED'});
    assert.equal(await exists(path.join(f.messages,f.entries[0]!.messageId,'payload.txt')),true);
    assert.equal(await exists(path.join(f.operation,'intent.json')),true);assert.equal((await f.make().run(f.request,'prepare')).state,'prepared');
  }finally{await f.cleanup();}
});
test('real upload-store archives retain original filenames and restore without changing their manifests',async()=>{
  const f=await fixture(0);try{
    const store=new ProjectUploadStore(),messageId=randomUUID();f.request.entries.push({messageId,ownerUserId:owner});
    const draft=await store.writeUpload({projectId,projectPath:f.root,userId:owner,messageId,uploadId:randomUUID(),name:'报告.txt',mimeType:'text/plain',declaredSize:4,
      body:(async function*(){yield Buffer.from('DATA');})()});
    const archived=store.prepareArchive({projectPath:f.root,projectId,userId:owner,messageId,drafts:[draft]});
    const manifest=await fs.readFile(path.join(f.messages,messageId,'manifest.json'),'utf8');
    assert.equal((await f.make().run(f.request,'prepare')).state,'prepared');
    f.decide('rejected');assert.equal((await f.make().run(f.request,'reconcile')).state,'rolled-back');
    assert.equal(await fs.readFile(archived.attachments[0]!.path,'utf8'),'DATA');assert.equal(await fs.readFile(path.join(f.messages,messageId,'manifest.json'),'utf8'),manifest);
  }finally{await f.cleanup();}
});
