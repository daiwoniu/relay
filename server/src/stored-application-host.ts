import { StoreOwner } from './storage/store-owner.js';
import { StorageWorkerClient,type StorageWorkerOptions } from './storage/worker-client.js';
import { StoredRuntimeGraph,type StoredRuntimeGraphOptions } from './ws/stored-runtime-graph.js';
import { createStoredHttpApplication,type StoredHttpApplicationOptions } from './stored-http-application.js';
import { StorageContractError } from './storage/command-boundary.js';
import type { StoreWriterProof } from './storage/store-owner.js';

type DomainHttp=Omit<StoredHttpApplicationOptions,'port'|'storeId'|'generation'|'graph'|'ready'>;
export interface StoredApplicationScope {
  port:StorageWorkerClient;graph:StoredRuntimeGraph;storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;ready:()=>boolean;
  writerProof:StoreWriterProof;
  /** Register immediately after construction, so partial startup cannot orphan a Worker or timer. */
  own<T>(resource:T,close:(resource:T)=>void|Promise<void>):T;
}
export interface StoredApplicationHostOptions {
  storage:Omit<StorageWorkerOptions,'initialize'>;
  storageOwner?:StoreOwner;
  graph:Omit<StoredRuntimeGraphOptions,'port'|'storeId'|'generation'|'assertExclusiveWriter'>;
  afterRuntimeSuspend?:()=>Promise<void>;
  build:(scope:StoredApplicationScope)=>Promise<{http:DomainHttp;recover:()=>Promise<void>;resume:()=>Promise<void>}>;
}

/** Explicit candidate lifecycle. Construction opens no listener and never activates recovery or engine dispatch. */
export class StoredApplicationHost {
  private state:'prepared'|'starting'|'ready'|'closing'|'closed'='prepared';
  private closing:Promise<void>|undefined;
  private starting:Promise<unknown>|undefined;
  private http:ReturnType<typeof createStoredHttpApplication>|undefined;
  private domain:Awaited<ReturnType<StoredApplicationHostOptions['build']>>|undefined;
  private readonly disposers:Array<()=>void|Promise<void>>=[];
  private constructor(private readonly owner:StoreOwner,readonly port:StorageWorkerClient,readonly graph:StoredRuntimeGraph,private readonly afterRuntimeSuspend?:()=>Promise<void>){}
  static async open(options:StoredApplicationHostOptions){
    const owner=options.storageOwner??await StoreOwner.acquire(options.storage.filename);let port:StorageWorkerClient;
    if(owner.filename!==options.storage.filename){if(!options.storageOwner)await owner.release();throw new StorageContractError('CONFLICT');}
    try{await owner.assertCurrent();port=await StorageWorkerClient.open({...options.storage,filename:owner.filename,initialize:false,beforeDispatch:()=>owner.assertCurrent()});}
    catch(error){await owner.release();throw error;}
    let graph:StoredRuntimeGraph;
    try{graph=new StoredRuntimeGraph({...options.graph,port,storeId:options.storage.storeId,generation:options.storage.generation,assertExclusiveWriter:()=>owner.assertCurrent()});}
    catch(error){await port.close();await owner.release();throw error;}
    const host=new StoredApplicationHost(owner,port,graph,options.afterRuntimeSuspend);
    try{
      host.domain=await options.build({port,graph,storeId:options.storage.storeId,generation:options.storage.generation,assertExclusiveWriter:()=>owner.assertCurrent(),writerProof:owner.writerProof,ready:()=>host.state==='ready',
        own:(resource,close)=>{host.disposers.push(()=>close(resource));return resource;}});
      host.http=createStoredHttpApplication({...host.domain.http,port,storeId:options.storage.storeId,generation:options.storage.generation,graph,ready:()=>host.state==='ready'});
      await owner.assertCurrent();return host;
    }catch(error){
      try{await host.close();}catch{throw new AggregateError([error],'NATIVE_STARTUP_CLEANUP_UNCONFIRMED');}
      throw error;
    }
  }
  get app(){if(!this.http)throw new StorageContractError('NOT_SUBMITTED');return this.http.app;}
  get status(){return this.state;}
  activate(){
    if(this.state!=='prepared'||!this.domain)return Promise.reject(new StorageContractError('CONFLICT'));this.state='starting';
    const current=async()=>{await this.owner.assertCurrent();if(this.state!=='starting')throw new StorageContractError('NOT_SUBMITTED');};
    const run=(async()=>{
      await current();await this.domain!.recover();
      await current();const recovery=await this.graph.restoreStartup();
      await current();await this.domain!.resume();
      await current();this.state='ready';return recovery;
    })();this.starting=run;return run;
  }
  close():Promise<void>{
    if(this.state==='closed')return Promise.resolve();if(this.closing)return this.closing;this.state='closing';
    const run=(async()=>{
      await this.http?.dispose();
      await this.starting?.catch(()=>undefined);
      // A failing/unknown physical closer retains both the DB connection and application owner.
      while(this.disposers.length){await this.disposers.at(-1)!();this.disposers.pop();}
      await this.graph.suspend();await this.afterRuntimeSuspend?.();await this.port.close();await this.owner.release();this.state='closed';
    })();this.closing=run;
    void run.catch(()=>{if(this.closing===run)this.closing=undefined;});return run;
  }
}
