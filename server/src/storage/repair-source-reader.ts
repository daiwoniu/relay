import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { canonicalJson,RepairCandidateSchema,RepairEntrySchema,StorageContractError } from './command-boundary.js';
import type { RepairCandidate,RepairEntry } from './contracts.js';
/** At most two disposable read-only jobs; timed-out workers retain their slot until termination is confirmed. */
export class RepairSourceReader {
  private readonly active=new Set<Worker>();
  private readonly root: string;
  private readonly timeout: number;
  private closed=false;
  constructor(options:{root?:string;timeoutMs?:number}={}) {
    this.root=options.root??path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions'); this.timeout=options.timeoutMs??30_000;
    if (!path.isAbsolute(this.root)||!Number.isSafeInteger(this.timeout)||this.timeout<1||this.timeout>30_000) throw new StorageContractError('INVALID_ARGUMENT');
  }
  loadSnapshots(candidates:readonly RepairCandidate[]):Promise<RepairEntry[]> {
    if (this.closed) return Promise.reject(new StorageContractError('STORAGE_UNAVAILABLE'));
    if (!candidates.length) return Promise.resolve([]);
    if (this.active.size>=2) return Promise.reject(new StorageContractError('OVERLOADED'));
    let stable:RepairCandidate[]; try { canonicalJson(candidates,1024*1024); stable=z.array(RepairCandidateSchema).max(20).parse(candidates); }
    catch { return Promise.reject(new StorageContractError('INVALID_ARGUMENT')); }
    const requestId=randomUUID(),worker=new Worker(new URL('./repair-source-bootstrap.mjs',import.meta.url),{workerData:{requestId,root:this.root,candidates:stable},
      resourceLimits:{maxOldGenerationSizeMb:384,maxYoungGenerationSizeMb:32}});
    this.active.add(worker);
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(value?:RepairEntry[])=>{if(done)return;done=true;clearTimeout(timer);
        if(value)resolve(value);else reject(new StorageContractError('STORAGE_UNAVAILABLE'));
        void worker.terminate().catch(()=>undefined);};
      const timer=setTimeout(()=>finish(),this.timeout);timer.unref();
      worker.on('message',(message)=>{if(done||message.requestId!==requestId)return;
        if(message.error){finish();return;}
        try{canonicalJson(message.entries,6*1024*1024);finish(z.array(RepairEntrySchema).max(20).parse(message.entries));}catch{finish();}});
      worker.on('error',()=>finish());worker.on('exit',()=>{this.active.delete(worker);if(!done)finish();});
    });
  }
  async dispose():Promise<void>{this.closed=true;await Promise.all([...this.active].map((worker)=>worker.terminate()));}
}
