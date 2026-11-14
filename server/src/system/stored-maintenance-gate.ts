import { createHash,randomUUID } from 'node:crypto';
import type { CoreStoragePort,CoreCommandInputs,StorageCommandEnvelope } from '../storage/contracts.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { StorageContractError } from '../storage/command-boundary.js';

/** Durable admission gate. Neither timeout, process exit nor close implies release. */
export class StoredMaintenanceGate{
  private closed=false;private readonly pending=new Set<Promise<unknown>>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>}){}
  private command<K extends 'maintenance.acquire'|'maintenance.release'>(name:K,input:CoreCommandInputs[K]){
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    if(this.pending.size>=8)return Promise.reject(new StorageContractError('OVERLOADED'));
    const intent={protocolVersion:1 as const,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),
      operationId:name+':'+createHash('sha256').update(input.fenceId).digest('hex'),principal:{kind:'system' as const,purpose:'maintenance' as const},command:{name,input}};
    const run=(async()=>{await this.options.assertExclusiveWriter();return executeStoredCommand<K>(this.options.port,intent as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}});})();
    this.pending.add(run);void run.finally(()=>this.pending.delete(run)).catch(()=>undefined);return run;
  }
  acquire(input:CoreCommandInputs['maintenance.acquire']){return this.command('maintenance.acquire',input);}
  release(fenceId:string){return this.command('maintenance.release',{fenceId});}
  read(){if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));return this.options.port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}});}
  async close(){this.closed=true;await Promise.allSettled([...this.pending]);}
}
