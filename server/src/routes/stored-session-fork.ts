import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError, SessionUpdateResponseDtoSchema } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredSessionForkService } from '../services/stored-session-fork.js';
export function createStoredSessionForkRouter(options: { port: CoreStoragePort; service: StoredSessionForkService; assertNotDeleting: (sessionId:string)=>void }) {
  options=Object.freeze({...options});const router=new Hono<RelayEnv>(),uuid=z.string().uuid();
  const body=z.object({messageId:uuid.optional()}).strict();
  router.use('/sessions/:id/fork',createRequireStoredUserSession(options.port));
  router.onError((error,c)=>{
    const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';
    const status=code==='INVALID_ARGUMENT'?400:code==='FORBIDDEN'||code==='NOT_FOUND'?404:code==='CONFLICT'||code==='OPERATION_EXPIRED'?409:503;
    return c.json(presentApiError(status===404?'会话不存在或没有操作权限':status===409?'来源会话已变化，请刷新核对':'创建分支暂不可用',{code}),status);
  });
  router.post('/sessions/:id/fork',async(c)=>{
    c.header('cache-control','private, no-store');
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const id=uuid.safeParse(c.req.param('id')),key=uuid.safeParse(c.req.header('x-relay-operation-id')??randomUUID());
    const parsed=body.safeParse(await c.req.json().catch(()=>null));
    if(!id.success||!key.success||!parsed.success)return c.json(presentApiError('无效的会话、操作标识或分支参数'),400);
    c.header('x-relay-operation-id',key.data);options.assertNotDeleting(id.data);
    const result=await options.service.run(c.get('relayStoragePrincipal')!,id.data,parsed.data.messageId??null,key.data);
    if(result.state==='unknown')return c.json(presentApiError('分支结果暂时无法确认，请稍后刷新核对',{code:'EXTERNAL_RESULT_UNKNOWN'}),503);
    if(!result.session)return c.json(presentApiError('分支已保存，当前状态暂不可用',{code:'RESOURCE_STATE_UNAVAILABLE'}),503);
    return c.json(SessionUpdateResponseDtoSchema.parse({ok:true,session:result.session}),201);
  });return router;
}
