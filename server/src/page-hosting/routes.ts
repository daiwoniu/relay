import path from 'node:path';
import { Hono,type Context } from 'hono';
import { z } from 'zod';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import type { RelayEnv } from '../auth/authorization.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { presentApiError } from '../contracts/index.js';
import { PageHosting, HostingError } from './service.js';
import { HostingLocalSourcePathSchema, HostingPatchSchema } from './contract.js';
import { encodePath } from './file-paths.js';

const publishSchema=z.object({uploadId:z.string().uuid(),name:z.string().trim().min(1).max(80),entry:z.string().min(1).max(512),siteId:z.string().uuid().optional(),expectedToken:z.string().uuid().optional()}).strict();
export function createHostingAdminRouter(options:{port:CoreStoragePort;service:PageHosting}){
  const router=new Hono<RelayEnv>();
  router.use('*',createRequireStoredUserSession(options.port));
  router.use('*',async(c,next)=>{
    c.header('Cache-Control','private, no-store');
    if(c.get('relayActor').role!=='admin')return c.json(presentApiError('仅管理员可管理页面托管'),403);
    return next();
  });
  router.get('/',async c=>c.json({sites:await options.service.list(c.get('relayStoragePrincipal')!)}));
  router.post('/uploads',async c=>{
    let filename:string;try{filename=decodeURIComponent(c.req.header('x-file-name')??'');}catch{return c.json(presentApiError('文件名无效'),400);}
    if(!c.req.raw.body)return c.json(presentApiError('请选择文件'),400);
    return c.json(await options.service.upload(c.get('relayStoragePrincipal')!,filename,c.req.raw.body,Number(c.req.header('content-length')??0)));
  });
  router.post('/imports',async c=>{
    const input=z.object({path:HostingLocalSourcePathSchema}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!input.success)return c.json(presentApiError('请选择服务器上的文件或目录'),400);
    return c.json(await options.service.importLocal(c.get('relayStoragePrincipal')!,input.data.path));
  });
  router.delete('/uploads/:id',async c=>{await options.service.cancel(c.get('relayStoragePrincipal')!,c.req.param('id'));return c.json({ok:true});});
  router.post('/publish',async c=>{
    const input=publishSchema.safeParse(await c.req.json().catch(()=>null));if(!input.success)return c.json(presentApiError('请填写名称并选择首页'),400);
    return c.json({site:await options.service.publish(c.get('relayStoragePrincipal')!,input.data)});
  });
  router.patch('/:id',async c=>{
    const input=HostingPatchSchema.safeParse(await c.req.json().catch(()=>null)),token=z.string().uuid().safeParse(c.req.header('if-match'));
    if(!input.success||!token.success)return c.json(presentApiError('修改参数无效，请刷新重试'),400);
    return c.json({site:await options.service.patch(c.get('relayStoragePrincipal')!,c.req.param('id'),token.data,input.data)});
  });
  router.delete('/:id',async c=>{
    const token=z.string().uuid().safeParse(c.req.header('if-match'));if(!token.success)return c.json(presentApiError('请刷新列表后重试'),400);
    await options.service.remove(c.get('relayStoragePrincipal')!,c.req.param('id'),token.data);return c.json({ok:true});
  });
  router.onError((error,c)=>{
    if(error instanceof HostingError)return c.json(presentApiError(error.message),error.status);
    if(error instanceof StorageContractError){
      const code=error.code;
      return c.json(presentApiError(code==='FORBIDDEN'?'仅管理员可管理页面托管':code==='CONFLICT'?'内容已变化，请刷新重试':code==='PAYLOAD_TOO_LARGE'?'托管内容或站点数量超过限制':code==='INVALID_ARGUMENT'?'参数无效，请重新选择内容':code==='NOT_FOUND'?'内容不存在':'页面托管暂不可用'),code==='FORBIDDEN'?403:code==='CONFLICT'?409:code==='PAYLOAD_TOO_LARGE'?413:code==='INVALID_ARGUMENT'?400:code==='NOT_FOUND'?404:503);
    }
    return c.json(presentApiError('文件处理失败，请检查压缩包路径、文件类型或稍后重试'),400);
  });return router;
}

const mime:Record<string,string>={html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',map:'application/json',txt:'text/plain',csv:'text/csv',xml:'application/xml',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',pdf:'application/pdf',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',mp4:'video/mp4',webm:'video/webm',m4a:'audio/mp4',aac:'audio/aac',vtt:'text/vtt',wasm:'application/wasm',webmanifest:'application/manifest+json'};
export const HOSTING_CSP="sandbox allow-scripts allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** No session or internal access token is required for public files. Preview uses a short-lived random capability. */
export function createHostingPublicRouter(service:PageHosting,observeDocument?:(c:Context,siteId:string)=>void){
  const router=new Hono();
  router.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store');c.header('Content-Security-Policy',HOSTING_CSP);c.header('X-Content-Type-Options','nosniff');
    c.header('Referrer-Policy','no-referrer');c.header('Cross-Origin-Opener-Policy','same-origin');c.header('X-Frame-Options','DENY');
    c.header('Access-Control-Allow-Origin','*');c.header('Cross-Origin-Resource-Policy','cross-origin');
    // Credentialed CORS is never enabled on hosted content, including when the visitor is logged in.
    c.header('Access-Control-Allow-Credentials',undefined);
    if(c.req.method==='OPTIONS')return c.body(null,204);
    if(!['GET','HEAD'].includes(c.req.method))return c.text('Method Not Allowed',405);
    return next();
  });
  router.all('*',async c=>{
    const match=/^\/(p|p-preview)\/([^/]+)(?:\/(.*))?$/.exec(c.req.path);if(!match)return c.text('页面不存在',404);
    let remainder=match[3]??'',token:string|undefined;
    if(match[1]==='p-preview'){const slash=remainder.indexOf('/');token=slash<0?remainder:remainder.slice(0,slash);remainder=slash<0?'':remainder.slice(slash+1);if(!/^[a-f0-9]{64}$/.test(token))return c.text('预览已失效',404);}
    let requested:string;try{requested=decodeURIComponent(remainder);}catch{return c.text('路径无效',400);}
    const value=await service.open(match[2],requested,token);if(!value)return c.text('页面不存在或已停用',404);
    const base=`/${match[1]}/${match[2]}/${token?`${token}/`:''}`;
    if(requested!==value.filename||match[3]===undefined){await value.stream.cancel();return c.redirect(base+encodePath(value.filename)+new URL(c.req.url).search,302);}
    const ext=path.posix.extname(value.filename).slice(1).toLowerCase();
    c.header('Content-Type',(mime[ext]??'application/octet-stream')+(['html','htm','css','js','mjs','json','txt','csv','svg','xml','vtt'].includes(ext)?'; charset=utf-8':''));
    c.header('Content-Length',String(value.size));
    if(c.req.method==='HEAD'){await value.stream.cancel();return c.body(null);}
    if(match[1]==='p'&&['html','htm'].includes(ext))try{observeDocument?.(c,value.siteId);}catch{/* Analytics never blocks document delivery. */}
    return c.body(value.stream);
  });
  router.onError((error,c)=>c.text(error instanceof HostingError?error.message:'页面暂不可用',error instanceof HostingError?error.status:503));
  return router;
}
