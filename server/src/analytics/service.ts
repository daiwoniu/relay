import { randomUUID,createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRelayConfig } from '../../../scripts/lib/relay-config.mjs';
import { classifyAnalyticsSource,analyticsRelayOrigins } from '../../../scripts/lib/analytics-source.mjs';
import type { Context } from 'hono';
import { getHttpClientIp,getHttpPeerAddress } from '../http-client-ip.js';
import { isValidAccessToken } from '../security.js';
import { getSessionTokenFromCookieHeader } from '../auth/cookie.js';
import { getAnalyticsVisitorId } from './cookie.js';
import { analyticsNetwork } from './network.js';
import { normalizeClientIp } from '../../../scripts/lib/client-ip.mjs';
import { authenticateStoredSession } from '../auth/stored-session.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { AnalyticsEvent,AnalyticsRecord } from './contract.js';
import { analyticsRequestContext,supplementAnalyticsEnvironment,trustedGatewayFrontendContext,analyticsSourceRequestUrl } from './request-context.js';

const version=String(JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version).slice(0,40);
const sourceOrigins=analyticsRelayOrigins(loadRelayConfig(fileURLToPath(new URL('../../../config/relay.conf',import.meta.url))));
export function analyticsLoginId(intent:string){
  const hex=createHash('sha256').update('analytics:login:'+intent).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/** Lossy, bounded analytics queue. Business responses never await analytics writes. */
export class AnalyticsService {
  private queue:AnalyticsRecord[][]=[];
  private running:Promise<void>|null=null;
  private closed=false;
  private readonly startedAt=Date.now();
  private counters={received:0,queueDropped:0,writeFailed:0,written:0,observationsDropped:0,validationRejected:0,rateLimited:0};
  quality(){return{...this.counters,startedAt:this.startedAt,queuedBatches:this.queue.length,inFlight:Boolean(this.running)};}
  rejectedBatch(reason:'validationRejected'|'rateLimited'){this.counters[reason]=Math.min(Number.MAX_SAFE_INTEGER,this.counters[reason]+1);}
  observationDropped(){this.counters.observationsDropped=Math.min(Number.MAX_SAFE_INTEGER,this.counters.observationsDropped+1);}
  constructor(private port:Pick<CoreStoragePort,'appendAnalytics'|'authenticateSession'>,readonly enabled=true,readonly extendedEnabled=process.env.RELAY_ANALYTICS_EXTENDED_ENABLED!=='0'){}
  enqueue(records:AnalyticsRecord[]){
    if(!this.enabled||this.closed)return false;
    if(!this.extendedEnabled){records=records.filter(record=>!['feature_view','feature_action','operation_result'].includes(record.event.name));if(!records.length)return true;}
    this.counters.received=Math.min(Number.MAX_SAFE_INTEGER,this.counters.received+records.length);
    let oversized=true;try{oversized=Buffer.byteLength(JSON.stringify({records}))>32*1024;}catch{/* Invalid telemetry is discarded. */}
    if(!records.length||records.length>20||this.queue.length>=20||oversized){this.counters.queueDropped=Math.min(Number.MAX_SAFE_INTEGER,this.counters.queueDropped+records.length);return false;}
    this.queue.push(records);this.drain();return true;
  }
  private drain(){
    if(this.running||this.closed||!this.queue.length)return;
    const records=this.queue.shift()!;
    this.running=Promise.resolve().then(()=>this.port.appendAnalytics({records})).then(result=>{this.counters.written=Math.min(Number.MAX_SAFE_INTEGER,this.counters.written+result.accepted);},()=>{this.counters.writeFailed=Math.min(Number.MAX_SAFE_INTEGER,this.counters.writeFailed+records.length);}).finally(()=>{this.running=null;this.drain();});
  }
  async identity(c:Context){
    const visitorId=getAnalyticsVisitorId(c.req.header('cookie'));
    const token=getSessionTokenFromCookieHeader(c.req.header('cookie'));
    const session=token?await authenticateStoredSession(token,this.port):null;
    return{visitorId,userId:session?.user.id??null,role:session?.user.role??'guest' as 'guest'|'admin'|'member'};
  }
  record(event:AnalyticsEvent,identity:Pick<AnalyticsRecord,'visitorId'|'userId'|'role'>,ip:string|null,c?:Context):AnalyticsRecord{
    const request=c?analyticsRequestContext(c):null,clientIp=normalizeClientIp(ip)??null;
    return{event:request?supplementAnalyticsEnvironment(event,request.environment):event,receivedAt:Date.now(),...identity,ip:clientIp,version,
      networkType:analyticsNetwork(clientIp,request?.accessHost),
      ...(request?.accessHost?{accessHost:request.accessHost}:{}),};
  }
  server(c:Context,name:'login_result'|'hosting_document',properties:{result?:'success'|'rejected'|'throttled'|'error';siteId?:string}, options:{id?:string;ip?:string|null;userId?:string;role?:'admin'|'member'}={}){
    const authenticated=isValidAccessToken(c.req.header('x-relay-token')),peer=getHttpPeerAddress(c);
    const frontend=trustedGatewayFrontendContext(c.req.header('x-relay-frontend-version'),authenticated,peer);
    const sourceUrl=analyticsSourceRequestUrl(c.req.url,c.req.header('x-forwarded-proto'),authenticated,peer);
    const event:AnalyticsEvent={id:options.id??randomUUID(),name,page:name==='login_result'?'login':'hosting',pageViewId:null,
      ...classifyAnalyticsSource(c.req.header('referer')??'',sourceUrl,sourceOrigins),device:'unknown',browser:'Other',os:'Other',properties,...frontend};
    this.enqueue([this.record(event,{visitorId:getAnalyticsVisitorId(c.req.header('cookie')),userId:options.userId??null,role:options.role??'guest'},options.ip===undefined?getHttpClientIp(c):options.ip,c)]);
  }
  async close(){this.closed=true;this.queue=[];await this.running;}
}
