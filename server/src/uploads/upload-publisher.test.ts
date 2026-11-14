import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IncomingUploadJournal } from './incoming-upload-journal.js';
import type { IncomingUploadRequest } from './incoming-upload-contract.js';
import { UploadPublisher } from './upload-publisher.js';
import { ProjectFileActivities } from './project-file-activities.js';
import type { UploadReadScope } from '../storage/contracts.js';
const stream=(value:string)=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.from(value));controller.close();}});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-upload-publish-')),publisher=new UploadPublisher(),journal=new IncomingUploadJournal(root),owner=new ProjectFileActivities();
  const request:IncomingUploadRequest={version:1,jobId:randomUUID(),projectId:randomUUID(),userId:randomUUID(),messageId:randomUUID(),uploadId:randomUUID(),attachmentId:randomUUID(),name:'synthetic.txt',mimeType:'text/plain',size:5,createdAt:1};
  const proof=await journal.receive(request,stream('hello'),{signal:new AbortController().signal,mayStage:async()=>true}),scope:UploadReadScope={projectId:request.projectId,projectPath:root,ownerUserId:request.userId,viewerUserId:request.userId,viewerRole:'member',active:false,revision:'synthetic'};
  const input={projectPath:root,request,digest:proof.proof.payload.digest,mode:'publish' as const};
  return{root,publisher,journal,owner,scope,request,proof,input,cleanup:async()=>{await owner.close();await publisher.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('isolated publication preserves manifest layout, fixed identities and exact file proof on retry',async()=>{
  const p=await prepared();try{const draft=await p.owner.withUpload(p.scope,{uploadId:p.request.uploadId,messageId:p.request.messageId,size:p.request.size},async()=>{},capability=>capability.publish(()=>p.publisher.run(p.input,async()=>true,capability.signal)));
    assert.equal(draft.id,p.request.attachmentId);assert.equal(draft.messageId,p.request.messageId);assert.equal(await fs.readFile(draft.path,'utf8'),'hello');assert.equal(path.dirname(draft.path),path.join(p.root,'.relay_upload','tmp',p.request.messageId));
    const manifest=JSON.parse(await fs.readFile(path.join(path.dirname(draft.path),'manifest.json'),'utf8'));assert.equal(manifest.version,2);assert.equal(manifest.userId,p.request.userId);assert.equal(manifest.attachments.length,1);assert.equal(manifest.attachments[0].createdAt,1);
    assert.deepEqual(await p.publisher.run({...p.input,mode:'inspect'},async()=>true),draft);assert.deepEqual(await p.publisher.run(p.input,async()=>true),draft);assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(draft.path),'manifest.json'),'utf8')).attachments.length,1);
  }finally{await p.cleanup();}
});

test('a validated publication receipt permits exact private cleanup while preserving retry evidence',async()=>{
  const p=await prepared();try{assert.deepEqual(await p.journal.findRequest(p.request.jobId),p.request);assert.equal(await p.journal.readPublicationRecord(p.request),null);const draft=await p.publisher.run(p.input,async()=>true);await p.journal.recordPublication(p.request,draft,async()=>true);await p.journal.cleanupReceived(p.request,async()=>true);await p.journal.cleanupReceived(p.request,async()=>true);await assert.rejects(fs.stat(path.join(p.root,'.relay_upload','.incoming',p.request.jobId,'payload.part')),{code:'ENOENT'});assert.equal((await p.journal.readPublicationRecord(p.request))!.record.attachment.id,p.request.attachmentId);assert.equal((await p.journal.readReceiveRecord(p.request))!.proofDigest,p.proof.proofDigest);assert.deepEqual(await p.publisher.run({...p.input,mode:'inspect'},async()=>true),draft);}finally{await p.cleanup();}
});

test('private data cannot be cleaned from a metadata-only or changed-public-file claim',async()=>{
  const p=await prepared();try{await assert.rejects(p.journal.cleanupReceived(p.request,async()=>true),{code:'CONFLICT'});const draft=await p.publisher.run(p.input,async()=>true);await p.journal.recordPublication(p.request,draft,async()=>true);let checks=0;await assert.rejects(p.journal.cleanupReceived(p.request,async()=>{if(++checks===2)await fs.writeFile(draft.path,'other');return true;}),{code:'CONFLICT'});assert.equal(await fs.readFile(path.join(p.root,'.relay_upload','.incoming',p.request.jobId,'payload.part'),'utf8'),'hello');assert.equal(await fs.readFile(draft.path,'utf8'),'other');}finally{await p.cleanup();}
});

