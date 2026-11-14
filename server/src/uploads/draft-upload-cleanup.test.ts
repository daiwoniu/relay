import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DraftUploadCleanup } from './draft-upload-cleanup.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { readUploadSnapshot } from './read-upload-snapshot.js';
async function prepared(seed=true,uppercase=false){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-draft-cleanup-')),messageId=uppercase?randomUUID().toUpperCase():randomUUID(),request={version:1 as const,jobId:randomUUID(),userId:randomUUID(),projectId:randomUUID(),uploadId:randomUUID()},directory=path.join(root,'.relay_upload','tmp',messageId),job=path.join(root,'.relay_upload','.cleanup',request.jobId),manifestPath=path.join(directory,'manifest.json'),payload=path.join(directory,'synthetic.txt');
  const manifest={version:2,messageId,projectId:request.projectId,userId:request.userId,createdAt:1,updatedAt:1,customField:'preserved',attachments:[{uploadId:uppercase?request.uploadId.toUpperCase():request.uploadId,attachmentId:randomUUID(),name:'synthetic.txt',storedName:'synthetic.txt',size:5,mimeType:'text/plain',createdAt:1,custom:'preserved'}]};
  const populate=async()=>{await fs.mkdir(directory,{recursive:true});await fs.writeFile(manifestPath,JSON.stringify(manifest));await fs.writeFile(payload,'hello');};if(seed)await populate();
  const cleaner=new DraftUploadCleanup(root),run=(guard:()=>Promise<void>=async()=>{})=>cleaner.run(request,guard);
  const usage=()=>readUploadSnapshot({projectId:request.projectId,projectPath:root,ownerUserId:request.userId,viewerUserId:request.userId,viewerRole:'member',active:false,revision:'test'},{version:'test',reservations:[]});
  return{root,request,directory,manifestPath,payload,manifest,job,cleaner,run,populate,usage,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}

test('exact draft cleanup preserves unrelated files and immutable replay evidence',async()=>{
  const p=await prepared();try{await fs.writeFile(path.join(p.directory,'unmanaged.txt'),'keep');assert.deepEqual(await p.run(),{deletedCount:1});await assert.rejects(fs.stat(p.payload),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(p.directory,'unmanaged.txt'),'utf8'),'keep');const manifest=JSON.parse(await fs.readFile(p.manifestPath,'utf8'));assert.deepEqual(manifest.attachments,[]);assert.equal(manifest.customField,'preserved');assert.equal((await p.usage()).usage.usedBytes,4);assert.deepEqual(await p.run(),{deletedCount:1});assert.deepEqual((await fs.readdir(p.job)).sort(),['complete.json','request.json']);}finally{await p.cleanup();}
});

test('legacy uppercase upload and message UUIDs remain addressable without renaming directories',async()=>{
  const p=await prepared(true,true);try{assert.deepEqual(await p.run(),{deletedCount:1});assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')).attachments,[]);await assert.rejects(fs.stat(p.payload),{code:'ENOENT'});}finally{await p.cleanup();}
});

test('an interrupted quarantine retains quota and resumes without restoring an old reference',async()=>{
  const p=await prepared();try{let interrupted=false;await assert.rejects(p.run(async()=>{try{await fs.stat(path.join(p.job,'payload'));interrupted=true;throw new StorageContractError('FORBIDDEN');}catch(error){if(error instanceof StorageContractError)throw error;}}),{code:'FORBIDDEN'});assert.equal(interrupted,true);assert.equal((await p.usage()).usage.usedBytes,5);assert.equal(JSON.parse(await fs.readFile(p.manifestPath,'utf8')).attachments.length,1);assert.deepEqual(await p.run(),{deletedCount:1});assert.equal((await p.usage()).usage.usedBytes,0);}finally{await p.cleanup();}
});

test('a newly changed manifest is preserved instead of overwritten by an old cleanup plan',async()=>{
  const p=await prepared();try{let changed=false;await assert.rejects(p.run(async()=>{if(!changed){try{await fs.stat(path.join(p.job,'request.json'));changed=true;await fs.writeFile(p.manifestPath,JSON.stringify({...p.manifest,customField:'newer'}));}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='ENOENT')throw error;}}}),{code:'CONFLICT'});assert.equal(await fs.readFile(p.payload,'utf8'),'hello');assert.equal(JSON.parse(await fs.readFile(p.manifestPath,'utf8')).customField,'newer');}finally{await p.cleanup();}
});

