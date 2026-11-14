import { randomUUID } from 'node:crypto';
import { Hono,type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { CreateShareRequestSchema,presentApiError } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredShares } from '../services/stored-shares.js';
import { PublicShareRateLimiter } from '../shares/public-rate-limit.js';
export function createStoredSharesRouter(options:{port:CoreStoragePort;service:StoredShares}){
  options=Object.freeze({...options});const router=new Hono<RelayEnv>(),uuid=z.string().uuid();
  router.use('*',createRequireStoredUserSession(options.port));router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
  router.onError((error,c)=>{
    const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';
    const status=code==='INVALID_ARGUMENT'?400:code==='FORBIDDEN'||code==='NOT_FOUND'?404:code==='CONFLICT'||code==='OPERATION_EXPIRED'?409:code==='PAYLOAD_TOO_LARGE'?413:503;
    return c.json(presentApiError(status===404?'分享或来源会话不存在':status===409?'分享或来源状态已变化，请刷新核对':status===413?'分享内容过大，请减少消息数量或关闭处理过程':status===400?'无效的分享参数或消息选择':'分享暂不可用',{code}),status);
  });
  router.get('/',async(c)=>{
    const parsed=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(100000).default(0)}).strict().safeParse(c.req.query());
    if(!parsed.success)return c.json(presentApiError('无效的分享分页参数'),400);
    return c.json(await options.port.listShares({principal:c.get('relayStoragePrincipal')!,...parsed.data}));
  });
  for(const route of ['/preview','/'] as const)router.post(route,async(c)=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const parsed=CreateShareRequestSchema.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json(presentApiError('无效的分享参数'),400);
    const principal=c.get('relayStoragePrincipal')!;
    if(route==='/preview')return c.json(await options.service.preview(principal,parsed.data));
    const key=uuid.safeParse(c.req.header('x-relay-operation-id')??randomUUID());if(!key.success)return c.json(presentApiError('无效的操作标识'),400);c.header('x-relay-operation-id',key.data);
    const result=await options.service.create(principal,parsed.data,key.data);
    return result.state==='committed'?c.json(result.value,201):c.json(presentApiError('创建分享结果暂时无法确认，请稍后核对',{code:'RESULT_UNKNOWN'}),503);
  });
  for(const name of ['share.revoke','share.delete'] as const){
    const handler=async(c:Context<RelayEnv>)=>{
      if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
      const id=uuid.safeParse(c.req.param('id')),key=uuid.safeParse(c.req.header('x-relay-operation-id')??randomUUID());if(!id.success||!key.success)return c.json(presentApiError('无效的分享或操作标识'),400);
      c.header('x-relay-operation-id',key.data);const result=await options.service.mutate(c.get('relayStoragePrincipal')!,name,id.data,key.data);
      return result.state==='committed'?c.json({ok:true as const}):c.json(presentApiError('操作结果暂时无法确认，请稍后核对',{code:'RESULT_UNKNOWN'}),503);
    };
    if(name==='share.revoke')router.post('/:id/revoke',handler);else router.delete('/:id',handler);
  }
  return router;
}
export function createStoredPublicSharesRouter(options:{port:Pick<CoreStoragePort,'readPublicShare'>;getClientId:(context:Context)=>string;limiter?:PublicShareRateLimiter}){
  options=Object.freeze({...options});const router=new Hono(),limiter=options.limiter??new PublicShareRateLimiter();
  router.use('*',async(c,next)=>{c.header('X-Robots-Tag','noindex, noarchive');c.header('Cache-Control','private, no-store');c.header('Referrer-Policy','no-referrer');await next();});
  router.onError((_error,c)=>c.json(presentApiError('分享暂不可用',{code:'STORAGE_UNAVAILABLE'}),503));
  router.get('/:token',async(c)=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const token=c.req.param('token');if(!/^[a-f0-9]{64}$/i.test(token))return c.json({state:'not_found' as const},404);
    if(!limiter.consume(`${options.getClientId(c).slice(0,128)}:${token.toLowerCase()}`))return c.json(presentApiError('请求过于频繁'),429);
    const value=await options.port.readPublicShare({token});return c.json(value,value.state==='not_found'?404:200);
  });return router;
}