test('missing drafts are explicit and an initial authority denial performs no public-directory setup',async()=>{
  const p=await prepared();try{await assert.rejects(p.publisher.run(p.input,async()=>false),{code:'FORBIDDEN'});await assert.rejects(fs.stat(path.join(p.root,'.relay_upload','tmp')),{code:'ENOENT'});await assert.rejects(p.publisher.run({...p.input,mode:'inspect'},async()=>true),{code:'NOT_FOUND'});}finally{await p.cleanup();}
});

test('authority is checked inside the Worker immediately before manifest publication',async()=>{
  const p=await prepared();let checks=0;try{await assert.rejects(p.publisher.run(p.input,async()=>++checks<3),{code:'FORBIDDEN'});await assert.rejects(p.publisher.run({...p.input,mode:'inspect'},async()=>true),{code:'NOT_FOUND'});assert.equal(await fs.readFile(path.join(p.root,'.relay_upload','.incoming',p.request.jobId,'payload.part'),'utf8'),'hello');}finally{await p.cleanup();}
});

test('permission failure preserves a part file replaced while the Native authority reply was pending',async()=>{
  const p=await prepared();let checks=0;try{const part=path.join(p.root,'.relay_upload','tmp',p.request.messageId,p.request.uploadId+'.part');await assert.rejects(p.publisher.run(p.input,async()=>{if(++checks===3){await fs.unlink(part);await fs.writeFile(part,'other');return false;}return true;}),{code:'FORBIDDEN'});assert.equal(await fs.readFile(part,'utf8'),'other');assert.equal(await fs.readFile(path.join(p.root,'.relay_upload','.incoming',p.request.jobId,'payload.part'),'utf8'),'hello');}finally{await p.cleanup();}
});

test('a denied response after completed publication does not pretend the file was rolled back',async()=>{
  const p=await prepared();let checks=0;try{await assert.rejects(p.publisher.run(p.input,async()=>++checks<4),{code:'FORBIDDEN'});const recovered=await p.publisher.run({...p.input,mode:'inspect'},async()=>true);assert.equal(recovered.id,p.request.attachmentId);assert.equal(await fs.readFile(recovered.path,'utf8'),'hello');}finally{await p.cleanup();}
});

test('a current draft with changed metadata or content is never overwritten by an old successful upload',async()=>{
  const p=await prepared();try{const draft=await p.publisher.run(p.input,async()=>true);await assert.rejects(p.publisher.run({...p.input,request:{...p.request,name:'other.txt'}},async()=>true),{code:'CONFLICT'});await fs.writeFile(draft.path,'other');await assert.rejects(p.publisher.run(p.input,async()=>true),{code:'CONFLICT'});assert.equal(await fs.readFile(draft.path,'utf8'),'other');}finally{await p.cleanup();}
});

test('a mutated private source cannot be copied into a public draft',async()=>{
  const p=await prepared();try{await fs.writeFile(path.join(p.root,'.relay_upload','.incoming',p.request.jobId,'payload.part'),'other');await assert.rejects(p.publisher.run(p.input,async()=>true),{code:'CONFLICT'});await assert.rejects(p.publisher.run({...p.input,mode:'inspect'},async()=>true),{code:'NOT_FOUND'});}finally{await p.cleanup();}
});

test('publisher close waits for Worker exit and cannot grant a delayed permission after closing',async()=>{
  const p=await prepared(),entered=gate(),release=gate();let checks=0;try{const run=p.publisher.run(p.input,async()=>{if(++checks===2){entered.resolve();await release.promise;}return true;});await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);const closing=p.publisher.close();release.resolve();await assert.rejects(run,{code:'STORAGE_UNAVAILABLE'});await closing;await assert.rejects(p.publisher.run(p.input,async()=>true),{code:'NOT_SUBMITTED'});await assert.rejects(fs.stat(path.join(p.root,'.relay_upload','tmp')),{code:'ENOENT'});}finally{release.resolve();await p.cleanup();}
});

test('an owner abort terminates publication before releasing the physical root for another task',async()=>{
  const p=await prepared(),entered=gate(),release=gate();let checks=0;try{const run=p.owner.withUpload(p.scope,{uploadId:p.request.uploadId,messageId:p.request.messageId,size:p.request.size},async()=>{},capability=>capability.publish(()=>p.publisher.run(p.input,async()=>{if(++checks===2){entered.resolve();await release.promise;}return true;},capability.signal)));await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);const closing=p.owner.close();release.resolve();await assert.rejects(run,{code:'STORAGE_UNAVAILABLE'});await closing;const other=new ProjectFileActivities();try{assert.deepEqual((await other.snapshot(p.scope)).reservations,[]);}finally{await other.close();}}finally{release.resolve();await p.cleanup();}
});
