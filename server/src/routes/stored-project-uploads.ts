import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredProjectUploads } from '../services/stored-project-uploads.js';
import { normalizeUploadName } from '../uploads/project-uploads.js';
import { isAllowedOrigin } from '../security.js';

export function createStoredProjectUploadsRouter(options:{port:CoreStoragePort;service:Pick<StoredProjectUploads,'upload'>}){
  options=Object.freeze({...options});const router=new Hono<RelayEnv>(),uuid=z.string().uuid().transform(value=>value.toLowerCase());
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});router.use('*',createRequireStoredUserSession(options.port));
  router.post('/:id/uploads',async(c)=>{
    const body=c.req.raw.body??new ReadableStream<Uint8Array>({start(controller){controller.close();}}),reject=(status:400|403,message:string)=>{if(!body.locked)void body.cancel().catch(()=>undefined);return c.json(presentApiError(message),status);};
    if(!isAllowedOrigin(c.req.header('origin')))return reject(403,'请求来源不受允许');
    const project=uuid.safeParse(c.req.param('id')),upload=uuid.safeParse(c.req.header('x-relay-upload-id')),message=uuid.safeParse(c.req.header('x-relay-message-id')),size=c.req.header('x-relay-file-size');
    if(!project.success||!upload.success||!message.success||!size||!/^\d{1,10}$/.test(size)||Object.keys(c.req.query()).length)return reject(400,'上传请求头无效');
    let name:string;try{name=normalizeUploadName(decodeURIComponent(c.req.header('x-relay-file-name')??''));}catch{return reject(400,'上传文件名无效');}
    c.header('x-relay-upload-id',upload.data);const result=await options.service.upload(c.get('relayStoragePrincipal')!,{projectId:project.data,uploadId:upload.data,messageId:message.data,name,mimeType:(c.req.header('content-type')?.split(';',1)[0]||'application/octet-stream').trim().toLowerCase(),size:Number(size)},body);
    if(result.state==='committed')return c.json(result.value,201);
    if(result.state==='unknown')return c.json(presentApiError('上传结果待核对，请保留原上传标识重试',{code:'UPLOAD_RESULT_UNKNOWN'}),503);
    const status=result.code==='FORBIDDEN'?403:result.code==='NOT_FOUND'?404:result.code==='PAYLOAD_TOO_LARGE'?413:result.code==='INVALID_ARGUMENT'?400:result.code==='CONFLICT'?409:503;
    return c.json(presentApiError(status===403?'当前没有上传权限':status===404?'项目不存在':status===413?'文件大小或项目上传容量超限':status===400?'上传内容无效':status===409?'上传标识或项目状态已变化':'上传暂时不可用',{code:result.code}),status);
  });return router;
}
