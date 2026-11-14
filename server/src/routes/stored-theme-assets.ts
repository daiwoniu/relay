import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError,OkDtoSchema,ThemeAssetResponseDtoSchema } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { StoredThemeAssets,ThemeAssetOutcome } from '../services/stored-theme-assets.js';
import { isAllowedOrigin } from '../security.js';
import { MAX_THEME_ASSET_BYTES } from '../theme/theme-assets.js';
import { requireEmptyRequestBody } from './empty-request-body.js';
const uuid=z.string().uuid(),maxBody=2*MAX_THEME_ASSET_BYTES+65536;
let receiving=0;
/** Candidate-only attachment routes. The application must supply the same fixed root/exclusive owner as the DB service. */
export function createStoredThemeAssetsRouter(options:{port:CoreStoragePort;service:Pick<StoredThemeAssets,'upload'|'delete'|'read'>;bodyTimeoutMs?:number}){
  if(options.bodyTimeoutMs!==undefined&&(!Number.isSafeInteger(options.bodyTimeoutMs)||options.bodyTimeoutMs<1||options.bodyTimeoutMs>30000))throw new StorageContractError('INVALID_ARGUMENT');
  options=Object.freeze({...options});const router=new Hono<RelayEnv>();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');c.header('X-Content-Type-Options','nosniff');await next();});
  router.use('*',createRequireStoredUserSession(options.port));
  router.onError((error,c)=>{
    const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';
    const status=code==='FORBIDDEN'||code==='NOT_FOUND'?404:code==='INVALID_ARGUMENT'?400:code==='PAYLOAD_TOO_LARGE'?413:code==='CONFLICT'||code==='OPERATION_EXPIRED'?409:503;
    return c.json(presentApiError(status===404?'背景资源不存在或没有权限':status===400?'背景资源参数无效':status===413?'背景图片请求过大':status===409?'背景使用或任务状态已变化，请核对':'背景资源暂不可用',{code}),status);
  });
  function outcome(result:ThemeAssetOutcome){if(result.state==='rejected')throw new StorageContractError(result.code);return result;}
  router.post('/',async(c)=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const parsed=uuid.safeParse(c.req.header('x-relay-operation-id'));if(!parsed.success||Object.keys(c.req.query()).length)throw new StorageContractError('INVALID_ARGUMENT');
    const key=parsed.data.toLowerCase();c.header('x-relay-operation-id',key);
    if(receiving>=2)throw new StorageContractError('OVERLOADED');receiving++;
    try{
      if(!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data;'))throw new StorageContractError('INVALID_ARGUMENT');
      const reader=c.req.raw.body?.getReader();if(!reader)throw new StorageContractError('INVALID_ARGUMENT');
      const storage=new Uint8Array(maxBody);let size=0,accepting=true,timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([(async()=>{for(;;){const item=await reader.read();if(!accepting||item.done)break;if(size+item.value.byteLength>maxBody){void reader.cancel().catch(()=>undefined);throw new StorageContractError('PAYLOAD_TOO_LARGE');}
        storage.set(item.value,size);size+=item.value.byteLength;
      }})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{accepting=false;void reader.cancel().catch(()=>undefined);reject(new StorageContractError('NOT_SUBMITTED'));},options.bodyTimeoutMs??30000);timer.unref();})]);}
      finally{accepting=false;if(timer)clearTimeout(timer);reader.releaseLock();}
      const body=storage.subarray(0,size);
      let form:FormData;try{form=await new Response(body,{headers:{'content-type':c.req.header('content-type')!}}).formData();}catch{throw new StorageContractError('INVALID_ARGUMENT');}
      const entries=[...form.entries()];if(entries.length!==2||entries.some(([name,value])=>!['desktop','mobile'].includes(name)||!(value instanceof File))||form.getAll('desktop').length!==1||form.getAll('mobile').length!==1)throw new StorageContractError('INVALID_ARGUMENT');
      const desktop=form.get('desktop') as File,mobile=form.get('mobile') as File;
      if(desktop.size>MAX_THEME_ASSET_BYTES||mobile.size>MAX_THEME_ASSET_BYTES)throw new StorageContractError('PAYLOAD_TOO_LARGE');
      const result=outcome(await options.service.upload(c.get('relayStoragePrincipal')!,{desktop:new Uint8Array(await desktop.arrayBuffer()),mobile:new Uint8Array(await mobile.arrayBuffer())},key));
      if(result.state==='committed'&&!result.cleanupPending)return c.json(ThemeAssetResponseDtoSchema.parse({assetId:result.assetId}),201);
      return c.json(presentApiError(result.state==='committed'?'背景已登记，文件收尾尚未确认，请保留操作标识核对':'背景保存结果暂未确认，请保留操作标识核对',{code:result.state==='committed'?'THEME_ASSET_CLEANUP_PENDING':'THEME_ASSET_RESULT_UNKNOWN'}),503);
    }finally{receiving--;}
  });
  router.get('/:assetId/:variant',async(c)=>{
    const id=uuid.safeParse(c.req.param('assetId')),variant=z.enum(['desktop','mobile']).safeParse(c.req.param('variant'));
    if(!id.success||!variant.success||Object.keys(c.req.query()).length)throw new StorageContractError('INVALID_ARGUMENT');
    const bytes=await options.service.read(c.get('relayStoragePrincipal')!,id.data.toLowerCase(),variant.data);if(!bytes)throw new StorageContractError('NOT_FOUND');
    return c.body(new Uint8Array(bytes),200,{'Content-Type':'image/webp'});
  });
  router.delete('/:assetId',async(c)=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    const id=uuid.safeParse(c.req.param('assetId')),key=uuid.safeParse(c.req.header('x-relay-operation-id'));
    if(!id.success||!key.success||Object.keys(c.req.query()).length)throw new StorageContractError('INVALID_ARGUMENT');
    await requireEmptyRequestBody(c.req.raw);
    c.header('x-relay-operation-id',key.data.toLowerCase());const result=outcome(await options.service.delete(c.get('relayStoragePrincipal')!,id.data.toLowerCase(),key.data.toLowerCase()));
    if(result.state==='committed'&&!result.cleanupPending)return c.json(OkDtoSchema.parse({ok:true}));
    return c.json(presentApiError('删除状态或文件收尾暂未确认，请保留操作标识核对',{code:result.state==='committed'?'THEME_ASSET_CLEANUP_PENDING':'THEME_ASSET_RESULT_UNKNOWN'}),503);
  });return router;
}
