import { Hono,type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { ProjectUploadDeleteResponseDtoSchema,ProjectUploadCleanupPendingDtoSchema,presentApiError } from '../contracts/index.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredArchivedCleanup } from '../services/stored-archived-cleanup.js';
import { isAllowedOrigin } from '../security.js';
import { requireEmptyRequestBody } from './empty-request-body.js';
const uuid=z.string().uuid().transform(v=>v.toLowerCase()),bodySchema=z.object({attachmentIds:z.array(uuid).min(1).max(10).refine(v=>new Set(v).size===v.length)}).strict();
let reading=0;
async function readBody(c:Context<RelayEnv>,timeoutMs:number){
  if(reading>=8)throw new StorageContractError('OVERLOADED');const reader=c.req.raw.body?.getReader();if(!reader)throw new StorageContractError('INVALID_ARGUMENT');reading++;let expired=false;
  const abort=()=>{expired=true;void reader.cancel().catch(()=>undefined);},timer=setTimeout(abort,timeoutMs);timer.unref();c.req.raw.signal.addEventListener('abort',abort,{once:true});if(c.req.raw.signal.aborted)abort();
  try{const parts:Uint8Array[]=[];let size=0;for(;;){const next=await reader.read();if(expired)throw new StorageContractError('NOT_SUBMITTED');if(next.done)break;size+=next.value.byteLength;if(size>4096){void reader.cancel().catch(()=>undefined);throw new StorageContractError('PAYLOAD_TOO_LARGE');}if(next.value.length)parts.push(Uint8Array.from(next.value));}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new StorageContractError('INVALID_ARGUMENT');}
  }finally{clearTimeout(timer);c.req.raw.signal.removeEventListener('abort',abort);reader.releaseLock();reading--;}
}
export function createStoredArchivedCleanupRouter(options:{port:CoreStoragePort;service:Pick<StoredArchivedCleanup,'delete'>;bodyTimeoutMs?:number}){
  options=Object.freeze({...options});if(options.bodyTimeoutMs!==undefined&&(!Number.isSafeInteger(options.bodyTimeoutMs)||options.bodyTimeoutMs<1||options.bodyTimeoutMs>5000))throw new StorageContractError('INVALID_ARGUMENT');const router=new Hono<RelayEnv>();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});router.use('*',createRequireStoredUserSession(options.port));
  router.onError((error,c)=>{const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE',status=code==='INVALID_ARGUMENT'?400:code==='PAYLOAD_TOO_LARGE'?413:503;return c.json(presentApiError(status===400?'清理参数无效':status===413?'清理请求过大':'清理结果待核对，请保留原操作标识重试',{code:status===503?'UPLOAD_CLEANUP_UNKNOWN':code}),status);});
  const handle=async(c:Context<RelayEnv>,selection:'one'|'many'|'all')=>{
    const cancel=()=>{const body=c.req.raw.body;if(body&&!body.locked)void body.cancel().catch(()=>undefined);};
    if(!isAllowedOrigin(c.req.header('origin'))){cancel();return c.json(presentApiError('请求来源不受允许'),403);}
    const project=uuid.safeParse(c.req.param('id')),key=uuid.safeParse(c.req.header('x-relay-operation-id'));if(!project.success||!key.success||Object.keys(c.req.query()).length){cancel();return c.json(presentApiError('项目或操作标识无效'),400);}c.header('x-relay-operation-id',key.data);
    let attachmentIds:string[]|null=null;if(selection==='many'){const parsed=bodySchema.safeParse(await readBody(c,options.bodyTimeoutMs??5000));if(!parsed.success)return c.json(presentApiError('清理参数无效'),400);attachmentIds=parsed.data.attachmentIds;}
    else{await requireEmptyRequestBody(c.req.raw,options.bodyTimeoutMs??5000);if(selection==='one'){const id=uuid.safeParse(c.req.param('attachmentId'));if(!id.success)return c.json(presentApiError('附件标识无效'),400);attachmentIds=[id.data];}}
    const result=await options.service.delete(c.get('relayStoragePrincipal')!,{projectId:project.data,attachmentIds},key.data);
    if(result.state==='access-denied')return c.json(presentApiError('当前已无权读取清理结果，请重新登录或核对权限',{code:'UPLOAD_CLEANUP_ACCESS_CHANGED'}),result.code==='NOT_FOUND'?404:403);
    if(result.state==='committed'){
      if(result.usage&&!result.cleanupPending)return c.json(ProjectUploadDeleteResponseDtoSchema.parse({deletedCount:result.deletedCount,usage:result.usage}));
      return c.json(ProjectUploadCleanupPendingDtoSchema.parse({state:'committed',deletedCount:result.deletedCount,cleanupPending:result.cleanupPending,usagePending:true}),202);
    }
    if(result.state==='unknown'||result.rollbackPending)return c.json(presentApiError(result.state==='rejected'?'清理未提交，文件恢复仍待核对，请保留原操作标识重试':'清理结果待核对，请保留原操作标识重试',{code:result.state==='rejected'?'UPLOAD_CLEANUP_ROLLBACK_PENDING':'UPLOAD_CLEANUP_UNKNOWN'}),503);
    const status=result.code==='FORBIDDEN'?403:result.code==='NOT_FOUND'?404:result.code==='INVALID_ARGUMENT'?400:result.code==='PAYLOAD_TOO_LARGE'?413:result.code==='CONFLICT'||result.code==='OPERATION_EXPIRED'?409:503;return c.json(presentApiError(status===403?'当前没有清理权限':status===404?'项目不存在':status===400?'清理参数无效':status===413?'清理范围过大':status===409?'清理任务或项目状态已变化，请刷新核对':'清理暂时不可用'),status);
  };
  router.delete('/:id/uploads/:attachmentId',c=>handle(c,'one'));router.post('/:id/uploads/delete',c=>handle(c,'many'));router.delete('/:id/uploads',c=>handle(c,'all'));return router;
}
