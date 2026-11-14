import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { IncomingUploadJournal } from './incoming-upload-journal.js';
import { IncomingUploadRequestSchema,type IncomingUploadRequest } from './incoming-upload-contract.js';
import { ProjectFileActivities } from './project-file-activities.js';
import type { UploadReadScope } from '../storage/contracts.js';
const stream=(...chunks:Uint8Array[])=>new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(size=5){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-upload-incoming-')),journal=new IncomingUploadJournal(root),abort=new AbortController();
  const request:IncomingUploadRequest={version:1,jobId:randomUUID(),projectId:randomUUID(),userId:randomUUID(),messageId:randomUUID(),uploadId:randomUUID(),attachmentId:randomUUID(),name:'synthetic.txt',mimeType:'text/plain',size,createdAt:1};
  const directory=path.join(root,'.relay_upload','.incoming',request.jobId),control={mayStage:async()=>true,signal:abort.signal};
  return{root,journal,request,directory,control,abort,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}

test('incoming receive writes only a private journal and yields a bounded hash/identity proof',async()=>{
  const p=await prepared();try{assert.equal(await p.journal.inspect(p.request),null);const proof=await p.journal.receive(p.request,stream(Buffer.from('he'),Buffer.from('llo')),p.control);assert.equal(proof.proof.payload.size,5);assert.equal(proof.proof.payload.digest,createHash('sha256').update('hello').digest('hex'));assert.deepEqual(await p.journal.inspect(p.request),proof);assert.equal(await fs.readFile(path.join(p.directory,'payload.part'),'utf8'),'hello');assert.deepEqual((await fs.readdir(path.join(p.root,'.relay_upload'))).sort(),['.gitignore','.incoming']);assert.equal(JSON.stringify(proof).includes(p.root),false);
  }finally{await p.cleanup();}
});

test('a completed exact retry keeps the original file and cancels the unused retry body',async()=>{
  const p=await prepared();try{const proof=await p.journal.receive(p.request,stream(Buffer.from('hello')),p.control);let cancelled=0;const retry=new ReadableStream<Uint8Array>({cancel(){cancelled++;}});assert.deepEqual(await p.journal.receive(p.request,retry,p.control),proof);assert.equal(cancelled,1);await assert.rejects(p.journal.receive({...p.request,name:'changed.txt'},stream(Buffer.from('other')),p.control),{code:'CONFLICT'});assert.equal(await fs.readFile(path.join(p.directory,'payload.part'),'utf8'),'hello');}finally{await p.cleanup();}
});

test('declared size mismatch and oversized actual bodies preserve incomplete evidence and never publish a proof',async()=>{
  for(const value of ['tiny','too-long']){const p=await prepared();try{await assert.rejects(p.journal.receive(p.request,stream(Buffer.from(value)),p.control),{code:value==='tiny'?'INVALID_ARGUMENT':'PAYLOAD_TOO_LARGE'});assert.equal(await p.journal.inspect(p.request),null);await assert.rejects(fs.stat(path.join(p.directory,'complete.json')),{code:'ENOENT'});const intent=await fs.readFile(path.join(p.directory,'request.json'),'utf8');await assert.rejects(p.journal.receive(p.request,stream(Buffer.from('hello')),p.control),{code:'CONFLICT'});assert.equal(await fs.readFile(path.join(p.directory,'request.json'),'utf8'),intent);}finally{await p.cleanup();}}
});

test('dangerous content and names cannot create a completed upload journal',async()=>{
  const p=await prepared();try{assert.equal(IncomingUploadRequestSchema.safeParse({...p.request,name:'run.exe'}).success,false);await assert.rejects(p.journal.receive(p.request,stream(Buffer.from('MZbad')),p.control),{code:'INVALID_ARGUMENT'});assert.equal(await p.journal.inspect(p.request),null);}finally{await p.cleanup();}
});

test('authorization precedes directory writes and is rechecked before the receive proof is sealed',async()=>{
  const p=await prepared();try{await assert.rejects(p.journal.receive(p.request,stream(Buffer.from('hello')),{...p.control,mayStage:async()=>false}),{code:'FORBIDDEN'});assert.deepEqual(await fs.readdir(p.root),[]);let checks=0;await assert.rejects(p.journal.receive(p.request,stream(Buffer.from('hello')),{...p.control,mayStage:async()=>++checks<3}),{code:'FORBIDDEN'});assert.equal(await p.journal.inspect(p.request),null);assert.equal(await fs.readFile(path.join(p.directory,'payload.part'),'utf8'),'hello');}finally{await p.cleanup();}
});

test('abort cancels a stalled body read, closes the payload and retains only incomplete private evidence',async()=>{
  const p=await prepared(),reading=gate();let cancelled=0;try{const body=new ReadableStream<Uint8Array>({pull(){reading.resolve();},cancel(){cancelled++;}},{highWaterMark:0}),run=p.journal.receive(p.request,body,p.control);await Promise.race([reading.promise,run.then(()=>assert.fail('not reading'))]);p.abort.abort();await assert.rejects(run,{code:'FORBIDDEN'});assert.equal(cancelled,1);assert.equal(await p.journal.inspect(p.request),null);const handle=await fs.open(path.join(p.directory,'payload.part'),'r+');await handle.close();}finally{p.abort.abort();await p.cleanup();}
});

test('tampered, replaced or hard-linked payloads cannot be accepted from an old completion proof',async()=>{
  for(const mode of ['changed','replaced','linked']){const p=await prepared();try{await p.journal.receive(p.request,stream(Buffer.from('hello')),p.control);const filename=path.join(p.directory,'payload.part');if(mode==='changed')await fs.writeFile(filename,'other');else if(mode==='replaced'){await fs.unlink(filename);await fs.writeFile(filename,'hello');}else await fs.link(filename,path.join(p.root,'alias.txt'));await assert.rejects(p.journal.inspect(p.request),{code:'CONFLICT'});}finally{await p.cleanup();}}
});

test('empty uploads and large source chunks use the same exact-size and streaming digest rules',async()=>{
  for(const size of [0,1024*1024+17]){const p=await prepared(size);try{const bytes=Buffer.alloc(size,97),proof=await p.journal.receive(p.request,stream(bytes),p.control);assert.equal(proof.proof.payload.size,size);assert.equal(proof.proof.payload.digest,createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(await p.journal.inspect(p.request),proof);}finally{await p.cleanup();}}
});

test('unknown orphan files in a reused journal are preserved without writing a new intent',async()=>{
  const p=await prepared();try{await fs.mkdir(p.directory,{recursive:true});await fs.writeFile(path.join(p.directory,'unexpected.txt'),'preserve');await assert.rejects(p.journal.receive(p.request,stream(Buffer.from('hello')),p.control),{code:'CONFLICT'});assert.equal(await fs.readFile(path.join(p.directory,'unexpected.txt'),'utf8'),'preserve');await assert.rejects(fs.stat(path.join(p.directory,'request.json')),{code:'ENOENT'});}finally{await p.cleanup();}
});

test('file-owner shutdown cancels the real receive stream and drains before releasing its reservation',async()=>{
  const p=await prepared(),owner=new ProjectFileActivities(),other=new ProjectFileActivities(),reading=gate();try{const scope:UploadReadScope={projectId:p.request.projectId,projectPath:p.root,ownerUserId:p.request.userId,viewerUserId:p.request.userId,viewerRole:'member',active:false,revision:'synthetic'},body=new ReadableStream<Uint8Array>({pull(){reading.resolve();}},{highWaterMark:0}),run=owner.withUpload(scope,{uploadId:p.request.uploadId,messageId:p.request.messageId,size:p.request.size},async()=>{},async(capability)=>new IncomingUploadJournal(capability.projectRoot).receive(p.request,body,{signal:capability.signal,mayStage:async()=>{await capability.assertCurrent();return true;}}));
    await Promise.race([reading.promise,run.then(()=>assert.fail('not reading'))]);assert.equal((await other.snapshot(scope)).reservations.length,1);const closing=owner.close();await assert.rejects(run,{code:'FORBIDDEN'});await closing;assert.deepEqual((await other.snapshot(scope)).reservations,[]);assert.equal(await p.journal.inspect(p.request),null);
  }finally{await owner.close();await other.close();await p.cleanup();}
});
