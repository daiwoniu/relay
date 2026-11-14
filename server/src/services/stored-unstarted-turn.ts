import { createHash,randomUUID } from 'node:crypto';
import type { CoreStoragePort,QueueClaim } from '../storage/contracts.js';
import { canonicalJson,operationIdentity } from '../storage/command-boundary.js';
import { classifyTurnPreparationError } from './turn-preparation-error.js';
type Projection=import('../storage/contracts.js').CoreCommandOutputs['queue.finishUnstarted'];

/** Use only as the native scheduler's failed callback. Never invoke for recovered/unknown started turns. */
export class StoredUnstartedTurnFailure {
  constructor(private readonly port:Pick<CoreStoragePort,'execute'|'lookup'>,private readonly options:{storeId:string;generation:number;
    assertExclusiveWriter:()=>Promise<void>;committed:(claim:QueueClaim,projection:Projection)=>Promise<void>;unconfirmed:()=>void}){}
  async handle(claim:QueueClaim,error:unknown,context:{effectStarted:boolean}):Promise<void>{
    if(context.effectStarted){this.options.unconfirmed();return;}
    const digest=createHash('sha256').update(canonicalJson(claim)).digest('hex');
    const request={protocolVersion:1 as const,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),
      operationId:'unstarted:'+digest,principal:{kind:'system',purpose:'scheduler'} as const,
      command:{name:'queue.finishUnstarted' as const,input:{claim:{...claim},messageId:'unstarted-message:'+digest,diagnostic:classifyTurnPreparationError(error)}}};
    await this.options.assertExclusiveWriter();
    // The claim-bound identity is stable even if a later caller has a different exception description.
    const prior=await this.port.lookup({storeId:this.options.storeId,operationId:request.operationId,principal:request.principal});
    if(prior.state==='committed'&&prior.commandName==='queue.finishUnstarted'){await this.options.committed(claim,prior.value);return;}
    const result=await this.port.execute(request);
    if(result.state==='committed'){await this.options.committed(claim,result.value);return;}
    if(result.state==='unknown'){
      const receipt=await this.port.lookup({storeId:this.options.storeId,operationId:request.operationId,principal:request.principal,
        expected:{commandName:'queue.finishUnstarted',inputDigest:operationIdentity(request).inputDigest}});
      if(receipt.state==='committed'&&receipt.commandName==='queue.finishUnstarted'){await this.options.committed(claim,receipt.value);return;}
    }
    this.options.unconfirmed();
  }
}
