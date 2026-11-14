import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { FileAccessGrants } from '../file-access.js';
import { StoredFileDownloads } from './stored-file-downloads.js';
import { createStoredFileDownloadsRouter } from '../routes/stored-file-downloads.js';
const user='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222';
const principal={kind:'user' as const,userId:user,authSessionHash:hashSessionToken('synthetic-download-owner')};
const other={kind:'user' as const,userId:'other',authSessionHash:hashSessionToken('synthetic-download-other')},admin={kind:'user' as const,userId:'admin',authSessionHash:hashSessionToken('synthetic-download-admin')};
async function prepared(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-download-')),f=fixture(),grants=new FileAccessGrants(),services:StoredFileDownloads[]=[];
  f.mutate(`INSERT INTO users(id,role,username,must_change_password) VALUES('${user}','member','download-owner',0);
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal.authSessionHash}','${user}',${Date.now()+600000});
    INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','${user}','${root.replaceAll("'","''")}','Downloads');
    INSERT INTO project_members(project_id,user_id,role,can_view_sessions,created_at,updated_at) VALUES('${project}','other','manager',1,1,1);
    UPDATE auth_sessions SET token_hash='${other.authSessionHash}' WHERE user_id='other';
    UPDATE auth_sessions SET token_hash='${admin.authSessionHash}' WHERE user_id='admin'`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'download-service-test',generation:1,initialize:true}),filename=path.join(root,'synthetic.txt');await fs.writeFile(filename,'hello');
  const make=(extra:Partial<ConstructorParameters<typeof StoredFileDownloads>[0]>={})=>{const service=new StoredFileDownloads({port,grants,...extra});services.push(service);return service;};
  return{root,f,port,grants,filename,make,cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await port.close();f.cleanup();await fs.rm(root,{recursive:true,force:true});}};
}

test('owned project downloads preserve bytes with bounded chunks and no managed-directory writes',async()=>{
  const p=await prepared();try{const bytes=Buffer.alloc(2*65536+7,42);await fs.writeFile(p.filename,bytes);const value=await p.make().open(principal,{path:p.filename}),reader=value.stream.getReader(),chunks:Uint8Array[]=[];for(;;){const next=await reader.read();if(next.done)break;assert.ok(next.value.length<=65536);chunks.push(next.value);}assert.equal(value.size,bytes.length);assert.equal(value.name,'synthetic.txt');assert.deepEqual(Buffer.concat(chunks),bytes);assert.deepEqual(await fs.readdir(p.root),['synthetic.txt']);}finally{await p.cleanup();}
});

test('project membership alone does not grant filesystem access while current administrators retain access',async()=>{
  const p=await prepared();try{const service=p.make();await assert.rejects(service.open(other,{path:p.filename}),{code:'FORBIDDEN'});const result=await service.open(admin,{path:p.filename});assert.equal(await new Response(result.stream).text(),'hello');}finally{await p.cleanup();}
});

test('an explicitly granted outside file remains user-bound and revocation interrupts unread bytes',async()=>{
  const p=await prepared(),outside=path.join(os.tmpdir(),`relay-download-granted-${randomUUID()}.txt`);try{await fs.writeFile(outside,'outside');const accessToken=p.grants.grant(outside,user),service=p.make();await assert.rejects(service.open(other,{path:outside,accessToken}),{code:'FORBIDDEN'});const first=await service.open(principal,{path:outside,accessToken});assert.equal(await new Response(first.stream).text(),'outside');const second=await service.open(principal,{path:outside,accessToken});p.grants.revoke(accessToken,user);await assert.rejects(new Response(second.stream).text(),{code:'FORBIDDEN'});}finally{await p.cleanup();await fs.rm(outside,{force:true});}
});

