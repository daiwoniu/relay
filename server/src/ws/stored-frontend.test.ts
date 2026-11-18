import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredRuntimeGraph } from './stored-runtime-graph.js';
import { StoredSend } from '../services/stored-send.js';
import { StoredFrontendCommands } from './stored-frontend-commands.js';
import { setupStoredWebSocket } from './stored-frontend.js';
import { EngineRegistry } from '../engine/registry.js';
import type { EngineAdapter } from '../engine/adapter.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import { hashSessionToken } from '../auth/session.js';
import type { StoredRuntimeStop } from '../services/stored-runtime-stop.js';
const until=async(check:()=>boolean)=>{for(let n=0;n<500&&!check();n++)await new Promise(r=>setTimeout(r,5));assert.ok(check(),'Native socket stage timed out');};
class Socket extends EventEmitter{
  readyState=1;bufferedAmount=0;messages:any[]=[];code:number|null=null;
  send(raw:string,callback:(error?:Error)=>void){this.messages.push(JSON.parse(raw));callback();}
  close(code:number){if(this.readyState!==1)return;this.code=code;this.readyState=3;this.emit('close',code);}
  command(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)),false);}
}

test('opaque hosted-page origins cannot open a socket even when an origin override is permissive',async()=>{
  const wss=new EventEmitter();let authenticated=false;
  const sockets=setupStoredWebSocket(wss as unknown as WebSocketServer,{port:{authenticateSession:async()=>{authenticated=true;return null;}} as any,graph:{} as any,commands:{} as any,acceptsOrigin:()=>true});
  try{
    const socket=new Socket();wss.emit('connection',socket,{headers:{origin:'null',cookie:'relay_session=synthetic'},socket:{remoteAddress:'127.0.0.1'}});
    assert.equal(socket.code,1008);assert.equal(authenticated,false);assert.deepEqual(socket.messages,[]);
  }finally{await sockets.close();}
});

test('Native socket reports uncertain and rejected stops without fabricating a terminal',async(t)=>{
  const f=fixture(),sessionId=randomUUID(),token='synthetic-stop-feedback',tokenHash=hashSessionToken(token);
  f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${tokenHash}','owner',${Date.now()+600000});
    INSERT INTO sessions(id,owner_user_id,active_attempt_id,message_revision,engine,project_id,status) VALUES('${sessionId}','owner','feedback-attempt',0,'codex','project','processing');
    INSERT INTO engine_resource_leases VALUES('feedback-attempt','${sessionId}','feedback-lease','running','codex','codex:default',1,1)`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const graph=new StoredRuntimeGraph({port,storeId:'store',generation:1,registry:new EngineRegistry([]),assertExclusiveWriter:async()=>{},collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>null,diagnostic:()=>{}});
  const commands=new StoredFrontendCommands({port,storeId:'store',generation:1,graph,sender:undefined!,assertExclusiveWriter:async()=>{}}),wss=new EventEmitter();
  const sockets=setupStoredWebSocket(wss as unknown as WebSocketServer,{port,graph,commands,acceptsOrigin:()=>true});
  let result:Awaited<ReturnType<StoredRuntimeStop['request']>>={state:'unknown'};
  t.mock.method(graph.stop,'request',async()=>result);
  try{
    for(const code of ['STORAGE_UNAVAILABLE','FORBIDDEN','CONFLICT'] as const){
      result=code==='STORAGE_UNAVAILABLE'?{state:'unknown'}:{state:'rejected',code};
      const socket=new Socket();wss.emit('connection',socket,{headers:{cookie:`relay_session=${token}`},socket:{remoteAddress:'127.0.0.1'}});
      socket.command({type:'cancel',sessionId});
      await until(()=>socket.messages.some(event=>event.type==='error'&&event.sessionId===sessionId));
      const error=socket.messages.find(event=>event.type==='error'&&event.sessionId===sessionId);
      assert.equal(error.code,`TURN_CANCEL_${code}`);
      if(code==='STORAGE_UNAVAILABLE')assert.match(error.message,/停止结果暂时无法确认/);
      socket.close(1000);
    }
    assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${sessionId}'`),'processing');
    assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${sessionId}'`),0);
    assert.equal(f.scalar(`SELECT count(*) FROM engine_resource_leases WHERE session_id='${sessionId}'`),1);
  }finally{await sockets.close();await commands.close();await graph.close();await port.close();f.cleanup();}
});

