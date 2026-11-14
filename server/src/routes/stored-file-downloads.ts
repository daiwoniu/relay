import { Hono } from 'hono';
import { z,ZodError } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredFileDownloads } from '../services/stored-file-downloads.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { getMimeType } from './filesystem-preview.js';
const querySchema=z.object({path:z.string().min(1).max(32768),accessToken:z.string().uuid().optional()}).strict();
export function createStoredFileDownloadsRouter(options:{port:CoreStoragePort;service:Pick<StoredFileDownloads,'open'>}){
  options=Object.freeze({...options});const router=new Hono<RelayEnv>();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});router.use('*',createRequireStoredUserSession(options.port));
  router.get('/download',async c=>{
    const query=querySchema.safeParse(c.req.query());if(!query.success||Object.values(c.req.queries()).some(value=>value.length!==1))return c.json(presentApiError('下载参数无效'),400);
    try{const value=await options.service.open(c.get('relayStoragePrincipal')!,query.data,c.req.raw.signal);return new Response(value.stream,{status:200,headers:{'Content-Type':getMimeType(value.name),'Content-Length':String(value.size),'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(value.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});}
    catch(error){const code=error instanceof StorageContractError?error.code:error instanceof ZodError?'INVALID_ARGUMENT':'STORAGE_UNAVAILABLE',status=code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:code==='CONFLICT'?409:code==='PAYLOAD_TOO_LARGE'?413:code==='INVALID_ARGUMENT'?400:503;return c.json(presentApiError(status===403?'该文件不在允许的访问范围内':status===404?'文件不存在':status===413?'文件超过下载大小上限':status===400?'下载参数无效':status===409?'文件或项目状态已变化':'文件下载暂时不可用'),status);}
  });return router;
}
