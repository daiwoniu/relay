import { Worker } from 'node:worker_threads';
import type { Actor } from '../auth/authorization.js';
import type { CoreStoragePort,StoragePrincipal } from '../storage/contracts.js';
import type { StoreWriterProof } from '../storage/store-owner.js';
import type { NewsSource } from './sources/source-types.js';
import { StorageContractError } from '../storage/command-boundary.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;principal:Principal|null;admin:boolean};
export class StoredNews{
  private readonly worker:Worker;
  private readonly ready:Promise<void>;
  private readonly exited:Promise<void>;
  private closing=false;private closed=false;private startupFailed=false;private sequence=0;private activeHttp=0;
  private readonly pending=new Map<number,Pending>();
  private readonly physical=new Set<Promise<unknown>>();
  private closingTask:Promise<void>|undefined;
  constructor(private readonly options:{port:Pick<CoreStoragePort,'readFrontendAccess'>;root:string;writerProof:StoreWriterProof;assertExclusiveWriter:()=>Promise<void>;sources?:NewsSource[];timeoutMs?:number;bodyTimeoutMs?:number;initialize?:boolean}){
    if(!Number.isSafeInteger(options.timeoutMs??45000)||(options.timeoutMs??45000)<1||(options.timeoutMs??45000)>120000)throw new StorageContractError('INVALID_ARGUMENT');
    if(!Number.isSafeInteger(options.bodyTimeoutMs??15000)||(options.bodyTimeoutMs??15000)<1||(options.bodyTimeoutMs??15000)>60000)throw new StorageContractError('INVALID_ARGUMENT');
    this.worker=new Worker(new URL('./stored-news-worker-bootstrap.mjs',import.meta.url),{workerData:{root:options.root,proof:options.writerProof,sources:options.sources,initialize:options.initialize}});
    let readyResolve!:()=>void,readyReject!:(error:Error)=>void;
    this.ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void this.ready.catch(()=>undefined);
    this.worker.on('message',message=>{
      if(message.type==='ready'){readyResolve();return;}
      if(message.type==='authorize'){void this.authorize(message);return;}
      if(message.type==='result'){const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);if(message.ok)request.resolve(message.value);else request.reject(new StorageContractError('STORAGE_UNAVAILABLE'));}
    });
    this.worker.on('error',()=>{this.startupFailed=true;readyReject(new StorageContractError('STORAGE_UNAVAILABLE'));});
    this.exited=new Promise<void>(resolve=>this.worker.on('exit',()=>{this.closed=true;readyReject(new StorageContractError('STORAGE_UNAVAILABLE'));for(const item of this.pending.values())item.reject(new StorageContractError('STORAGE_UNAVAILABLE'));this.pending.clear();resolve();}));
  }
  private async actor(principal:Principal|null,admin:boolean):Promise<Actor>{
    if(!principal)throw new StorageContractError('FORBIDDEN');
    const access=await this.options.port.readFrontendAccess({principal,resource:null});
    if(!access?.allowed||access.user.id!==principal.userId||admin&&access.user.role!=='admin')throw new StorageContractError('FORBIDDEN');
    return{userId:access.user.id,role:access.user.role};
  }
  private async authorize(message:{authId:number;requestId:number;admin:boolean}){
    const request=this.pending.get(message.requestId);let actor:Actor|null=null;
    try{if(request&&request.admin===message.admin){await this.options.assertExclusiveWriter();actor=await this.actor(request.principal,message.admin);}}catch{/* Return no credentials, SQL detail or stale actor on authorization failure. */}
    if(!this.closed)this.worker.postMessage({type:'authorized',authId:message.authId,actor});
  }
  private async rpc<T>(message:Record<string,unknown>,principal:Principal|null=null,admin=false):Promise<T>{
    await this.ready;if(this.closed)throw new StorageContractError('NOT_SUBMITTED');
    if(message.action!=='close')await this.options.assertExclusiveWriter();
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');if(this.pending.size>=8)throw new StorageContractError('OVERLOADED');const id=++this.sequence;
    const physical=new Promise<T>((resolve,reject)=>{this.pending.set(id,{resolve,reject,principal,admin});try{const body=message.body;this.worker.postMessage({...message,id},body instanceof ArrayBuffer?[body]:[]);}catch{this.pending.delete(id);reject(new StorageContractError('NOT_SUBMITTED'));}});
    this.physical.add(physical);void physical.finally(()=>this.physical.delete(physical)).catch(()=>undefined);
    return new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('NEWS_OUTCOME_UNKNOWN')),this.options.timeoutMs??45000);void physical.then(resolve,reject).finally(()=>clearTimeout(timer));});
  }
  private control(action:'initialize'|'resume'){
    if(this.closing)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    const work=this.rpc({type:'control',action});this.physical.add(work);void work.finally(()=>this.physical.delete(work)).catch(()=>undefined);return work;
  }
  initialize(){return this.control('initialize');}
  resume(){return this.control('resume');}
  async request(principal:Principal|null,request:Request,clientId:string){
    if(this.closing||this.activeHttp>=8||this.pending.size>=8)throw new StorageContractError(this.closing?'NOT_SUBMITTED':'OVERLOADED');
    this.activeHttp++;
    const work=(async()=>{
      const url=new URL(request.url),admin=url.pathname.startsWith('/api/admin/news'),isPublic=url.pathname.startsWith('/api/public/news');
      if(!/^\/api\/(?:public\/news|admin\/news|news)(?:\/|$)/.test(url.pathname)||url.search.length>8192)throw new StorageContractError('INVALID_ARGUMENT');
      if(!isPublic)await this.actor(principal,admin);
      let body:ArrayBuffer|undefined;
      if(request.body){
        const reader=request.body.getReader(),parts:Uint8Array[]=[];let size=0,timedOut=false;
        const timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>undefined);},this.options.bodyTimeoutMs??15000);
        try{for(;;){const value=await reader.read();if(timedOut)throw new StorageContractError('NOT_SUBMITTED');if(value.done)break;size+=value.value.byteLength;if(size>2*1024*1024){await reader.cancel();throw new StorageContractError('PAYLOAD_TOO_LARGE');}parts.push(value.value);}const joined=new Uint8Array(size);let offset=0;for(const part of parts){joined.set(part,offset);offset+=part.byteLength;}body=joined.buffer;}
        finally{clearTimeout(timer);reader.releaseLock();}
      }
      const result=await this.rpc<{status:number;headers:Array<[string,string]>;body:ArrayBuffer}>({type:'http',url:url.pathname+url.search,method:request.method,origin:request.headers.get('origin'),contentType:request.headers.get('content-type'),body,clientId:clientId.slice(0,128)},principal,admin);
      if(!isPublic)await this.actor(principal,admin);await this.options.assertExclusiveWriter();return new Response(result.body,{status:result.status,headers:result.headers});
    })();
    this.physical.add(work);try{return await work;}finally{this.physical.delete(work);this.activeHttp--;}
  }
  close(){
    if(this.closingTask)return this.closingTask;this.closing=true;
    this.closingTask=(async()=>{await this.ready.catch(()=>undefined);while(this.physical.size)await Promise.allSettled([...this.physical]);try{if(!this.closed&&!this.startupFailed)await this.rpc({type:'control',action:'close'});}finally{await this.exited;}})();
    return this.closingTask;
  }
}
