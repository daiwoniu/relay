import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createHostingPublicRouter } from '../page-hosting/routes.js';

test('托管仅统计最终HTML GET，重定向/HEAD/脚本/预览不计，观察失败不影响交付',async()=>{
  const observed:string[]=[];
  const service={open:async(_id:string,requested:string)=>({filename:requested||'index.html',entry:'index.html',siteId:'internal-site',size:2,stream:new Blob(['ok']).stream()})};
  const app=new Hono().route('/p',createHostingPublicRouter(service as any,(_c,id)=>observed.push(id)))
    .route('/p-preview',createHostingPublicRouter(service as any,(_c,id)=>observed.push(id)));
  assert.equal((await app.request('/p/short')).status,302);assert.equal(observed.length,0);
  assert.equal(await (await app.request('/p/short/index.html')).text(),'ok');assert.deepEqual(observed,['internal-site']);
  assert.equal((await app.request('/p/short/index.html',{method:'HEAD'})).status,200);
  await (await app.request('/p/short/app.js')).text();
  await (await app.request(`/p-preview/upload/${'a'.repeat(64)}/index.html`)).text();
  assert.equal(observed.length,1);
  const failed=new Hono().route('/p',createHostingPublicRouter(service as any,()=>{throw Error('statistics-down');}));
  assert.equal(await (await failed.request('/p/short/index.html')).text(),'ok');
});
