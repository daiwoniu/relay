import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArchivedUploadCleanup } from './archived-upload-cleanup.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { readUploadSnapshot } from './read-upload-snapshot.js';
async function prepared(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-archive-cleanup-')),messageId=randomUUID(),userId=randomUUID(),request={jobId:randomUUID(),projectId:randomUUID(),projectPath:root,ownerUserId:userId,uploaderUserId:userId as string|null,attachmentIds:null as string[]|null};
  const directory=path.join(root,'.relay_upload','messages',messageId),job=path.join(root,'.relay_upload','.cleanup',request.jobId),manifestPath=path.join(directory,'manifest.json');await fs.mkdir(directory,{recursive:true});
  const entry=(name:string,size:number)=>({uploadId:randomUUID(),attachmentId:randomUUID(),name,storedName:name,size,mimeType:'text/plain',createdAt:1,extra:'keep'}),a=entry('first.txt',5),b=entry('second.txt',6),manifest={version:2,messageId,projectId:request.projectId,userId,createdAt:1,updatedAt:1,extra:{keep:true},attachments:[a,b]};
  await fs.writeFile(manifestPath,JSON.stringify(manifest));await fs.writeFile(path.join(directory,a.storedName),'hello');await fs.writeFile(path.join(directory,b.storedName),'second');await fs.writeFile(path.join(directory,'unmanaged.txt'),'xx');request.attachmentIds=[a.attachmentId];
  const state={decision:'unknown' as 'committed'|'rejected'|'unknown',guard:async()=>{}};
  const make=()=>new ArchivedUploadCleanup({assertWriter:async()=>state.guard(),resolveDecision:async()=>state.decision}),run=(action:'prepare'|'reconcile'|'rollback')=>make().run(request,action);
  const privatePath=path.join(job,messageId,a.attachmentId+'.payload'),publicPath=path.join(directory,a.storedName),usage=()=>readUploadSnapshot({projectId:request.projectId,projectPath:root,ownerUserId:userId,viewerUserId:userId,viewerRole:'member',active:false,revision:'test'},{version:'test',reservations:[]});
  return{root,userId,messageId,request,directory,job,manifestPath,manifest,a,b,state,make,run,privatePath,publicPath,usage,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}

test('selected archived files are isolated before Native decision and removed only after known commit',async()=>{
  const p=await prepared();try{const first=await p.run('prepare');assert.equal(first.state,'prepared');assert.equal(first.deletedCount,1);assert.deepEqual(await p.run('prepare'),first);assert.equal(await fs.readFile(p.privatePath,'utf8'),'hello');await assert.rejects(fs.stat(p.publicPath),{code:'ENOENT'});assert.equal((await p.usage()).usage.usedBytes,13);assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')).attachments,[p.b]);
    assert.equal((await p.run('reconcile')).state,'unknown');assert.equal(await fs.readFile(p.privatePath,'utf8'),'hello');p.state.decision='committed';const done=await p.run('reconcile');assert.equal(done.state,'committed');assert.equal(done.intentDigest,first.intentDigest);assert.equal((await p.usage()).usage.usedBytes,8);assert.deepEqual(await p.run('reconcile'),done);assert.equal(await fs.readFile(path.join(p.directory,'unmanaged.txt'),'utf8'),'xx');
  }finally{await p.cleanup();}
});

test('explicit Native rejection restores original bytes and manifest including unknown fields',async()=>{
  const p=await prepared();try{const first=await p.run('prepare');p.state.decision='rejected';const restored=await p.run('rollback');assert.equal(restored.state,'rolled-back');assert.equal(restored.intentDigest,first.intentDigest);assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')),p.manifest);assert.equal(await fs.readFile(p.publicPath,'utf8'),'hello');assert.equal((await p.usage()).usage.usedBytes,13);assert.deepEqual(await p.run('reconcile'),restored);}finally{await p.cleanup();}
});

test('an interruption after moving bytes but before updating metadata can be recovered by rejection',async()=>{
  const p=await prepared();try{p.state.guard=async()=>{try{await fs.stat(p.privatePath);throw new StorageContractError('FORBIDDEN');}catch(error){if(error instanceof StorageContractError)throw error;}};await assert.rejects(p.run('prepare'),{code:'FORBIDDEN'});assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')),p.manifest);p.state.guard=async()=>{};p.state.decision='rejected';assert.equal((await p.run('rollback')).state,'rolled-back');assert.equal(await fs.readFile(p.publicPath,'utf8'),'hello');assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')),p.manifest);}finally{await p.cleanup();}
});

test('unknown decisions and forged commit before a prepared receipt never authorize byte cleanup',async()=>{
  const p=await prepared();try{p.state.guard=async()=>{try{await fs.stat(p.privatePath);throw new StorageContractError('FORBIDDEN');}catch(error){if(error instanceof StorageContractError)throw error;}};await assert.rejects(p.run('prepare'));p.state.guard=async()=>{};assert.equal((await p.run('rollback')).state,'unknown');p.state.decision='committed';assert.equal((await p.run('reconcile')).state,'unknown');assert.equal(await fs.readFile(p.privatePath,'utf8'),'hello');}finally{await p.cleanup();}
});

