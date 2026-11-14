import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { hashSessionToken } from '../auth/session.js';
import { ProjectFileActivities } from '../uploads/project-file-activities.js';
import { UploadPublisher } from '../uploads/upload-publisher.js';
import { StoredProjectUploads,type StoredUploadIntent } from './stored-project-uploads.js';
import { createStoredProjectUploadsRouter } from '../routes/stored-project-uploads.js';
import { StoredDraftCleanup } from './stored-draft-cleanup.js';
import { createStoredDraftCleanupRouter } from '../routes/stored-draft-cleanup.js';
const user='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222';
const principal={kind:'user' as const,userId:user,authSessionHash:hashSessionToken('synthetic-upload-owner')};
const stream=(value='hello')=>new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from(value));c.close();}});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-stored-upload-')),f=fixture(),files=new ProjectFileActivities(),services:StoredProjectUploads[]=[];
  f.mutate(`INSERT INTO users(id,role,username,must_change_password) VALUES('${user}','member','upload-owner',0);
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal.authSessionHash}','${user}',${Date.now()+600000});
    INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','${user}','${root.replaceAll("'","''")}','Uploads')`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'upload-service-test',generation:1,initialize:true});
  const make=(extra:Partial<ConstructorParameters<typeof StoredProjectUploads>[0]>={})=>{const service=new StoredProjectUploads({port,storeId:'upload-service-test',generation:1,files,assertExclusiveWriter:async()=>{},...extra});services.push(service);return service;};
  const intent:StoredUploadIntent={projectId:project,messageId:randomUUID(),uploadId:randomUUID(),name:'synthetic.txt',mimeType:'text/plain',size:5};
  return{root,f,port,files,make,intent,cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await files.close();await port.close();f.cleanup();await fs.rm(root,{recursive:true,force:true});}};
}

test('current Native authorization, streamed receive, isolated publication and receipt cleanup form one retryable upload',async()=>{
  const p=await prepared();try{const service=p.make({now:()=>1234}),first=await service.upload(principal,p.intent,stream());assert.equal(first.state,'committed');if(first.state!=='committed')return;
    assert.equal(await fs.readFile(first.value.attachment.path,'utf8'),'hello');assert.equal(first.value.usage.usedBytes,5);assert.equal(first.value.usage.reservedBytes,0);
    const incoming=path.join(p.root,'.relay_upload','.incoming'),jobs=await fs.readdir(incoming);assert.equal(jobs.length,1);const retained=await fs.readdir(path.join(incoming,jobs[0]!));assert.deepEqual(retained.sort(),['complete.json','dispatch.json','published.json','request.json']);
    let cancelled=false;const retry=await service.upload(principal,p.intent,new ReadableStream({cancel(){cancelled=true;}}));assert.deepEqual(retry,first);assert.equal(cancelled,true);
    const manifest=JSON.parse(await fs.readFile(path.join(path.dirname(first.value.attachment.path),'manifest.json'),'utf8'));assert.equal(manifest.attachments.length,1);assert.equal(manifest.attachments[0].createdAt,1234);
    assert.deepEqual(await service.upload(principal,{...p.intent,name:'different.txt'},stream()),{state:'rejected',code:'CONFLICT'});assert.equal(await fs.readFile(first.value.attachment.path,'utf8'),'hello');
  }finally{await p.cleanup();}
});

test('a later deleted draft is not recreated from a retained upload receipt',async()=>{
  const p=await prepared();try{const service=p.make(),first=await service.upload(principal,p.intent,stream());assert.equal(first.state,'committed');if(first.state!=='committed')return;await fs.unlink(first.value.attachment.path);await fs.unlink(path.join(path.dirname(first.value.attachment.path),'manifest.json'));
    assert.deepEqual(await service.upload(principal,p.intent,stream()),{state:'unknown'});await assert.rejects(fs.stat(first.value.attachment.path),{code:'ENOENT'});
  }finally{await p.cleanup();}
});