test('current auth expiry, owner change, deletion fence or payload replacement abort the next chunk',async()=>{
  for(const mode of ['auth','owner','fence','file']){const p=await prepared();try{await fs.writeFile(p.filename,Buffer.alloc(65541,42));const value=await p.make().open(principal,{path:p.filename}),reader=value.stream.getReader();assert.equal((await reader.read()).value!.length,65536);
    if(mode==='auth')p.f.mutate(`UPDATE auth_sessions SET expires_at=1 WHERE token_hash='${principal.authSessionHash}'`);
    else if(mode==='owner')p.f.mutate(`UPDATE projects SET owner_user_id='other' WHERE id='${project}'`);
    else if(mode==='file'){await fs.writeFile(p.filename,Buffer.alloc(65541,43));await fs.utimes(p.filename,Date.now()/1000,Date.now()/1000+10);}
    else{const command=await p.port.execute({protocolVersion:1,storeId:'download-service-test',workerGeneration:1,requestId:randomUUID(),operationId:randomUUID(),principal,command:{name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'project',resourceId:project}}});assert.equal(command.state,'committed');}
    await assert.rejects(reader.read(),{code:mode==='auth'?'FORBIDDEN':mode==='owner'?'NOT_FOUND':'CONFLICT'});
  }finally{await p.cleanup();}}
});

test('private upload recovery metadata and hard-linked files cannot be downloaded',async()=>{
  const p=await prepared();try{for(const name of ['.incoming','.cleanup','.trash-quarantine']){const directory=path.join(p.root,'.relay_upload',name,randomUUID());await fs.mkdir(directory,{recursive:true});const privateFile=path.join(directory,'request.json');await fs.writeFile(privateFile,'private');const token=p.grants.grant(privateFile,user);await assert.rejects(p.make().open(principal,{path:privateFile,accessToken:token}),{code:'FORBIDDEN'});}await fs.link(p.filename,path.join(p.root,'alias.txt'));await assert.rejects(p.make().open(principal,{path:p.filename}),{code:'CONFLICT'});}finally{await p.cleanup();}
});

test('idle streams are bounded, cancellation releases admission and close drains without requiring a reader',async()=>{
  const p=await prepared();try{const service=p.make(),opened=await Promise.all(Array.from({length:4},()=>service.open(principal,{path:p.filename})));await assert.rejects(service.open(principal,{path:p.filename}),{code:'OVERLOADED'});await opened[0]!.stream.cancel();const replacement=await service.open(principal,{path:p.filename});await service.close();for(const value of [...opened.slice(1),replacement])await assert.rejects(new Response(value.stream).text(),{code:'NOT_SUBMITTED'});await assert.rejects(service.open(principal,{path:p.filename}),{code:'NOT_SUBMITTED'});await fs.unlink(p.filename);}finally{await p.cleanup();}
});

test('candidate download HTTP preserves attachment headers and rejects untrusted query shapes',async()=>{
  const p=await prepared();try{const app=new Hono().route('/api/fs',createStoredFileDownloadsRouter({port:p.port,service:p.make()})),url='/api/fs/download?path='+encodeURIComponent(p.filename),headers={cookie:'relay_session=synthetic-download-owner'};
    assert.equal((await app.request(url)).status,401);assert.equal((await app.request(url+'&extra=1',{headers})).status,400);assert.equal((await app.request(url+'&path=foreign',{headers})).status,400);const response=await app.request(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),'5');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('content-disposition'),"attachment; filename*=UTF-8''synthetic.txt");assert.equal(await response.text(),'hello');const missing=await app.request('/api/fs/download?path='+encodeURIComponent(path.join(p.root,'missing.txt')),{headers});assert.equal(missing.status,404);assert.equal((await missing.text()).includes(p.root),false);
    const image=path.join(p.root,'synthetic.png');await fs.writeFile(image,'synthetic');const imageResponse=await app.request('/api/fs/download?path='+encodeURIComponent(image),{headers});assert.equal(imageResponse.headers.get('content-type'),'image/png');assert.equal(await imageResponse.text(),'synthetic');
  }finally{await p.cleanup();}
});

test('request abort and idle timeout release unread streams and their handles',async()=>{
  const p=await prepared();try{const service=p.make({timeoutMs:25}),abort=new AbortController(),opened=await service.open(principal,{path:p.filename},abort.signal);abort.abort();await assert.rejects(new Response(opened.stream).text(),{code:'NOT_SUBMITTED'});
    const idle=await service.open(principal,{path:p.filename});await new Promise(resolve=>setTimeout(resolve,50));await assert.rejects(new Response(idle.stream).text(),{code:'NOT_SUBMITTED'});const next=await service.open(principal,{path:p.filename});await next.stream.cancel();
  }finally{await p.cleanup();}
});
