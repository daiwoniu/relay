import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { createClientId } from '../auth/cookie.js';
import { getAnalyticsCookie,serializeAnalyticsCookie } from './cookie.js';
import { isAllowedOrigin,isSecureRelayRequest } from '../security.js';
import { getHttpClientIp } from '../http-client-ip.js';
import { PublicShareRateLimiter } from '../shares/public-rate-limit.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { AnalyticsBatchSchema,AnalyticsQuerySchema } from './contract.js';
import type { AnalyticsService } from './service.js';
import type { AnalyticsReader } from './reader.js';

async function readBatch(c:Parameters<typeof getHttpClientIp>[0]){
  const reader=c.req.raw.body?.getReader();if(!reader)throw Error('INVALID');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16*1024){await reader.cancel();throw Error('LIMIT');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  return AnalyticsBatchSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export function createAnalyticsRouter(options:{port:CoreStoragePort;service:AnalyticsService;reader?:AnalyticsReader}){
  const router=new Hono<RelayEnv>(),ipLimit=new PublicShareRateLimiter(120),visitorLimit=new PublicShareRateLimiter(30);
  router.post('/api/public/analytics/events',async c=>{
    c.header('Cache-Control','no-store');
    if(c.req.header('origin')==='null'||!isAllowedOrigin(c.req.header('origin')))return c.json({error:'不允许的请求来源'},403);
    if(!options.service.enabled)return c.body(null,204);
    const ip=getHttpClientIp(c);if(!ipLimit.consume(ip)){options.service.rejectedBatch('rateLimited');return c.json({error:'采集过于频繁'},429);}
    let batch;try{batch=await readBatch(c);}catch{options.service.rejectedBatch('validationRejected');return c.json({error:'无效的统计事件或请求过大'},400);}
    const identity=await options.service.identity(c);
    identity.visitorId??=createClientId();
    if(!getAnalyticsCookie(c.req.header('cookie')))c.header('Set-Cookie',serializeAnalyticsCookie(identity.visitorId,isSecureRelayRequest(c.req.url,c.req.header('x-forwarded-proto'),c.req.header('x-forwarded-host'))),{append:true});
    if(!visitorLimit.consume(identity.visitorId)){options.service.rejectedBatch('rateLimited');return c.json({error:'采集过于频繁'},429);}
    if(batch.events.some(e=>Buffer.byteLength(JSON.stringify(e.properties))>512)){options.service.rejectedBatch('validationRejected');return c.json({error:'统计属性过大'},400);}
    const records=batch.events.map(e=>options.service.record(e,identity,ip,c));
    return options.service.enqueue(records)?c.body(null,204):c.json({error:'统计队列已满'},429);
  });
  router.use('/api/admin/analytics/*',createRequireStoredUserSession(options.port));
  router.get('/api/admin/analytics/quality',c=>{
    c.header('Cache-Control','private, no-store');
    if(c.get('relayActor').role!=='admin')return c.json({error:'仅管理员可查看统计'},403);
    const data={server:options.service.quality(),scope:'current_process',lossy:true};
    return c.json(c.req.query('meta')==='true'?{data,asOf:Date.now(),cached:false}:data);
  });
  for(const view of ['summary','visits','features','actions'] as const)router.get(`/api/admin/analytics/${view}`,async c=>{
    c.header('Cache-Control','private, no-store');
    if(c.get('relayActor').role!=='admin')return c.json({error:'仅管理员可查看统计'},403);
    const raw=c.req.query(),filterKeys=['feature','action','result','metric','includeSystem','operationId'];
    if(Object.keys(raw).some(k=>!['range','excludeAdmin','excludeInternal','meta','fresh',...(view==='actions'?['beforeAt','beforeId',...filterKeys]:[])].includes(k))||['excludeAdmin','excludeInternal','meta','fresh','includeSystem'].some(key=>raw[key]!==undefined&&!['true','false'].includes(raw[key])))return c.json({error:'查询参数无效'},400);
    const query=AnalyticsQuerySchema.safeParse({range:raw.range??'7d',excludeAdmin:raw.excludeAdmin==='true',excludeInternal:raw.excludeInternal==='true',
      ...Object.fromEntries(filterKeys.filter(key=>raw[key]!==undefined).map(key=>[key,key==='includeSystem'?raw[key]==='true':raw[key]]))});
    if(!query.success)return c.json({error:'日期范围无效'},400);
    const principal=c.get('relayStoragePrincipal');if(!principal||principal.kind!=='user')return c.json({error:'统计权限无效'},403);
    let cursor:{at:number;id:string}|undefined;
    if(raw.beforeAt!==undefined||raw.beforeId!==undefined){
      const at=Number(raw.beforeAt),id=raw.beforeId;
      if(!Number.isSafeInteger(at)||at<1||!id||!/^[0-9a-f-]{36}$/i.test(id))return c.json({error:'分页参数无效'},400);
      cursor={at,id};
    }
    try{
      const authorized=async()=>{const s=await options.port.authenticateSession({tokenHash:principal.authSessionHash});return s?.user.id===principal.userId&&s.user.role==='admin';};
      if(!await authorized())return c.json({error:'统计权限无效'},403);
      const snapshot=options.reader?await options.reader.readSnapshot(view,query.data,cursor,raw.fresh==='true'):view==='summary'||view==='visits'?{data:await options.port.readAnalytics({principal,query:query.data,view}),asOf:Date.now(),cached:false}:null;
      if(snapshot===null)return c.json({error:'统计读取未配置'},503);
      if(!await authorized())return c.json({error:'统计权限无效'},403);
      return c.json((raw.meta==='true'?snapshot:snapshot.data) as any);
    }
    catch(error){return c.json({error:'统计暂不可用'},error instanceof StorageContractError&&error.code==='FORBIDDEN'?403:503);}
  });
  router.onError((_error,c)=>c.json({error:'统计暂不可用'},503));
  return router;
}
