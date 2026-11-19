import { parentPort,workerData } from 'node:worker_threads';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Actor } from '../auth/authorization.js';
import type { StoreWriterProof } from '../storage/store-owner.js';
import { assertWorkerWriter } from '../storage/worker-writer-fence.js';
import { openNativeNewsRepository } from './storage/native-news-driver.js';
import { NewsScheduler } from './ingest/scheduler.js';
import { SEED_SOURCES,LEGACY_DISABLED_SEED_SOURCES } from './sources/seed-sources.js';
import type { NewsSource } from './sources/source-types.js';
import { createPublicNewsRouter } from '../routes/news-public.js';
import { createNewsAdminRouter } from '../routes/news-admin.js';
import { createNewsPreferencesRouter } from '../routes/news-preferences.js';
import { randomUUID } from 'node:crypto';
import type { NewsAnalyticsObserver,NewsAnalyticsFact } from './analytics-observation.js';

const options=workerData as{root:string;proof:StoreWriterProof;sources?:NewsSource[];initialize?:boolean};
const assertWriter=()=>assertWorkerWriter(options.proof);
let opened:Awaited<ReturnType<typeof openNativeNewsRepository>>|undefined,scheduler:NewsScheduler|undefined,closing=false;
let authSequence=0;
const authPending=new Map<number,{resolve:(actor:Actor)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
const requests=new WeakMap<Request,{id:number;clientId:string;facts:Array<NewsAnalyticsFact&{id:string}>}>();
const observe:NewsAnalyticsObserver=(c,fact)=>{const request=requests.get(c.req.raw);if(request&&request.facts.length<4)request.facts.push({...fact,id:randomUUID()});};
const httpPending=new Set<Promise<void>>();
function authorize(request:Request):Promise<Actor>{
  const job=requests.get(request);if(!job||closing||authPending.size>=32)return Promise.reject(new HTTPException(403));
  const authId=++authSequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{authPending.delete(authId);reject(new HTTPException(503));},10000);
    authPending.set(authId,{resolve,reject,timer});parentPort!.postMessage({type:'authorize',authId,requestId:job.id,admin:new URL(request.url).pathname.startsWith('/api/admin/news')});
  });
}
const app=new Hono();
app.route('/api/public/news',createPublicNewsRouter({repository:()=>opened?.repository??null,getClientId:c=>requests.get(c.req.raw)?.clientId??'anonymous'}));
app.route('/api/admin/news',createNewsAdminRouter({observe,repository:()=>opened?.repository??null,scheduler:()=>scheduler??null,getActor:c=>authorize(c.req.raw)}));
app.route('/api/news',createNewsPreferencesRouter({observe,repository:()=>opened?.repository??null,getActor:c=>authorize(c.req.raw)}));
app.onError((error,c)=>c.json({error:error instanceof HTTPException&&error.status===403?'当前账号无权执行此操作':'资讯暂时不可用'},error instanceof HTTPException&&error.status===403?403:503));

async function control(action:string){
  if(action==='initialize'){
    if(opened||closing)throw Error('NEWS_CONFLICT');assertWriter();
    opened=await openNativeNewsRepository(options.root,assertWriter,{initialize:options.initialize});
    opened.repository.ensureSources(options.sources??SEED_SOURCES,LEGACY_DISABLED_SEED_SOURCES);
    scheduler=new NewsScheduler({repository:opened.repository,dataDir:options.root,sources:opened.repository.listSources(),observeManualRefresh:fact=>parentPort!.postMessage({type:'analyticsManualRefresh',...fact})});return null;
  }
  if(action==='resume'){if(!scheduler||closing)throw Error('NEWS_CONFLICT');assertWriter();scheduler.start();return null;}
  if(action==='close'){
    closing=true;await Promise.allSettled([...httpPending]);await scheduler?.stop();await opened?.close();opened=undefined;
    for(const pending of authPending.values()){clearTimeout(pending.timer);pending.reject(new HTTPException(503));}authPending.clear();return null;
  }
  throw Error('NEWS_INVALID_COMMAND');
}
async function http(message:any){
  if(!opened||closing)throw Error('NEWS_NOT_READY');assertWriter();
  const url=new URL(message.url,'http://native-news.invalid');
  if(!/^\/api\/(?:public\/news|admin\/news|news)(?:\/|$)/.test(url.pathname)||url.search.length>8192)throw Error('NEWS_INVALID_REQUEST');
  const headers=new Headers();if(message.origin)headers.set('origin',message.origin);if(message.contentType)headers.set('content-type',message.contentType);
  if(typeof message.analyticsOperationId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(message.analyticsOperationId))headers.set('x-relay-analytics-operation',message.analyticsOperationId);
  const request=new Request(url,{method:message.method,headers,...(message.body?{body:message.body}:{})});requests.set(request,{id:message.id,clientId:message.clientId,facts:[]});
  try{
    const response=await app.fetch(request),body=await response.arrayBuffer();assertWriter();
    if(body.byteLength>4*1024*1024)throw Error('NEWS_RESULT_LIMIT');
    const result={type:'result',id:message.id,ok:true,value:{status:response.status,headers:[...response.headers].filter(([key])=>['content-type','cache-control','retry-after'].includes(key)),body,facts:requests.get(request)!.facts}};
    parentPort!.postMessage(result,[body]);
  }finally{requests.delete(request);}
}
let controls=Promise.resolve();
parentPort!.on('message',(message:any)=>{
  if(message.type==='authorized'){
    const pending=authPending.get(message.authId);if(!pending)return;authPending.delete(message.authId);clearTimeout(pending.timer);
    if(message.actor)pending.resolve(message.actor);else pending.reject(new HTTPException(403));return;
  }
  if(message.type==='http'){
    if(httpPending.size>=8){parentPort!.postMessage({type:'result',id:message.id,ok:false,code:'NEWS_BUSY'});return;}
    const pending=http(message).catch(()=>{parentPort!.postMessage({type:'result',id:message.id,ok:false,code:'NEWS_UNAVAILABLE'});});httpPending.add(pending);void pending.finally(()=>httpPending.delete(pending));return;
  }
  if(message.type==='control')controls=controls.then(async()=>{
    try{const value=await control(message.action);parentPort!.postMessage({type:'result',id:message.id,ok:true,value});}
    catch{parentPort!.postMessage({type:'result',id:message.id,ok:false,code:'NEWS_UNAVAILABLE'});}
    finally{if(message.action==='close')parentPort!.close();}
  });
});
parentPort!.postMessage({type:'ready'});
