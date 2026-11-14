import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredSend } from './stored-send.js';
import { StoredFollowups } from './stored-followups.js';
import type { StoredRuntimeGraph } from '../ws/stored-runtime-graph.js';
import type { EngineRegistry } from '../engine/registry.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { SendCommand } from '../contracts/index.js';

test('Native send receipt survives restart and rejects changed intent without promoting attachments or enqueueing twice',async()=>{
  const f=fixture(),sessionId=randomUUID();f.mutate('DELETE FROM engine_resource_leases');
  let port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':1}});
  const actor={kind:'user',userId:'owner',authSessionHash:'auth-owner'} as const;
  const origin={senderUserId:'owner',senderUsername:'owner',senderDisplayName:'owner',ip:'local',receivedAt:1};
  let promotions=0,published=0,drains=0;
  const catalogOptions:unknown[]=[];
  let sender:StoredSend|undefined,followups:StoredFollowups|undefined;
  function services(generation:number){
    followups=new StoredFollowups(port,{storeId:'store',generation,assertExclusiveWriter:async()=>{},getBinding:()=>undefined,enqueue:async()=>{throw Error('unexpected idle followup');},changed:async()=>{},diagnostic:()=>{}});
    const graph={followups,hub:{broadcastMessage:async()=>{published++;return{sent:0,failed:0};}},refresh:async()=>{},scheduler:{drain:async()=>{drains++;}}} as unknown as StoredRuntimeGraph;
    return new StoredSend({port,storeId:'store',generation,graph,attachments:{prepare:async(_actor,_project,_message,items)=>{promotions++;return items.map(item=>{if(item.kind!=='host_file')throw Error('unsupported fixture');const{accessToken:_,...authorized}=item;return authorized;});}},
      registry:{get:()=>({availability:{getCurrent:()=>({available:true})},concurrency:{resolveResource:()=>({resourceKey:'codex:default'})}})} as unknown as Pick<EngineRegistry,'get'>,
      getCatalog:async(_engine,options)=>{catalogOptions.push(options);return{models:[]} as unknown as EngineModelCatalog;},assertExclusiveWriter:async()=>{},assertAdmission:async()=>{},attachmentAvailability:()=>false,validateAsyncQuestion:async()=>{},workspaceTaskLink:async()=>undefined});
  }
  try{
    const created=await port.execute({...markRead(),operationId:'session',command:{name:'session.create',input:{sessionId,projectId:'project',title:'Send',engine:null}}});assert.equal(created.state,'committed');
    sender=services(1);const token=randomUUID(),message:SendCommand={type:'send',sessionId,messageId:randomUUID(),engine:'codex',content:'question',attachments:[{kind:'host_file',id:randomUUID(),name:'fixture.txt',path:'D:/synthetic/fixture.txt',size:1,accessToken:token}]};
    assert.deepEqual(await sender.send(actor,message,origin),{kind:'turn',replayed:false});
    assert.deepEqual(await sender.send(actor,message,{...origin,receivedAt:2}),{kind:'turn',replayed:true});
    assert.equal(promotions,1);assert.equal(published,1);assert.equal(drains,1);
    assert.deepEqual(catalogOptions,[{preferCached:true}]);
    assert.equal(f.scalar(`SELECT count(*) FROM engine_queue_entries WHERE session_id='${sessionId}'`),1);
    assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE metadata LIKE '%${token}%'`),0);
    assert.equal(f.scalar(`SELECT count(*) FROM _relay_storage_operations WHERE result_json LIKE '%${token}%'`),0);
    await sender.close();await followups!.close();await port.close();port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:2});sender=services(2);
    assert.deepEqual(await sender.send(actor,{...message,attachments:[{...message.attachments![0]!,accessToken:randomUUID()} as any]},{...origin,receivedAt:3}),{kind:'turn',replayed:true});
    await assert.rejects(sender.send(actor,{...message,content:'changed'},origin),/CONFLICT/);assert.equal(promotions,1);
    const followup={...message,messageId:randomUUID(),content:'followup',attachments:[]};
    assert.deepEqual(await sender.send(actor,followup,origin),{kind:'followup',replayed:false});
    assert.deepEqual(await sender.send(actor,followup,{...origin,receivedAt:4}),{kind:'followup',replayed:true});
    assert.equal(f.scalar(`SELECT count(*) FROM session_followups WHERE session_id='${sessionId}'`),1);
    assert.equal(f.scalar(`SELECT count(*) FROM _relay_send_intents WHERE session_id='${sessionId}'`),2);
  }finally{await sender?.close();await followups?.close();await port.close();f.cleanup();}
});
