import { Worker } from 'node:worker_threads';
import type { AnalyticsQuery } from './contract.js';

/** Lazy dedicated read connection. Bounded queue, TTL cache and a hard query deadline. */
export class AnalyticsReader {
  private worker:Worker|null=null;
  private tail:Promise<unknown>=Promise.resolve();
  private pending=0;
  private closed=false;
  private cache=new Map<string,{until:number;value:{data:unknown;asOf:number;cached:boolean}}>();
  private reads=new Map<string,Promise<{data:unknown;asOf:number;cached:boolean}>>();
  constructor(private filename:string){}
  read(view:'summary'|'visits'|'features'|'actions',query:AnalyticsQuery,cursor?:{at:number;id:string}){
    return this.readSnapshot(view,query,cursor).then(snapshot=>snapshot.data);
  }
  readSnapshot(view:'summary'|'visits'|'features'|'actions',query:AnalyticsQuery,cursor?:{at:number;id:string},fresh=false){
    if(this.closed)return Promise.reject(Error('ANALYTICS_CLOSED'));
    const key=JSON.stringify([view,query,cursor]),cached=this.cache.get(key);
    if(cached&&cached.until>Date.now()&&(!fresh||Date.now()-cached.value.asOf<5000))return Promise.resolve({...cached.value,cached:true});
    const active=this.reads.get(key);if(active)return active;
    const work=this.request({view,query,cursor,snapshot:true}).then(raw=>{
      const value=raw as {data:unknown;asOf:number;cached:boolean};
      if(this.cache.size>=16)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key,{value,until:Date.now()+15_000});return value;
    }).finally(()=>this.reads.delete(key));
    this.reads.set(key,work);return work;
  }
  actor(sessionId:string,decisionId:string){return this.request({view:'actor',sessionId,decisionId}) as Promise<{userId:string;role:'admin'|'member'}|null>;}
  private request(message:object):Promise<unknown>{
    if(this.closed||this.pending>=5)return Promise.reject(Error('ANALYTICS_BUSY'));
    this.pending++;
    const work=this.tail.then(()=>new Promise((resolve,reject)=>{
      if(this.closed){reject(Error('ANALYTICS_CLOSED'));return;}
      if(!this.worker){
        const created=new Worker(new URL('./reader-bootstrap.mjs',import.meta.url),{workerData:{filename:this.filename}});
        created.on('error',()=>{/* Per-request failure handler below rejects the pending read. */});
        created.on('exit',()=>{if(this.worker===created)this.worker=null;});this.worker=created;
      }
      const worker=this.worker;
      const cleanup=()=>{clearTimeout(timer);worker.off('message',received);worker.off('error',failed);worker.off('exit',exited);};
      const failed=()=>{cleanup();if(this.worker===worker)this.worker=null;void worker.terminate();reject(Error('ANALYTICS_UNAVAILABLE'));};
      const exited=()=>failed();
      const received=(result:{value?:unknown;error?:string})=>{cleanup();result.error?reject(Error(result.error)):resolve(result.value);};
      const timer=setTimeout(failed,5000);
      worker.once('message',received);worker.once('error',failed);worker.once('exit',exited);worker.postMessage(message);
    })).finally(()=>{this.pending--;});
    this.tail=work.catch(()=>undefined);return work;
  }
  async close(){this.closed=true;this.cache.clear();if(this.worker){await this.worker.terminate();this.worker=null;}await this.tail;}
}
