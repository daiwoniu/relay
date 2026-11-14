import type { IncomingMessage } from 'node:http';
import type { WebSocketServer,WebSocket,RawData } from 'ws';
import { authenticateStoredSession } from '../auth/stored-session.js';
import { getSessionTokenFromCookieHeader } from '../auth/cookie.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { FrontendCommandSchema } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import { createFrontendOriginContext } from '../message-origin.js';
import type { FrontendClient } from './frontend-client-hub.js';
import type { StoredRuntimeGraph } from './stored-runtime-graph.js';
import type { StoredFrontendCommands } from './stored-frontend-commands.js';

interface SocketState {socket:WebSocket;client?:FrontendClient;alive:boolean;pending:number;bytes:number;tail:Promise<unknown>}
/** Actual ws connection/message boundaries. Disconnects remove subscriptions, never cancel engine tasks. */
export function setupStoredWebSocket(wss:WebSocketServer,options:{port:CoreStoragePort;graph:StoredRuntimeGraph;commands:StoredFrontendCommands;
  ready?:()=>boolean;
  acceptsOrigin?:(request:IncomingMessage)=>boolean}){
  const states=new Set<SocketState>();let closed=false;
  const connection=(socket:WebSocket,request:IncomingMessage)=>{
    if(closed||options.ready&&!options.ready()||states.size>=128||!(options.acceptsOrigin?.(request)??isAllowedOrigin(request.headers.origin))){socket.close(1008,'连接不可用');return;}
    const state:SocketState={socket,alive:true,pending:0,bytes:0,tail:Promise.resolve()};states.add(state);
    const detach=()=>{state.alive=false;states.delete(state);if(state.client)options.graph.hub.remove(state.client);};
    socket.on('close',detach);socket.on('error',()=>{detach();try{socket.close(1011,'连接异常');}catch{/* Socket already closed. */}});
    state.tail=Promise.resolve().then(async()=>{
      const auth=await authenticateStoredSession(getSessionTokenFromCookieHeader(request.headers.cookie),options.port);
      if(!state.alive||closed||options.ready&&!options.ready())return;
      if(!auth||auth.user.mustChangePassword){socket.close(1008,'请先完成登录');detach();return;}
      const client:FrontendClient={ws:socket,actor:{userId:auth.user.id,role:auth.user.role},...createFrontendOriginContext(auth.user,request),
        authTokenHash:auth.tokenHash,authExpiresAt:auth.expiresAt,authExpiryTimer:null,activeSubscriptionSessionId:null,subscribedSessionIds:new Set()};
      state.client=client;
      if(!await options.graph.sync.connect(client)){socket.close(1008,'连接不可用');detach();return;}
      if(!state.alive||closed)options.graph.hub.remove(client);
    }).catch(()=>{try{socket.close(1011,'连接暂不可用');}finally{detach();}});
    socket.on('message',(raw:RawData,binary:boolean)=>{
      if(!state.alive||closed||options.ready&&!options.ready())return;
      const bytes=Array.isArray(raw)?raw.reduce((size,part)=>size+part.byteLength,0):raw.byteLength;
      if(binary||bytes>512*1024||state.pending>=32||state.bytes+bytes>2*1024*1024){socket.close(1009,'请求过大或过于频繁');detach();return;}
      const buffer=Array.isArray(raw)?Buffer.concat(raw):Buffer.from(raw as ArrayBuffer);state.pending++;state.bytes+=bytes;
      const run=state.tail.then(async()=>{
        if(!state.alive||closed||options.ready&&!options.ready()||!state.client)return;
        let parsed:ReturnType<typeof FrontendCommandSchema.safeParse>|undefined;
        try{
          try{parsed=FrontendCommandSchema.safeParse(JSON.parse(buffer.toString('utf8')));}catch{throw new StorageContractError('INVALID_ARGUMENT');}
          if(!parsed.success)throw new StorageContractError('INVALID_ARGUMENT');
          await options.commands.handle(state.client,parsed.data);
        }catch(error){await options.commands.failed(state.client,parsed?.success?parsed.data:undefined,error);}
      });
      state.tail=run.catch(()=>{try{socket.close(1011,'连接暂不可用');}finally{detach();}});
      void state.tail.finally(()=>{state.pending--;state.bytes-=bytes;}).catch(()=>{});
    });
  };
  wss.on('connection',connection);
  return{async close(){closed=true;wss.off('connection',connection);const accepted=[...states];for(const state of accepted){state.alive=false;
    if(state.client)options.graph.hub.remove(state.client);try{state.socket.close(1001,'服务正在关闭');}catch{/* Already closed. */}}
    states.clear();await Promise.allSettled(accepted.map(state=>state.tail));}};
}
