import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredUploadReads } from '../services/stored-upload-reads.js';
import { StorageContractError } from '../storage/command-boundary.js';

export function createStoredProjectUploadReadsRouter(options:{port:CoreStoragePort;service:Pick<StoredUploadReads,'get'>}){
  options=Object.freeze({...options});const router=new Hono<RelayEnv>();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});router.use('*',createRequireStoredUserSession(options.port));
  router.onError((error,c)=>{const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';return c.json(presentApiError(code==='NOT_FOUND'?'项目不存在':code==='INVALID_ARGUMENT'?'附件请求无效':'附件列表暂时无法读取',{code}),code==='NOT_FOUND'?404:code==='FORBIDDEN'?403:code==='INVALID_ARGUMENT'?400:code==='CONFLICT'?409:code==='PAYLOAD_TOO_LARGE'?413:503);});
  for(const suffix of ['uploads','uploads/usage'])router.get('/:id/'+suffix,async(c)=>{
    const projectId=z.string().uuid().safeParse(c.req.param('id'));if(!projectId.success||Object.keys(c.req.query()).length)throw new StorageContractError('INVALID_ARGUMENT');
    const value=await options.service.get(c.get('relayStoragePrincipal')!,projectId.data);return c.json(suffix==='uploads'?value:value.usage);
  });return router;
}