test('a lost publisher reply is proven from current bytes without dispatching the publication again',async()=>{
  const p=await prepared(),publisher=new UploadPublisher();let writes=0;try{const service=p.make({publisher:{run:async(input,guard,signal)=>{const result=await publisher.run(input,guard,signal);if(input.mode==='publish'){writes++;throw new StorageContractError('STORAGE_UNAVAILABLE');}return result;}}});
    const first=await service.upload(principal,p.intent,stream());assert.equal(first.state,'committed');assert.equal(writes,1);assert.deepEqual(await service.upload(principal,p.intent,stream()),first);assert.equal(writes,1);
  }finally{await publisher.close();await p.cleanup();}
});

test('an unknown dispatch without a current draft is fenced across new service instances',async()=>{
  const p=await prepared();let writes=0;const publisher={run:async(input:Parameters<UploadPublisher['run']>[0])=>{if(input.mode==='publish'){writes++;throw new StorageContractError('STORAGE_UNAVAILABLE');}throw new StorageContractError('NOT_FOUND');}};
  try{assert.deepEqual(await p.make({publisher}).upload(principal,p.intent,stream()),{state:'unknown'});assert.equal(writes,1);assert.deepEqual(await p.make({publisher}).upload(principal,p.intent,stream()),{state:'unknown'});assert.equal(writes,1);await assert.rejects(fs.stat(path.join(p.root,'.relay_upload','tmp')),{code:'ENOENT'});}finally{await p.cleanup();}
});

test('same-intent overlapping requests share the body owner and publication',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{let cancelled=false;const body=new ReadableStream<Uint8Array>({async pull(c){entered.resolve();await release.promise;c.enqueue(Buffer.from('hello'));c.close();}}),service=p.make(),first=service.upload(principal,p.intent,body);await entered.promise;
    const retry=service.upload(principal,p.intent,new ReadableStream({cancel(){cancelled=true;}}));release.resolve();const [a,b]=await Promise.all([first,retry]);assert.equal(a.state,'committed');assert.deepEqual(a,b);assert.equal(cancelled,true);
  }finally{release.resolve();await p.cleanup();}
});

test('a revoked Native session during body IO cannot publish an attachment',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const body=new ReadableStream<Uint8Array>({async pull(c){entered.resolve();await release.promise;c.enqueue(Buffer.from('hello'));c.close();}}),run=p.make().upload(principal,p.intent,body);await entered.promise;p.f.mutate(`UPDATE auth_sessions SET expires_at=1 WHERE token_hash='${principal.authSessionHash}'`);release.resolve();assert.deepEqual(await run,{state:'rejected',code:'FORBIDDEN'});await assert.rejects(fs.stat(path.join(p.root,'.relay_upload','tmp')),{code:'ENOENT'});
  }finally{release.resolve();await p.cleanup();}
});

test('shutdown aborts a stalled receive and drains the physical body owner',async()=>{
  const p=await prepared(),entered=gate();let cancelled=false;try{const service=p.make(),run=service.upload(principal,p.intent,new ReadableStream<Uint8Array>({pull(){entered.resolve();return new Promise<void>(()=>{});},cancel(){cancelled=true;}}));await entered.promise;await service.close();assert.notEqual((await run).state,'committed');assert.equal(cancelled,true);await assert.rejects(fs.stat(path.join(p.root,'.relay_upload','tmp')),{code:'ENOENT'});assert.deepEqual(await service.upload(principal,p.intent,stream()),{state:'rejected',code:'NOT_SUBMITTED'});
  }finally{await p.cleanup();}
});

