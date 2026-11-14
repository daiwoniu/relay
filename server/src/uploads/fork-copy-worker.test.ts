import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectUploadStore } from './project-uploads.js';
import { ForkUploadCopier } from './fork-copy-worker.js';

async function prepared() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'relay-fork-copy-')), store = new ProjectUploadStore();
  const sourceIdentity = {projectId:randomUUID(),userId:randomUUID()}, targetIdentity = {projectId:randomUUID(),userId:randomUUID()}, sourceMessageId = randomUUID();
  async function* bytes() {yield Buffer.from('synthetic');}
  const draft = await store.writeUpload({...sourceIdentity,projectPath:root,messageId:sourceMessageId,uploadId:randomUUID(),name:'source.txt',mimeType:'text/plain',declaredSize:9,body:bytes()});
  const source = store.prepareArchive({...sourceIdentity,projectPath:root,messageId:sourceMessageId,drafts:[draft]}).attachments;
  const input = {operationId:'copy:'+randomUUID(),projectPath:root,sourceMessageId,targetMessageId:randomUUID(),sourceAttachmentIds:source.map((a)=>a.id),sourceIdentity,targetIdentity};
  return {root,store,source,input,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('fork copy proof reconciles a completed copy across store instances and preserves target ownership and IDs',async()=>{
  const p=await prepared();
  try{
    const first=p.store.ensureForkCopy(p.input),second=new ProjectUploadStore().ensureForkCopy(p.input);
    assert.deepEqual(second,first);assert.notEqual(first[0]!.id,p.source[0]!.id);
    assert.equal(fs.readFileSync(first[0]!.path,'utf8'),'synthetic');
    const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(first[0]!.path),'manifest.json'),'utf8'));
    assert.equal(manifest.userId,p.input.targetIdentity.userId);assert.equal(manifest.projectId,p.input.targetIdentity.projectId);
    assert.equal(manifest.forkCopy.operationId,p.input.operationId);assert.match(manifest.forkCopy.contentDigests[0],/^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(p.source[0]!.path,'utf8'),'synthetic');
  }finally{p.cleanup();}
});
test('mismatched intent, same-size target tampering and incomplete targets fail closed without overwriting',async()=>{
  const p=await prepared();
  try{
    const copy=p.store.ensureForkCopy(p.input)[0]!;
    assert.throws(()=>p.store.ensureForkCopy({...p.input,operationId:'different'}),{code:'UPLOAD_FORK_COPY_UNCONFIRMED'});
    fs.writeFileSync(copy.path,'tampered!');
    assert.throws(()=>new ProjectUploadStore().ensureForkCopy(p.input),{code:'UPLOAD_FORK_COPY_UNCONFIRMED'});
    assert.equal(fs.readFileSync(copy.path,'utf8'),'tampered!');
    const targetMessageId=randomUUID(),target=path.join(p.root,'.relay_upload','messages',targetMessageId);fs.mkdirSync(target);fs.writeFileSync(path.join(target,'retained.txt'),'keep');
    assert.throws(()=>p.store.ensureForkCopy({...p.input,targetMessageId}));assert.equal(fs.readFileSync(path.join(target,'retained.txt'),'utf8'),'keep');
    assert.equal(fs.readFileSync(p.source[0]!.path,'utf8'),'synthetic');
  }finally{p.cleanup();}
});
test('changed source content cannot silently reuse an older proven copy',async()=>{
  const p=await prepared();
  try{
    const copy=p.store.ensureForkCopy(p.input)[0]!;fs.writeFileSync(p.source[0]!.path,'changed!!');
    assert.throws(()=>new ProjectUploadStore().ensureForkCopy(p.input),{code:'UPLOAD_FORK_COPY_UNCONFIRMED'});
    assert.equal(fs.readFileSync(copy.path,'utf8'),'synthetic');
  }finally{p.cleanup();}
});
test('write Worker survives caller deadline and retry recovers the same on-disk proof after reopening',async()=>{
  const p=await prepared(),copier=new ForkUploadCopier(1);let reopened:ForkUploadCopier|undefined;
  try{
    await assert.rejects(copier.copy(p.input),{code:'COPY_RESULT_UNKNOWN'});
    const jobs=[...(copier as any).jobs.values()] as Array<{result:Promise<unknown>}>;
    await Promise.all(jobs.map((job)=>job.result));
    const confirmed=p.store.ensureForkCopy(p.input);await copier.dispose();
    reopened=new ForkUploadCopier();assert.deepEqual(await reopened.copy(p.input),confirmed);
    assert.equal(fs.readFileSync(confirmed[0]!.path,'utf8'),'synthetic');
    await assert.rejects(copier.copy(p.input),{code:'NOT_SUBMITTED'});
  }finally{await copier.dispose();await reopened?.dispose();p.cleanup();}
});
test('file writer concurrency and intent queues are bounded before any additional job is submitted',async()=>{
  const p=await prepared(),copier=new ForkUploadCopier(1);
  try{
    await assert.rejects(copier.copy({...p.input,projectPath:'relative'}),{code:'NOT_SUBMITTED'});
    const outcomes=Promise.allSettled([copier.copy(p.input),copier.copy({...p.input,targetMessageId:randomUUID()})]);
    await assert.rejects(copier.copy({...p.input,targetMessageId:randomUUID()}),{code:'OVERLOADED'});
    await outcomes;
  }finally{await copier.dispose();p.cleanup();}
});

test('same copier rechecks a completed file proof instead of returning stale success from memory',async()=>{
  const p=await prepared(),copier=new ForkUploadCopier();
  try{
    const first=await copier.copy(p.input);fs.writeFileSync(first[0]!.path,'tampered!');
    await assert.rejects(copier.copy(p.input),{code:'COPY_UNCONFIRMED'});
    assert.equal(fs.readFileSync(first[0]!.path,'utf8'),'tampered!');
  }finally{await copier.dispose();p.cleanup();}
});

test('same copier can retry a transient incomplete-target failure after the target is safely cleared',async()=>{
  const p=await prepared(),copier=new ForkUploadCopier();
  const target=path.join(p.root,'.relay_upload','messages',p.input.targetMessageId);fs.mkdirSync(target);
  try{
    await assert.rejects(copier.copy(p.input),{code:'COPY_UNCONFIRMED'});
    fs.rmdirSync(target); // Only this empty, test-created directory is removed.
    const second=await copier.copy(p.input);assert.equal(fs.readFileSync(second[0]!.path,'utf8'),'synthetic');
  }finally{await copier.dispose();p.cleanup();}
});

test('different messages in one project cannot race quota checking in separate copy Workers',async()=>{
  const p=await prepared(),copier=new ForkUploadCopier();
  try{
    const first=copier.copy(p.input);
    await assert.rejects(copier.copy({...p.input,projectPath:path.join(p.root,'.'),targetMessageId:randomUUID()}),{code:'OVERLOADED'});
    const completed=await first;
    const second=await copier.copy({...p.input,targetMessageId:randomUUID()});
    assert.notEqual(second[0]!.id,completed[0]!.id);
    assert.equal((copier as any).jobs.size,0);
  }finally{await copier.dispose();p.cleanup();}
});
