import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectUploadStore } from './project-uploads.js';
import { UploadPromoter } from './upload-promoter.js';
import { promoteUploads } from './upload-promotion-journal.js';
async function setup(){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'relay-promotion-'))),store=new ProjectUploadStore(),projectId=randomUUID(),userId=randomUUID(),messageId=randomUUID();
  async function* body(){yield Buffer.from('test');}
  const draft=await store.writeUpload({projectPath:root,projectId,userId,messageId,uploadId:randomUUID(),name:'test.txt',mimeType:'text/plain',declaredSize:4,body:body()});
  const input={projectPath:root,projectId,userId,messageId,uploads:[draft],hosts:[]},worker=new UploadPromoter();
  return{root,draft,input,worker,close:async()=>{await worker.close();await fs.rm(root,{recursive:true,force:true});}};
}
test('promotion Worker returns archived files and a new instance reconciles the durable intent',async()=>{
  const h=await setup();try{
    const first=await h.worker.run(h.input,async()=>true);assert.equal(await fs.readFile(first.uploads[0]!.path,'utf8'),'test');
    await assert.rejects(fs.stat(h.draft.path),{code:'ENOENT'});
    await fs.unlink(path.join(h.root,'.relay_upload','.promotions',h.input.messageId,'completed.json'));
    const another=new UploadPromoter();try{assert.deepEqual(await another.run(h.input,async()=>true),first);}finally{await another.close();}
    const {uploads:_,hosts:__,...scope}=h.input;
    const inspected=await h.worker.inspect({...scope,attachments:first.uploads},async()=>true);
    assert.deepEqual(inspected.uploads,first.uploads);
  }finally{await h.close();}
});
test('revocation before rename retains the original draft and the next authorized attempt can reconcile',async()=>{
  const h=await setup();try{
    let checks=0;await assert.rejects(promoteUploads(h.input,async()=>++checks===1),{code:'FORBIDDEN'});
    assert.equal(await fs.readFile(h.draft.path,'utf8'),'test');
    const result=await h.worker.run(h.input,async()=>true);assert.equal(await fs.readFile(result.uploads[0]!.path,'utf8'),'test');
  }finally{await h.close();}
});
test('changed payload and forged draft fields cannot reuse or overwrite an archived promotion',async()=>{
  const h=await setup();try{
    const result=await h.worker.run(h.input,async()=>true);await fs.writeFile(result.uploads[0]!.path,'evil');
    await assert.rejects(h.worker.run(h.input,async()=>true),{code:'CONFLICT'});
    assert.equal(await fs.readFile(result.uploads[0]!.path,'utf8'),'evil');
    await assert.rejects(h.worker.run({...h.input,uploads:[{...h.draft,name:'forged.txt'}]},async()=>true),{code:'CONFLICT'});
  }finally{await h.close();}
});
