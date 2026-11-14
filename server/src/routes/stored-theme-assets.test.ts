import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createStoredThemeAssetsRouter } from './stored-theme-assets.js';
import { themeAssetsFixture,actor,owner,other,token,webp,gate } from '../theme/theme-assets-fixture.test-support.js';
import type { StoredThemeAssets,ThemeAssetOutcome } from '../services/stored-theme-assets.js';
const prefix='/api/auth/theme-assets';
function headers(id=owner,key:string|null=randomUUID(),origin:string|null=null){const result=new Headers({cookie:`relay_session=${token(id)}`});if(key!==null)result.set('x-relay-operation-id',key);if(origin!==null)result.set('origin',origin);return result;}
function form(extra=false){const data=new FormData();data.append('desktop',new Blob([webp()],{type:'image/webp'}),'desktop.webp');data.append('mobile',new Blob([webp(12,16)],{type:'image/webp'}),'mobile.webp');if(extra)data.append('userId','injected');return data;}
function app(p:Awaited<ReturnType<typeof themeAssetsFixture>>,service:Pick<StoredThemeAssets,'upload'|'delete'|'read'>=p.make()){return new Hono().route(prefix,createStoredThemeAssetsRouter({port:p.port,service}));}

test('candidate HTTP uploads, reads both variants and deletes with exact retained operation keys',async()=>{
  const p=await themeAssetsFixture();try{const server=app(p),key=randomUUID();
    const upload=await server.request(prefix,{method:'POST',headers:headers(owner,key),body:form()});assert.equal(upload.status,201);assert.equal(upload.headers.get('x-relay-operation-id'),key);
    const {assetId}=await upload.json() as {assetId:string};assert.ok(assetId);assert.equal((await server.request(prefix,{method:'POST',headers:headers(owner,key),body:form()})).status,201);
    for(const variant of ['desktop','mobile']){const response=await server.request(`${prefix}/${assetId}/${variant}`,{headers:headers()});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/webp');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),variant==='desktop'?new Uint8Array(webp()):new Uint8Array(webp(12,16)));}
    assert.equal((await server.request(`${prefix}/${assetId}/desktop`,{headers:headers(other)})).status,404);
    const remove=randomUUID();assert.equal((await server.request(`${prefix}/${assetId}`,{method:'DELETE',headers:headers(owner,remove)})).status,200);
    assert.equal((await server.request(`${prefix}/${assetId}`,{method:'DELETE',headers:headers(owner,remove)})).status,200);assert.equal((await server.request(`${prefix}/${assetId}/desktop`,{headers:headers()})).status,404);
  }finally{await p.cleanup();}
});
test('HTTP authentication, Origin, operation keys and strict multipart scope precede coordination',async()=>{
  const p=await themeAssetsFixture();let calls=0;try{const fake:Pick<StoredThemeAssets,'upload'|'delete'|'read'>={upload:async()=>{calls++;return{state:'unknown'};},delete:async()=>{calls++;return{state:'unknown'};},read:async()=>null};const server=app(p,fake);
    assert.equal((await server.request(prefix,{method:'POST',body:form()})).status,401);
    assert.equal((await server.request(prefix,{method:'POST',headers:headers(owner,randomUUID(),'https://hostile.invalid'),body:form()})).status,403);
    assert.equal((await server.request(prefix,{method:'POST',headers:headers(owner,null),body:form()})).status,400);
    assert.equal((await server.request(prefix,{method:'POST',headers:headers(owner,'bad'),body:form()})).status,400);
    assert.equal((await server.request(prefix+'?path=injected',{method:'POST',headers:headers(),body:form()})).status,400);
    assert.equal((await server.request(prefix,{method:'POST',headers:headers(),body:form(true)})).status,400);
    const duplicate=form();duplicate.append('desktop',new Blob([webp()]),'extra.webp');assert.equal((await server.request(prefix,{method:'POST',headers:headers(),body:duplicate})).status,400);
    assert.equal(calls,0);
  }finally{await p.cleanup();}
});
test('actual body and per-file budgets reject oversized requests even with misleading Content-Length',async()=>{
  const p=await themeAssetsFixture();let calls=0;try{const server=app(p,{upload:async()=>{calls++;return{state:'unknown'};},delete:async()=>({state:'unknown'}),read:async()=>null});
    const data=new FormData();data.append('desktop',new Blob([new Uint8Array(4194305)]),'large.webp');data.append('mobile',new Blob([webp()]),'mobile.webp');assert.equal((await server.request(prefix,{method:'POST',headers:headers(),body:data})).status,413);
    const h=headers();h.set('content-type','multipart/form-data; boundary=synthetic');h.set('content-length','1');assert.equal((await server.request(prefix,{method:'POST',headers:h,body:new Uint8Array(2*4194304+65537)})).status,413);assert.equal(calls,0);
  }finally{await p.cleanup();}
});
test('unknown and committed cleanup pending never report upload or deletion as complete',async()=>{
  const p=await themeAssetsFixture();let value:ThemeAssetOutcome={state:'unknown'};try{const id=randomUUID(),server=app(p,{upload:async()=>value,delete:async()=>value,read:async()=>null});
    for(const outcome of [{state:'unknown'},{state:'committed',assetId:id,cleanupPending:true}] as ThemeAssetOutcome[]){value=outcome;
      const response=await server.request(prefix,{method:'POST',headers:headers(),body:form()});assert.equal(response.status,503);assert.ok(['THEME_ASSET_RESULT_UNKNOWN','THEME_ASSET_CLEANUP_PENDING'].includes((await response.json() as any).code));
      assert.equal((await server.request(`${prefix}/${id}`,{method:'DELETE',headers:headers()})).status,503);
    }
    value={state:'rejected',code:'CONFLICT'};assert.equal((await server.request(`${prefix}/${id}`,{method:'DELETE',headers:headers()})).status,409);
  }finally{await p.cleanup();}
});
test('HTTP errors hide provider paths and read requests validate variant and query scope',async()=>{
  const p=await themeAssetsFixture();try{const id=randomUUID(),server=app(p,{upload:async()=>{throw new Error('private-directory-and-token');},delete:async()=>({state:'unknown'}),read:async()=>null});
    const failed=await server.request(prefix,{method:'POST',headers:headers(),body:form()});assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('private-directory'));
    assert.equal((await server.request(`${prefix}/${id}/invalid`,{headers:headers()})).status,400);assert.equal((await server.request(`${prefix}/${id}/desktop?userId=other`,{headers:headers()})).status,400);
    assert.equal((await server.request(`${prefix}/${id}`,{method:'DELETE',headers:headers(),body:'{}'})).status,400);
  }finally{await p.cleanup();}
});
test('login revoked after multipart read cannot register an asset or start file I/O',async()=>{
  const p=await themeAssetsFixture();try{const server=app(p),original=new Request('http://localhost'+prefix,{method:'POST',body:form()}),body=new Uint8Array(await original.arrayBuffer());let sent=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){if(!sent){sent=true;p.f.mutate(`UPDATE users SET disabled_at=1 WHERE id='${owner}'`);controller.enqueue(body);}else controller.close();}});
    const h=headers();h.set('content-type',original.headers.get('content-type')!);
    const response=await server.request(new Request('http://localhost'+prefix,{method:'POST',headers:h,body:stream,duplex:'half'} as RequestInit));assert.ok([401,404].includes(response.status));assert.equal(p.f.scalar('SELECT count(*) FROM _relay_theme_asset_jobs'),0);
  }finally{await p.cleanup();}
});
test('stalled multipart input times out before coordination and releases its receiving slot',async()=>{
  const p=await themeAssetsFixture();try{let calls=0;const service:Pick<StoredThemeAssets,'upload'|'delete'|'read'>={upload:async()=>{calls++;return{state:'unknown'};},delete:async()=>({state:'unknown'}),read:async()=>null};
    const server=new Hono().route(prefix,createStoredThemeAssetsRouter({port:p.port,service,bodyTimeoutMs:20})),h=headers();h.set('content-type','multipart/form-data; boundary=synthetic');
    const stream=new ReadableStream<Uint8Array>({pull(){return new Promise<void>(()=>{});}});
    const result=await server.request(new Request('http://localhost'+prefix,{method:'POST',headers:h,body:stream,duplex:'half'} as RequestInit));assert.equal(result.status,503);assert.equal((await result.json() as any).code,'NOT_SUBMITTED');assert.equal(calls,0);
    const normal=await server.request(prefix,{method:'POST',headers:headers(),body:form()});assert.equal(normal.status,503);assert.equal(calls,1);
  }finally{await p.cleanup();}
});