test('Native socket serializes commands during authentication, preserves queued work on disconnect and cancels only on an explicit command',async()=>{
  const f=fixture(),sessionId=randomUUID(),token='synthetic-native-socket',tokenHash=hashSessionToken(token);
  f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${tokenHash}','owner',${Date.now()+600000})`);
  // The fixture's existing running lease occupies the resource; no engine starts during this test.
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':1}});
  const registry=new EngineRegistry([{id:'codex',availability:{getCurrent:()=>({available:true})},concurrency:{resolveResource:()=>({resourceKey:'codex:default'})},runtime:{connect:()=>{throw Error('queued work must not start');}}} as unknown as EngineAdapter]);
  const graph=new StoredRuntimeGraph({port,storeId:'store',generation:1,registry,assertExclusiveWriter:async()=>{},collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>({label:'Synthetic',defaultMaxActiveTurns:1}),diagnostic:()=>{}});
  const sender=new StoredSend({port,storeId:'store',generation:1,graph,attachments:{prepare:async()=>[]},registry,getCatalog:async()=>({models:[]} as unknown as EngineModelCatalog),assertExclusiveWriter:async()=>{},assertAdmission:async()=>{},attachmentAvailability:()=>false,validateAsyncQuestion:async()=>{},workspaceTaskLink:async()=>undefined});
  const commands=new StoredFrontendCommands({port,storeId:'store',generation:1,graph,sender,assertExclusiveWriter:async()=>{}}),wss=new EventEmitter();
  const sockets=setupStoredWebSocket(wss as unknown as WebSocketServer,{port,graph,commands,acceptsOrigin:()=>true});
  const request={headers:{cookie:`relay_session=${token}`},socket:{remoteAddress:'127.0.0.1'}} as IncomingMessage;
  try{
    const created=await port.execute({...markRead(),operationId:'socket-session',command:{name:'session.create',input:{sessionId,projectId:'project',title:'Socket',engine:null}}});assert.equal(created.state,'committed');
    const socket=new Socket();wss.emit('connection',socket,request);
    socket.command({type:'subscribe',sessionId});const messageId=randomUUID();socket.command({type:'send',sessionId,messageId,engine:'codex',content:'queued question'});
    await until(()=>socket.messages.some(event=>event.type==='message_saved'&&event.message.id===messageId));
    assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${sessionId}'`),'queued');socket.close(1000);
    assert.equal(f.scalar(`SELECT state FROM engine_queue_entries WHERE session_id='${sessionId}'`),'queued');
    const next=new Socket();wss.emit('connection',next,request);next.command({type:'subscribe',sessionId});next.command({type:'cancel'});
    await until(()=>next.messages.some(event=>event.type==='sync_state'&&event.messages.some((message:any)=>message.role==='assistant'&&message.stopped)));
    assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${sessionId}'`),'stopped');
    assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='user'`),1);
    assert.equal(graph.runtimes.size,0);
    const denied=new Socket();wss.emit('connection',denied,{headers:{},socket:{remoteAddress:'127.0.0.1'}});denied.command({type:'send',sessionId,messageId:randomUUID(),engine:'codex',content:'forbidden'});
    await until(()=>denied.code===1008);assert.equal(denied.messages.length,0);
    const overloaded=new Socket();wss.emit('connection',overloaded,request);overloaded.emit('message',Buffer.alloc(512*1024+1),false);assert.equal(overloaded.code,1009);
  }finally{await sockets.close();await commands.close();await sender.close();await graph.close();await port.close();f.cleanup();}
});
