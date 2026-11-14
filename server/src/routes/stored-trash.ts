import { randomUUID } from 'node:crypto';
import { Hono,type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError,TrashProjectDeleteRequestSchema,TrashSessionDeleteRequestSchema,TrashDeleteResponseDtoSchema } from '../contracts/index.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort,StorageRejectionCode } from '../storage/contracts.js';
import type { StoredPurge,PurgeIntent } from '../services/stored-purge.js';
import { isAllowedOrigin } from '../security.js';
import { RestoreDirectoryUnavailable,type StoredTrash } from '../services/stored-trash.js';
/** JSON body is small by contract; never buffer an unbounded incoming delete request. */
async function deleteBody(c:Context<RelayEnv>):Promise<unknown>{
  const reader=c.req.raw.body?.getReader();if(!reader)throw new StorageContractError('INVALID_ARGUMENT');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;
      if(size>4096){void reader.cancel().catch(()=>undefined);throw new StorageContractError('PAYLOAD_TOO_LARGE');}if(chunk.value.byteLength)chunks.push(chunk.value);}
    const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw new StorageContractError('INVALID_ARGUMENT');}
  }finally{reader.releaseLock();}
}
export function createStoredTrashRouter(options:{port:CoreStoragePort;service:StoredTrash;purge?:Pick<StoredPurge,'delete'>}){
  options=Object.freeze({...options});const router=new Hono<RelayEnv>(),uuid=z.string().uuid(),page={limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(100000).default(0)};
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});router.use('*',createRequireStoredUserSession(options.port));
  router.onError((error,c)=>{if(error instanceof RestoreDirectoryUnavailable)return c.json(presentApiError('原项目目录不存在或不可访问，请先恢复原目录',{code:'TRASH_PROJECT_PATH_UNAVAILABLE'}),409);
    const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';const status=code==='INVALID_ARGUMENT'?400:code==='FORBIDDEN'||code==='NOT_FOUND'?404:code==='CONFLICT'||code==='OPERATION_EXPIRED'?409:code==='PAYLOAD_TOO_LARGE'?413:503;
    return c.json(presentApiError(status===404?'回收站记录不存在或没有权限':status===409?'回收站记录或运行状态已变化，请刷新核对':'回收站暂不可用',{code}),status);});
  router.get('/projects',async(c)=>{const input=z.object({...page,q:z.string().trim().max(100).default('')}).strict().safeParse(c.req.query());if(!input.success)return c.json(presentApiError('无效的回收站查询'),400);
    return c.json(await options.port.readTrash({principal:c.get('relayStoragePrincipal')!,name:'projects',input:input.data}));});
  router.get('/sessions',async(c)=>{const input=z.object({...page,q:z.string().trim().max(100).default(''),projectId:uuid.optional()}).strict().safeParse(c.req.query());if(!input.success)return c.json(presentApiError('无效的回收站查询'),400);
    return c.json(await options.port.readTrash({principal:c.get('relayStoragePrincipal')!,name:'sessions',input:{...input.data,projectId:input.data.projectId??null}}));});
  router.get('/session-projects',async(c)=>c.json(await options.port.readTrash({principal:c.get('relayStoragePrincipal')!,name:'options',input:{}})));
  router.get('/projects/:id/sessions',async(c)=>{const id=uuid.safeParse(c.req.param('id')),input=z.object(page).strict().safeParse(c.req.query());if(!id.success||!input.success)return c.json(presentApiError('无效的回收站查询'),400);
    return c.json(await options.port.readTrash({principal:c.get('relayStoragePrincipal')!,name:'projectSessions',input:{...input.data,projectId:id.data}}));});
  router.get('/sessions/:id/preview',async(c)=>{const id=uuid.safeParse(c.req.param('id'));if(!id.success)return c.json(presentApiError('无效的会话标识'),400);
    return c.json(await options.port.readTrash({principal:c.get('relayStoragePrincipal')!,name:'preview',input:{sessionId:id.data}}));});
  router.get('/sessions/:id/matches',async(c)=>{const id=uuid.safeParse(c.req.param('id')),input=z.object({q:z.string().trim().min(1).max(100),offset:page.offset}).strict().safeParse(c.req.query());if(!id.success||!input.success)return c.json(presentApiError('无效的回收站查询'),400);
    return c.json(await options.port.readTrash({principal:c.get('relayStoragePrincipal')!,name:'matches',input:{...input.data,sessionId:id.data}}));});
  for(const kind of ['project','session'] as const)router.get(`/${kind}s/:id/impact`,async(c)=>{
    const id=uuid.safeParse(c.req.param('id'));if(!id.success||Object.keys(c.req.query()).length)return c.json(presentApiError('无效的删除影响查询'),400);
    return c.json(await options.port.readTrash({principal:c.get('relayStoragePrincipal')!,name:'impact',input:{kind,id:id.data}}));
  });
  for(const kind of ['project','session'] as const)router.post(`/${kind}s/:id/restore`,async(c)=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const id=uuid.safeParse(c.req.param('id')),key=uuid.safeParse(c.req.header('x-relay-operation-id')??randomUUID());if(!id.success||!key.success)return c.json(presentApiError('无效的资源或操作标识'),400);c.header('x-relay-operation-id',key.data);
    const result=await options.service.restore(c.get('relayStoragePrincipal')!,kind,id.data,key.data);
    if(result.state==='committed')return c.json(result.value);
    return c.json(presentApiError(result.localCommitted?'本地恢复已保存，当前引擎归档状态暂不能确认，请刷新核对':'恢复结果暂时无法确认，请稍后核对',
      {code:result.localCommitted?'RESTORE_EXTERNAL_UNKNOWN':'RESULT_UNKNOWN'}),503);
  });
  const deleteFailure=(c:Context<RelayEnv>,code:StorageRejectionCode)=>{
    const status=code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:code==='INVALID_ARGUMENT'?400:code==='CONFLICT'||code==='OPERATION_EXPIRED'?409:code==='PAYLOAD_TOO_LARGE'?413:503;
    const message=status===403?'仅管理员可以彻底删除回收站记录':status===404?'回收站记录不存在或没有操作权限':status===400?'彻底删除请求无效':status===409?'删除影响或任务状态已变化，请刷新核对':status===413?'彻底删除请求过大':'删除暂不可用，请稍后核对状态';
    return c.json(presentApiError(message,{code:code==='FORBIDDEN'?'TRASH_DELETE_FORBIDDEN':code}),status);
  };
  for(const kind of ['project','session'] as const)router.delete(`/${kind}s/:id`,async(c)=>{
    if(c.get('relayActor')?.role!=='admin')return deleteFailure(c,'FORBIDDEN');
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许',{code:'TRASH_DELETE_ORIGIN_FORBIDDEN'}),403);
    const id=uuid.safeParse(c.req.param('id')),key=uuid.safeParse(c.req.header('x-relay-operation-id')??randomUUID());
    if(!id.success||!key.success||Object.keys(c.req.query()).length)return deleteFailure(c,'INVALID_ARGUMENT');
    c.header('x-relay-operation-id',key.data.toLowerCase());
    if(!options.purge)return c.json(presentApiError('删除暂不可用，请稍后核对状态',{code:'STORAGE_UNAVAILABLE'}),503);
    try{
      const raw=await deleteBody(c);let intent:PurgeIntent;
      if(kind==='project'){
        const parsed=TrashProjectDeleteRequestSchema.safeParse(raw);if(!parsed.success)return deleteFailure(c,'INVALID_ARGUMENT');
        intent={kind,id:id.data,...parsed.data};
      }else{
        const parsed=TrashSessionDeleteRequestSchema.safeParse(raw);if(!parsed.success)return deleteFailure(c,'INVALID_ARGUMENT');
        intent={kind,id:id.data,...parsed.data,confirmationName:null};
      }
      const result=await options.purge.delete(c.get('relayStoragePrincipal')!,intent,key.data.toLowerCase());
      if(result.state==='committed')return c.json(TrashDeleteResponseDtoSchema.parse({ok:true,cleanupPending:result.cleanupPending}));
      if(result.state==='rejected')return deleteFailure(c,result.code);
      return c.json(presentApiError('删除结果暂时无法确认，请稍后刷新核对',{code:'TRASH_DELETE_RESULT_UNKNOWN'}),503);
    }catch(error){return deleteFailure(c,error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE');}
  });return router;
}