test('recovery after manifest publication preserves later entries even when the filename is reused',async()=>{
  const p=await prepared();try{await assert.rejects(p.run(async()=>{try{const value=JSON.parse(await fs.readFile(p.manifestPath,'utf8'));if(!value.attachments.length){await fs.stat(path.join(p.job,'payload'));throw new StorageContractError('FORBIDDEN');}}catch(error){if(error instanceof StorageContractError)throw error;}}),{code:'FORBIDDEN'});
    const next={...p.manifest,updatedAt:Date.now(),attachments:[{...p.manifest.attachments[0]!,uploadId:randomUUID(),attachmentId:randomUUID()}]};await fs.writeFile(p.manifestPath,JSON.stringify(next));await fs.writeFile(p.payload,'newer');assert.deepEqual(await p.run(),{deletedCount:1});assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')),next);assert.equal(await fs.readFile(p.payload,'utf8'),'newer');assert.equal((await p.usage()).usage.usedBytes,5);
  }finally{await p.cleanup();}
});

test('replacement private bytes are preserved after an interrupted deletion',async()=>{
  const p=await prepared();try{await assert.rejects(p.run(async()=>{try{await fs.stat(path.join(p.job,'payload'));throw new StorageContractError('FORBIDDEN');}catch(error){if(error instanceof StorageContractError)throw error;}}),{code:'FORBIDDEN'});await fs.unlink(path.join(p.job,'payload'));await fs.writeFile(path.join(p.job,'payload'),'other');await assert.rejects(p.run(),{code:'CONFLICT'});assert.equal(await fs.readFile(path.join(p.job,'payload'),'utf8'),'other');assert.equal(JSON.parse(await fs.readFile(p.manifestPath,'utf8')).attachments.length,1);}finally{await p.cleanup();}
});

test('a retained negative receipt cannot delete a draft created later with the same old key',async()=>{
  const p=await prepared(false);try{assert.deepEqual(await p.run(),{deletedCount:0});await p.populate();assert.deepEqual(await p.run(),{deletedCount:0});assert.equal(await fs.readFile(p.payload,'utf8'),'hello');}finally{await p.cleanup();}
});

test('a completed cleanup replay cannot affect newer attachments in the same message directory',async()=>{
  const p=await prepared();try{await p.run();const next={...p.manifest,updatedAt:Date.now(),attachments:[{...p.manifest.attachments[0]!,uploadId:randomUUID(),attachmentId:randomUUID(),storedName:'new.txt',name:'new.txt'}]};await fs.writeFile(p.manifestPath,JSON.stringify(next));await fs.writeFile(path.join(p.directory,'new.txt'),'newer');assert.deepEqual(await p.run(),{deletedCount:1});assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')),next);assert.equal(await fs.readFile(path.join(p.directory,'new.txt'),'utf8'),'newer');}finally{await p.cleanup();}
});

test('foreign ownership, hard links and an aborted initial capability never erase user bytes',async()=>{
  for(const mode of ['owner','link','abort']){const p=await prepared();try{if(mode==='owner')await fs.writeFile(p.manifestPath,JSON.stringify({...p.manifest,userId:randomUUID()}));else if(mode==='link')await fs.link(p.payload,path.join(p.root,'alias.txt'));
    if(mode==='abort')await assert.rejects(p.cleaner.run(p.request,async()=>{},AbortSignal.abort()),{code:'NOT_SUBMITTED'});else await assert.rejects(p.run(),{code:'CONFLICT'});assert.equal(await fs.readFile(p.payload,'utf8'),'hello');await assert.rejects(fs.stat(p.job),{code:'ENOENT'});
  }finally{await p.cleanup();}}
});