test('a replacement public file prevents rollback and is never overwritten',async()=>{
  const p=await prepared();try{await p.run('prepare');await fs.writeFile(p.publicPath,'other');p.state.decision='rejected';await assert.rejects(p.run('rollback'),{code:'CONFLICT'});assert.equal(await fs.readFile(p.publicPath,'utf8'),'other');assert.equal(await fs.readFile(p.privatePath,'utf8'),'hello');assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')).attachments,[p.b]);}finally{await p.cleanup();}
});

test('changed private bytes prevent physical cleanup even after a database commit',async()=>{
  const p=await prepared();try{await p.run('prepare');await fs.writeFile(p.privatePath,'other');p.state.decision='committed';await assert.rejects(p.run('reconcile'),{code:'CONFLICT'});assert.equal(await fs.readFile(p.privatePath,'utf8'),'other');assert.equal(await fs.readFile(path.join(p.directory,p.b.storedName),'utf8'),'second');}finally{await p.cleanup();}
});

test('the uploader filter and explicit selection cannot isolate another user or unselected bytes',async()=>{
  const p=await prepared();try{await fs.writeFile(p.manifestPath,JSON.stringify({...p.manifest,userId:randomUUID()}));assert.equal((await p.run('prepare')).deletedCount,0);p.state.decision='committed';assert.equal((await p.run('reconcile')).state,'committed');assert.equal(await fs.readFile(p.publicPath,'utf8'),'hello');assert.equal(await fs.readFile(path.join(p.directory,p.b.storedName),'utf8'),'second');}finally{await p.cleanup();}
});

test('rejection before a file intent existed records an unmoved proof without touching archived data',async()=>{
  const p=await prepared();try{p.state.decision='rejected';const result=await p.run('rollback');assert.equal(result.state,'rolled-back');assert.equal(result.deletedCount,0);assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')),p.manifest);assert.equal(await fs.readFile(p.publicPath,'utf8'),'hello');await assert.rejects(p.run('prepare'),{code:'CONFLICT'});}finally{await p.cleanup();}
});

test('corrupt manifests cannot treat reserved metadata as payload and file aliases are rejected',async()=>{
  for(const mode of ['manifest','link']){const p=await prepared();try{if(mode==='manifest')await fs.writeFile(p.manifestPath,JSON.stringify({...p.manifest,attachments:[{...p.a,storedName:'manifest.json'}]}));else await fs.link(p.publicPath,path.join(p.root,'alias.txt'));await assert.rejects(p.run('prepare'),{code:'CONFLICT'});await assert.rejects(fs.stat(p.job),{code:'ENOENT'});assert.equal(await fs.readFile(p.publicPath,'utf8'),'hello');}finally{await p.cleanup();}}
});

test('authorized admin all-selection still preserves unmanaged bytes and uses retained file proofs',async()=>{
  const p=await prepared();try{p.request.uploaderUserId=null;p.request.attachmentIds=null;await fs.writeFile(p.manifestPath,JSON.stringify({...p.manifest,userId:randomUUID()}));const first=await p.run('prepare');assert.equal(first.deletedCount,2);assert.equal((await p.usage()).usage.usedBytes,13);p.state.decision='committed';assert.equal((await p.run('reconcile')).state,'committed');assert.equal((await p.usage()).usage.usedBytes,2);assert.equal(await fs.readFile(path.join(p.directory,'unmanaged.txt'),'utf8'),'xx');}finally{await p.cleanup();}
});

test('user payload names matching private metadata are encoded as attachment IDs and remain accounted',async()=>{
  const p=await prepared();try{await fs.rename(p.publicPath,path.join(p.directory,'request.json'));await fs.writeFile(p.manifestPath,JSON.stringify({...p.manifest,attachments:[{...p.a,storedName:'request.json',name:'request.json'},p.b]}));await p.run('prepare');assert.equal((await p.usage()).usage.usedBytes,13);assert.equal(await fs.readFile(p.privatePath,'utf8'),'hello');p.state.decision='rejected';assert.equal((await p.run('rollback')).state,'rolled-back');assert.equal(await fs.readFile(path.join(p.directory,'request.json'),'utf8'),'hello');}finally{await p.cleanup();}
});

test('guards distinguish read-only lookup from new intent creation and bind every later write to its digest',async()=>{
  const p=await prepared();try{const controls:Array<{mode:'read'|'write';intentDigest:string|null}>=[],cleaner=new ArchivedUploadCleanup({assertWriter:async(_request,control)=>{controls.push(control);if(control.mode==='write'&&!control.intentDigest)throw new StorageContractError('CONFLICT');},resolveDecision:async()=>p.state.decision});await assert.rejects(cleaner.run(p.request,'prepare'),{code:'CONFLICT'});await assert.rejects(fs.stat(p.job),{code:'ENOENT'});assert.equal(controls[0]!.mode,'read');
    const prepared=await p.run('prepare'),bound=new ArchivedUploadCleanup({assertWriter:async(_request,control)=>{if(control.mode==='write')assert.equal(control.intentDigest,prepared.intentDigest);},resolveDecision:async()=>p.state.decision});assert.equal((await bound.run(p.request,'prepare')).state,'prepared');assert.equal(await fs.readFile(p.privatePath,'utf8'),'hello');
  }finally{await p.cleanup();}
});
