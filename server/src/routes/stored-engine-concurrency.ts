import { randomUUID,createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { EngineConcurrencyDtoSchema,presentApiError,type EngineId } from '../contracts/index.js';
import type { CoreStoragePort,StoragePrincipal } from '../storage/contracts.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { isAllowedOrigin } from '../security.js';

export interface StoredConcurrencyOptions {
  port:CoreStoragePort;storeId:string;generation:number;
  resources:ReadonlyArray<{resourceKey:string;engineId:EngineId;label:string}>;
  changed:(resourceKey:string)=>Promise<void>;
  cancelled:(sessionId:string)=>Promise<void>;
}
export function createStoredEngineConcurrencyRouter(options:StoredConcurrencyOptions){
  const resources=options.resources.map(value=>({...value}));
  if(resources.length>16||new Set(resources.map(value=>value.resourceKey)).size!==resources.length)throw new Error('NATIVE_CONCURRENCY_CONFIGURATION_INVALID');
  const router=new Hono<RelayEnv>(),requireUser=createRequireStoredUserSession(options.port);
  router.use('/engine-concurrency',requireUser);router.use('/engine-concurrency/:resourceKey',requireUser);
  router.use('/sessions/:sessionId/queued-turn/cancel',requireUser);
  const snapshot=async(principal:Extract<StoragePrincipal,{kind:'user'}>,resource:typeof resources[number])=>EngineConcurrencyDtoSchema.parse({...await options.port.readConcurrency({principal,resourceKey:resource.resourceKey}),engineId:resource.engineId,label:resource.label});
  router.get('/engine-concurrency',async c=>c.json(await Promise.all(resources.map(resource=>snapshot(c.get('relayStoragePrincipal')!,resource)))));
  router.patch('/engine-concurrency/:resourceKey',async c=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const resource=resources.find(value=>value.resourceKey===c.req.param('resourceKey'));
    if(!resource)return c.json(presentApiError('未知引擎并发资源'),404);
    const body=z.object({maxActiveTurns:z.number().int().min(1).max(32)}).strict().safeParse(await c.req.json().catch(()=>null));
    const key=z.string().uuid().safeParse(c.req.header('x-relay-operation-id')??randomUUID());
    if(!body.success||!key.success)return c.json(presentApiError('引擎并发设置格式无效'),400);
    c.header('x-relay-operation-id',key.data);const principal=c.get('relayStoragePrincipal')!;
    const result=await executeStoredCommand(options.port,{protocolVersion:1,storeId:options.storeId,workerGeneration:options.generation,
      requestId:randomUUID(),operationId:`concurrency:${key.data}`,principal,command:{name:'concurrency.set',input:{resourceKey:resource.resourceKey,engineId:resource.engineId,maxActiveTurns:body.data.maxActiveTurns}}});
    if(result.state==='unknown')return c.json(presentApiError('设置结果暂时无法确认',{code:'STORAGE_RESULT_UNKNOWN'}),503);
    if(result.state==='rejected')return c.json(presentApiError('并发设置未保存',{code:result.code}),result.code==='FORBIDDEN'?403:result.code==='CONFLICT'?409:503);
    const current=await snapshot(principal,resource);await options.changed(resource.resourceKey).catch(()=>undefined);return c.json(current);
  });
  router.post('/sessions/:sessionId/queued-turn/cancel',async c=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const id=z.string().uuid().safeParse(c.req.param('sessionId'));if(!id.success)return c.json(presentApiError('会话编号无效'),400);
    const principal=c.get('relayStoragePrincipal')!,state=await options.port.readSessionSync({principal,sessionId:id.data,includeMessages:false});
    if(state.queue?.state!=='queued'||!state.activeAttemptId)return c.json(presentApiError('排队回合不存在'),404);
    const key=createHash('sha256').update(JSON.stringify([principal.userId,id.data,state.activeAttemptId])).digest('hex');
    const result=await executeStoredCommand(options.port,{protocolVersion:1,storeId:options.storeId,workerGeneration:options.generation,
      requestId:randomUUID(),operationId:'frontend-queue-cancel:'+key,principal,command:{name:'queue.cancel',input:{sessionId:id.data,expectedAttemptId:state.activeAttemptId,messageId:'queue-cancel:'+key}}});
    if(result.state!=='committed')throw new StorageContractError(result.state==='rejected'?result.code:'STORAGE_UNAVAILABLE');
    await options.cancelled(id.data);return c.json({ok:true});
  });return router;
}