test('candidate HTTP keeps the existing upload response while rejecting hostile or malformed input',async()=>{
  const p=await prepared();try{const app=new Hono().route('/api/projects',createStoredProjectUploadsRouter({port:p.port,service:p.make()})),url=`/api/projects/${project}/uploads`,headers={cookie:'relay_session=synthetic-upload-owner','x-relay-upload-id':p.intent.uploadId,'x-relay-message-id':p.intent.messageId,'x-relay-file-name':'synthetic.txt','x-relay-file-size':'5','content-type':'text/plain'};
    assert.equal((await app.request(url,{method:'POST',body:'hello'})).status,401);assert.equal((await app.request(url,{method:'POST',headers:{...headers,origin:'https://hostile.invalid'},body:'hello'})).status,403);assert.equal((await app.request(url+'?path=foreign',{method:'POST',headers,body:'hello'})).status,400);
    assert.equal((await app.request(url,{method:'POST',headers:{...headers,'x-relay-file-size':'NaN'},body:'hello'})).status,400);assert.deepEqual(await fs.readdir(p.root),[]);
    const response=await app.request(url,{method:'POST',headers,body:'hello'});assert.equal(response.status,201);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-relay-upload-id'),p.intent.uploadId);const value=await response.json() as any;assert.equal(value.attachment.uploadId,p.intent.uploadId);assert.equal(value.usage.reservedBytes,0);
    const bad=await app.request(url,{method:'POST',headers:{...headers,'x-relay-upload-id':randomUUID()},body:'oversized'});assert.equal(bad.status,413);assert.equal((await bad.text()).includes(p.root),false);
  }finally{await p.cleanup();}
});

test('candidate draft cleanup HTTP removes exact bytes and old upload retries cannot resurrect them',async()=>{
  const p=await prepared(),cleanup=new StoredDraftCleanup({port:p.port,storeId:'upload-service-test',generation:1,files:p.files,assertExclusiveWriter:async()=>{}});try{const service=p.make(),uploaded=await service.upload(principal,p.intent,stream());assert.equal(uploaded.state,'committed');if(uploaded.state!=='committed')return;await fs.writeFile(path.join(path.dirname(uploaded.value.attachment.path),'unmanaged.txt'),'keep');
    const app=new Hono().route('/api/projects',createStoredDraftCleanupRouter({port:p.port,service:cleanup})),url=`/api/projects/${project}/uploads/drafts/${p.intent.uploadId}`,headers={cookie:'relay_session=synthetic-upload-owner'};
    assert.equal((await app.request(url,{method:'DELETE'})).status,401);assert.equal((await app.request(url,{method:'DELETE',headers:{...headers,origin:'https://hostile.invalid'}})).status,403);assert.equal((await app.request(url+'?force=1',{method:'DELETE',headers})).status,400);assert.equal((await app.request(url,{method:'DELETE',headers,body:'untrusted'})).status,400);
    const response=await app.request(url,{method:'DELETE',headers});assert.equal(response.status,200);const value=await response.json() as any;assert.equal(value.deletedCount,1);assert.equal(value.usage.usedBytes,4);assert.equal(value.usage.temporaryFileCount,0);assert.equal(response.headers.get('cache-control'),'private, no-store');await assert.rejects(fs.stat(uploaded.value.attachment.path),{code:'ENOENT'});
    assert.deepEqual(await service.upload(principal,p.intent,stream()),{state:'unknown'});const repeated=await app.request(url,{method:'DELETE',headers});assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),value);assert.equal(await fs.readFile(path.join(path.dirname(uploaded.value.attachment.path),'unmanaged.txt'),'utf8'),'keep');
  }finally{await cleanup.close();await p.cleanup();}
});

