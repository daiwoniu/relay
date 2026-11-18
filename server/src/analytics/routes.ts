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

async function readBatch(c:Parameters<typeof getHttpClientIp>[0]){
  const reader=c.req.raw.body?.getReader();if(!reader)throw Error('INVALID');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16*1024){await reader.cancel();throw Error('LIMIT');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  return AnalyticsBatchSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
export function createAnalyticsRouter(options:{port:CoreStoragePort;service:AnalyticsService}){
  const router=new Hono<RelayEnv>(),ipLimit=new PublicShareRateLimiter(120),visitorLimit=new PublicShareRateLimiter(30);
  router.post('/api/public/analytics/events',async c=>{
    c.header('Cache-Control','no-store');
    if(c.req.header('origin')==='null'||!isAllowedOrigin(c.req.header('origin')))return c.json({error:'不允许的请求来源'},403);
    if(!options.service.enabled)return c.body(null,204);
    const ip=getHttpClientIp(c);if(!ipLimit.consume(ip))return c.json({error:'采集过于频繁'},429);
    let batch;try{batch=await readBatch(c);}catch{return c.json({error:'无效的统计事件或请求过大'},400);}
    const identity=await options.service.identity(c);
    identity.visitorId??=createClientId();
    if(!getAnalyticsCookie(c.req.header('cookie')))c.header('Set-Cookie',serializeAnalyticsCookie(identity.visitorId,isSecureRelayRequest(c.req.url,c.req.header('x-forwarded-proto'),c.req.header('x-forwarded-host'))),{append:true});
    if(!visitorLimit.consume(identity.visitorId))return c.json({error:'采集过于频繁'},429);
    if(batch.events.some(e=>Buffer.byteLength(JSON.stringify(e.properties))>512))return c.json({error:'统计属性过大'},400);
    const records=batch.events.map(e=>options.service.record(e,identity,ip,c));
    return options.service.enqueue(records)?c.body(null,204):c.json({error:'统计队列已满'},429);
  });
  router.use('/api/admin/analytics/*',createRequireStoredUserSession(options.port));
  for(const view of ['summary','visits'] as const)router.get(`/api/admin/analytics/${view}`,async c=>{
    c.header('Cache-Control','private, no-store');
    if(c.get('relayActor').role!=='admin')return c.json({error:'仅管理员可查看统计'},403);
    const raw=c.req.query();if(Object.keys(raw).some(k=>!['range','excludeAdmin','excludeInternal'].includes(k))||['excludeAdmin','excludeInternal'].some(key=>raw[key]!==undefined&&!['true','false'].includes(raw[key])))return c.json({error:'查询参数无效'},400);
    const query=AnalyticsQuerySchema.safeParse({range:raw.range??'7d',excludeAdmin:raw.excludeAdmin==='true',excludeInternal:raw.excludeInternal==='true'});
    if(!query.success)return c.json({error:'日期范围无效'},400);
    const principal=c.get('relayStoragePrincipal');if(!principal||principal.kind!=='user')return c.json({error:'统计权限无效'},403);
    try{return c.json(await options.port.readAnalytics({principal,query:query.data,view}));}
    catch(error){return c.json({error:'统计暂不可用'},error instanceof StorageContractError&&error.code==='FORBIDDEN'?403:503);}
  });
  router.onError((_error,c)=>c.json({error:'统计暂不可用'},503));
  return router;
}
