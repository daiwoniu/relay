import assert from 'node:assert/strict';
import test from 'node:test';
import { FeishuProjectClient } from './client.js';
import { withFeishuReadBatch } from './read-batch.js';
const config={connectionId:'test',projectKey:'space',userKey:'me',pluginId:'plugin',pluginSecret:'secret',scope:'scope'};
test('one read reuses metadata and overlapping verified details; the next refresh and another connection stay fresh',async()=>{
  const calls:Array<{route:string;ids?:string[]}>=[];
  const transport=(async(url,init)=>{
    const route=String(url).split('/open_api/')[1],body=init?.body?JSON.parse(String(init.body)):{};
    calls.push({route,ids:body.work_item_ids});
    const data=route==='authen/plugin_token'?{token:'test'}:route.endsWith('/meta')?[]:body.work_item_ids.map((id:string)=>({id,project_key:'space',work_item_type_key:'story'}));
    return new Response(JSON.stringify({data}));
  }) as typeof fetch;
  const client=new FeishuProjectClient(config,transport,Date.now,0);
  await withFeishuReadBatch(async()=>{
    await client.metadata('story');await client.metadata('story');
    await client.details('story',['1000000001','1000000002']);
    assert.deepEqual((await client.details('story',['1000000002','1000000003'])).map(row=>row.id),['1000000002','1000000003']);
    await new FeishuProjectClient({...config,userKey:'other'},transport,Date.now,0).details('story',['1000000001']);
  });
  assert.equal(calls.filter(call=>call.route.endsWith('/meta')).length,1);
  assert.deepEqual(calls.filter(call=>call.route.endsWith('/query')).map(call=>call.ids),[['1000000001','1000000002'],['1000000003'],['1000000001']]);
  await withFeishuReadBatch(()=>client.details('story',['1000000001']));
  assert.equal(calls.filter(call=>call.route.endsWith('/query')).length,4);
});
test('failed or invalid reads do not poison retry or become verified detail cache entries',async()=>{
  let attempts=0;
  const client=new FeishuProjectClient(config,(async(url)=>{
    if(String(url).endsWith('authen/plugin_token'))return new Response(JSON.stringify({data:{token:'test'}}));
    attempts++;
    return new Response(JSON.stringify({data:attempts===1?[]:[{id:'1000000001',project_key:'space',work_item_type_key:'story'}]}));
  }) as typeof fetch,Date.now,0);
  await withFeishuReadBatch(async()=>{
    await assert.rejects(client.details('story',['1000000001']),/不完整/);
    await client.details('story',['1000000001']);
  });
  assert.equal(attempts,2);
  let metadataAttempts=0;
  const failing=new FeishuProjectClient(config,(async(url)=>{
    if(String(url).endsWith('authen/plugin_token'))return new Response(JSON.stringify({data:{token:'test'}}));
    return ++metadataAttempts===1?new Response('',{status:500}):new Response(JSON.stringify({data:[]}));
  }) as typeof fetch,Date.now,0);
  await withFeishuReadBatch(async()=>{await assert.rejects(failing.metadata('story'));await failing.metadata('story');});
  assert.equal(metadataAttempts,2);
});
