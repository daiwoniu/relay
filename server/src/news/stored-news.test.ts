import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoreOwner } from '../storage/store-owner.js';
import { StoredNews } from './stored-news.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { hashSessionToken } from '../auth/session.js';
const ownerPrincipal={kind:'user' as const,userId:'owner',authSessionHash:hashSessionToken('synthetic-news-owner')},admin={kind:'user' as const,userId:'admin',authSessionHash:hashSessionToken('synthetic-news-admin')};
const source=(id:string)=>({id,name:'Synthetic source',kind:'rss_atom',url:'https://example.org/feed.xml',allowedHosts:['example.org'],enabled:false,intervalMinutes:60,categoryId:'research'});
const request=(url:string,method='GET',body?:unknown)=>new Request('http://native-news.invalid'+url,{method,...(body?{body:JSON.stringify(body),headers:{'content-type':'application/json'}}:{})});
async function prepared(extra:Partial<ConstructorParameters<typeof StoredNews>[0]>={}){
  process.env.RELAY_ACCESS_TOKEN='synthetic-native-news';const f=fixture();
  f.mutate(`UPDATE auth_sessions SET token_hash='${ownerPrincipal.authSessionHash}' WHERE user_id='owner';UPDATE auth_sessions SET token_hash='${admin.authSessionHash}' WHERE user_id='admin'`);
  const owner=await StoreOwner.acquire(f.filename),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,beforeDispatch:()=>owner.assertCurrent()});
  let beforeRead:(()=>void|Promise<void>)|undefined;
  const bridge:Pick<CoreStoragePort,'readFrontendAccess'>={readFrontendAccess:async input=>{await beforeRead?.();return port.readFrontendAccess(input);}};
  const options={port:bridge,root:path.join(f.directory,'news'),writerProof:owner.writerProof,assertExclusiveWriter:()=>owner.assertCurrent(),sources:[],initialize:true,...extra};
  const service=new StoredNews(options);
  return{f,owner,port,options,service,setBeforeRead:(hook:typeof beforeRead)=>{beforeRead=hook;},cleanup:async()=>{await service.close();await port.close();await owner.release();f.cleanup();}};
}

test('owned news Worker initializes only on activation, serves native HTTP, and rechecks a downgraded admin after request parsing',async()=>{
  const p=await prepared();
  try{
    await assert.rejects(fs.stat(p.options.root),{code:'ENOENT'});await p.service.initialize();await p.service.resume();
    const publicVersion=await p.service.request(null,request('/api/public/news/version'),'synthetic-client');assert.equal(publicVersion.status,200);assert.equal((await publicVersion.json() as any).version,0);
    await assert.rejects(p.service.request(ownerPrincipal,request('/api/admin/news/stats'),'member'),{code:'FORBIDDEN'});
    const preferences=await p.service.request(ownerPrincipal,request('/api/news/preferences','PUT',{rules:[]}),'member');assert.equal(preferences.status,200);
    const created=await p.service.request(admin,request('/api/admin/news/sources','POST',source('source-first')),'admin');assert.equal(created.status,200);
    let reads=0;p.setBeforeRead(()=>{if(++reads===3)p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");});
    await assert.rejects(p.service.request(admin,request('/api/admin/news/sources','POST',source('source-revoked')),'admin'),{code:'FORBIDDEN'});
    p.setBeforeRead(undefined);p.f.mutate("UPDATE users SET role='admin' WHERE id='admin'");
    const listing=await p.service.request(admin,request('/api/admin/news/sources'),'admin'),body=await listing.json() as any;
    assert.deepEqual(body.sources.map((value:any)=>value.id),['source-first']);
  }finally{await p.cleanup();}
});

test('news deadline retains accepted HTTP and auth work; close waits for its real commit before retiring the Worker',async()=>{
  const p=await prepared({timeoutMs:250});let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),atGate=new Promise<void>(resolve=>{entered=resolve;});
  try{
    await p.service.initialize();let reads=0;p.setBeforeRead(async()=>{if(++reads===3){entered();await gate;}});
    const sending=p.service.request(admin,request('/api/admin/news/sources','POST',source('source-delayed')),'admin');
    const failed=assert.rejects(sending,/NEWS_OUTCOME_UNKNOWN/);let timer:NodeJS.Timeout|undefined;
    try{await Promise.race([atGate,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('authorization gate not reached')),3000);})]);}finally{clearTimeout(timer);}await failed;
    let closed=false;const closing=p.service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
    await assert.rejects(p.service.request(admin,request('/api/admin/news/stats'),'admin'),{code:'NOT_SUBMITTED'});
    release();await closing;p.setBeforeRead(undefined);
    const reopened=new StoredNews({...p.options,port:p.port,timeoutMs:1000,initialize:false});
    try{await reopened.initialize();const listing=await reopened.request(admin,request('/api/admin/news/sources'),'admin');assert.deepEqual((await listing.json() as any).sources.map((value:any)=>value.id),['source-delayed']);}
    finally{await reopened.close();}
  }finally{release();await p.cleanup();}
});

test('news bounds body admission and a stalled body is cancelled before submission',async()=>{
  const p=await prepared({bodyTimeoutMs:20});
  try{
    await p.service.initialize();
    const large=new Request('http://native-news.invalid/api/news/preferences',{method:'PUT',body:'x'.repeat(2*1024*1024+1)});
    await assert.rejects(p.service.request(ownerPrincipal,large,'member'),{code:'PAYLOAD_TOO_LARGE'});
    let cancelled=false;const stream=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
    const stalled=new Request('http://native-news.invalid/api/news/preferences',{method:'PUT',body:stream,duplex:'half'} as RequestInit);
    await assert.rejects(p.service.request(ownerPrincipal,stalled,'member'),{code:'NOT_SUBMITTED'});assert.equal(cancelled,true);
    const normal=await p.service.request(ownerPrincipal,request('/api/news/preferences'),'member');assert.equal(normal.status,200);
  }finally{await p.cleanup();}
});

test('the news Worker independently fences file writes against the application ownership proof',async()=>{
  const p=await prepared({assertExclusiveWriter:async()=>{}}),ownerFile=p.owner.writerProof.ownerFile,original=await fs.readFile(ownerFile,'utf8');
  try{
    await p.service.initialize();const altered={...JSON.parse(original),nonce:randomUUID()};await fs.writeFile(ownerFile,JSON.stringify(altered));
    await assert.rejects(p.service.request(null,request('/api/public/news/version'),'anonymous'),{code:'STORAGE_UNAVAILABLE'});
    await p.service.close();
  }finally{await fs.writeFile(ownerFile,original);await p.cleanup();}
});
