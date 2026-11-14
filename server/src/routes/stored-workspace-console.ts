import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError,WorkspaceOperationRecordsDtoSchema } from '../contracts/index.js';
import { OperationRecordsService } from '../workspace-console/operation-records.js';
import { ServiceError } from '../services/errors.js';
import { respondServiceError } from './service-error.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { requireEmptyRequestBody } from './empty-request-body.js';
import type { StoredWorkspaceConsole } from '../workspace-console/stored-workspace-console.js';
import type { StoredProviderSnapshots } from '../services/stored-provider-snapshots.js';
import { isAllowedOrigin } from '../security.js';
export function createStoredWorkspaceConsoleRouter(options:{port:CoreStoragePort;service:Pick<StoredWorkspaceConsole,'getDashboard'|'link'>;snapshots?:Pick<StoredProviderSnapshots,'responsibility'>;operations?:Pick<OperationRecordsService,'get'>}){
  options=Object.freeze({...options});const router=new Hono<RelayEnv>(),uuid=z.string().uuid(),task=z.string().trim().min(1).max(128);
  const operations=options.operations??new OperationRecordsService();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});router.use('*',createRequireStoredUserSession(options.port));
  router.use('*',async(c,next)=>{if(c.get('relayActor')?.role!=='admin')return c.json(presentApiError('仅管理员可以操作工作台',{code:'WORKSPACE_CONSOLE_FORBIDDEN'}),403);await next();});
  router.onError((error,c)=>{if(error instanceof ServiceError)return respondServiceError(c,error);const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE',status=code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:code==='INVALID_ARGUMENT'?400:code==='PAYLOAD_TOO_LARGE'?413:code==='CONFLICT'||code==='OPERATION_EXPIRED'?409:503;
    return c.json(presentApiError(status===404?'当前任务或会话不可用':status===403?'没有权限操作工作台':status===400?'工作台请求无效':status===409?'会话或关联状态已变化，请刷新核对':'工作台暂不可用',{code}),status);});
  router.get('/dashboard',async(c)=>{const query=z.object({refresh:z.literal('1').optional()}).strict().safeParse(c.req.query());if(!query.success)throw new StorageContractError('INVALID_ARGUMENT');return c.json(await options.service.getDashboard(c.get('relayStoragePrincipal')!,query.data.refresh==='1'));});
  router.get('/responsibility',async(c)=>{const query=z.object({refresh:z.literal('1').optional(),trigger:z.enum(['open','auto','retry','manual','detail','unknown']).optional()}).strict().safeParse(c.req.query());if(!query.success)throw new StorageContractError('INVALID_ARGUMENT');if(!options.snapshots)throw new StorageContractError('STORAGE_UNAVAILABLE');return c.json(await options.snapshots.responsibility(c.get('relayStoragePrincipal')!,query.data.refresh==='1'));});
  router.get('/operations/:parentId',async c=>{
    const query=z.object({anchor:z.string().min(1),cursor:z.string().max(256).optional(),refresh:z.literal('1').optional()}).strict().safeParse(c.req.query());
    if(!query.success)throw new StorageContractError('INVALID_ARGUMENT');
    return c.json(WorkspaceOperationRecordsDtoSchema.parse(await operations.get(c.get('relayActor'),c.req.param('parentId'),query.data.anchor,query.data.cursor??null,query.data.refresh==='1')));
  });
  router.post('/tasks/:taskId/sessions',async(c)=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const id=task.safeParse(c.req.param('taskId')),key=uuid.safeParse(c.req.header('x-relay-operation-id'));if(!id.success||!key.success||Object.keys(c.req.query()).length)throw new StorageContractError('INVALID_ARGUMENT');
    c.header('x-relay-operation-id',key.data.toLowerCase());const reader=c.req.raw.body?.getReader();if(!reader)throw new StorageContractError('INVALID_ARGUMENT');const bytes=new Uint8Array(1024);let size=0;
    try{for(;;){const next=await reader.read();if(next.done)break;if(size+next.value.byteLength>1024){void reader.cancel().catch(()=>undefined);throw new StorageContractError('PAYLOAD_TOO_LARGE');}bytes.set(next.value,size);size+=next.value.byteLength;}}finally{reader.releaseLock();}
    let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));}catch{throw new StorageContractError('INVALID_ARGUMENT');}
    const body=z.object({sessionId:uuid}).strict().safeParse(raw);if(!body.success)throw new StorageContractError('INVALID_ARGUMENT');
    return c.json(await options.service.link(c.get('relayStoragePrincipal')!,id.data,body.data.sessionId,key.data.toLowerCase(),true));
  });
  router.delete('/tasks/:taskId/sessions/:sessionId',async(c)=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const id=task.safeParse(c.req.param('taskId')),session=uuid.safeParse(c.req.param('sessionId')),key=uuid.safeParse(c.req.header('x-relay-operation-id'));
    if(!id.success||!session.success||!key.success||Object.keys(c.req.query()).length)throw new StorageContractError('INVALID_ARGUMENT');
    await requireEmptyRequestBody(c.req.raw);c.header('x-relay-operation-id',key.data.toLowerCase());
    return c.json(await options.service.link(c.get('relayStoragePrincipal')!,id.data,session.data,key.data.toLowerCase(),false));
  });return router;
}