test('browser draft cleanup accepts an empty DELETE through the Node HTTP adapter and rejects payloads',async()=>{
  const {requestJson}=await import(new URL('../../../client/src/api/client.ts',import.meta.url).href);
  const p=await prepared(),cleanup=new StoredDraftCleanup({port:p.port,storeId:'upload-service-test',generation:1,files:p.files,assertExclusiveWriter:async()=>{}});
  try{
    const uploaded=await p.make().upload(principal,p.intent,stream());assert.equal(uploaded.state,'committed');if(uploaded.state!=='committed')return;
    const app=new Hono().route('/api/projects',createStoredDraftCleanupRouter({port:p.port,service:cleanup}));
    let server:ReturnType<typeof serve>;
    const address=await new Promise<{port:number}>(resolve=>{server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0},resolve);});
    const url=`http://127.0.0.1:${address.port}/api/projects/${project}/uploads/drafts/${p.intent.uploadId}`,headers={cookie:'relay_session=synthetic-upload-owner'};
    try{
      const invalid=await fetch(url,{method:'DELETE',headers,body:'{}'});assert.equal(invalid.status,400);
      assert.equal(await fs.readFile(uploaded.value.attachment.path,'utf8'),'hello');
      const value=await requestJson(url,{method:'DELETE',headers}) as {deletedCount:number};assert.equal(value.deletedCount,1);
      await assert.rejects(fs.stat(uploaded.value.attachment.path),{code:'ENOENT'});
      assert.deepEqual(await requestJson(url,{method:'DELETE',headers}),value);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  }finally{await cleanup.close();await p.cleanup();}
});

test('draft cleanup never dispatches deletion when body validation fails or times out',async()=>{
  const p=await prepared();let calls=0,cancelled=false;
  const app=new Hono().route('/api/projects',createStoredDraftCleanupRouter({port:p.port,service:{delete:async()=>{calls++;return{state:'unknown' as const};}}}));
  const url=`/api/projects/${project}/uploads/drafts/${p.intent.uploadId}`,headers={cookie:'relay_session=synthetic-upload-owner'};
  const request=(body:ReadableStream<Uint8Array>)=>app.request(new Request(`http://localhost${url}`,{method:'DELETE',headers,body,duplex:'half'} as RequestInit));
  try{
    const broken=await request(new ReadableStream({start(c){c.error(new Error('synthetic read failure'));}}));
    assert.equal(broken.status,503);assert.deepEqual(await broken.json(),{error:'草稿清理暂时不可用'});assert.equal(calls,0);
    const stalled=await request(new ReadableStream({cancel(){cancelled=true;}}));
    assert.equal(stalled.status,503);assert.equal(cancelled,true);assert.equal(calls,0);
    const invalid=await app.request(url,{method:'DELETE',headers,body:'{}'});
    assert.equal(invalid.status,400);assert.equal(calls,0);
    const empty=await request(new ReadableStream({start(c){c.enqueue(new Uint8Array());c.close();}}));
    assert.equal(empty.status,503);assert.equal((await empty.json() as {code:string}).code,'UPLOAD_CLEANUP_UNKNOWN');assert.equal(calls,1);
  }finally{await p.cleanup();}
});

test('draft cleanup refuses active upload ownership and initial Native revocation before touching files',async()=>{
  const p=await prepared(),cleanup=new StoredDraftCleanup({port:p.port,storeId:'upload-service-test',generation:1,files:p.files,assertExclusiveWriter:async()=>{}}),entered=gate(),release=gate();try{const scope=await p.port.readUploadScope({principal,projectId:project}),active=p.files.withUpload(scope,{uploadId:p.intent.uploadId,messageId:p.intent.messageId,size:5},async()=>{},async()=>{entered.resolve();await release.promise;});await entered.promise;
    assert.deepEqual(await cleanup.delete(principal,project,p.intent.uploadId),{state:'rejected',code:'CONFLICT'});assert.deepEqual(await fs.readdir(p.root),[]);release.resolve();await active;p.f.mutate(`UPDATE auth_sessions SET expires_at=1 WHERE token_hash='${principal.authSessionHash}'`);assert.deepEqual(await cleanup.delete(principal,project,p.intent.uploadId),{state:'rejected',code:'FORBIDDEN'});assert.deepEqual(await fs.readdir(p.root),[]);
  }finally{release.resolve();await cleanup.close();await p.cleanup();}
});
