import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredDraftCleanup } from '../services/stored-draft-cleanup.js';
import { isAllowedOrigin } from '../security.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { requireEmptyRequestBody } from './empty-request-body.js';
import { recordCommittedOperation } from '../analytics/command-collector.js';
export function createStoredDraftCleanupRouter(options:{port:CoreStoragePort;service:Pick<StoredDraftCleanup,'delete'>}){
  options=Object.freeze({...options});const router=new Hono<RelayEnv>();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});router.use('*',createRequireStoredUserSession(options.port));
  router.delete('/:id/uploads/drafts/:uploadId',async c=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    if(!z.string().uuid().safeParse(c.req.param('id')).success||!z.string().uuid().safeParse(c.req.param('uploadId')).success||Object.keys(c.req.query()).length){if(c.req.raw.body&&!c.req.raw.body.locked)void c.req.raw.body.cancel().catch(()=>undefined);return c.json(presentApiError('草稿清理参数无效'),400);}
    try {
      await requireEmptyRequestBody(c.req.raw);
    } catch (error) {
      if(error instanceof StorageContractError&&error.code==='INVALID_ARGUMENT')return c.json(presentApiError('草稿清理参数无效'),400);
      return c.json(presentApiError('草稿清理暂时不可用'),503);
    }
    const result=await options.service.delete(c.get('relayStoragePrincipal')!,c.req.param('id'),c.req.param('uploadId'));if(result.state==='committed'){recordCommittedOperation('attachments','remove',`upload-draft:${c.req.param('uploadId')}`);return c.json(result.value);}
    if(result.state==='unknown')return c.json(presentApiError('草稿清理结果待核对，请保留原上传标识重试',{code:'UPLOAD_CLEANUP_UNKNOWN'}),503);
    const status=result.code==='FORBIDDEN'?403:result.code==='NOT_FOUND'?404:result.code==='INVALID_ARGUMENT'?400:result.code==='CONFLICT'?409:503;return c.json(presentApiError(status===403?'当前没有清理权限':status===404?'项目不存在':status===400?'清理参数无效':status===409?'项目状态已变化':'草稿清理暂时不可用'),status);
  });return router;
}
