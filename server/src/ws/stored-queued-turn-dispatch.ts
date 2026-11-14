import type { CoreStoragePort,QueueClaim,StoredClaimedTurn } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { StoredDispatchContext } from '../engine/concurrency/stored-scheduler.js';

type PreparedTurn={invoke:()=>Promise<void>;release:(state:{invoked:boolean})=>Promise<void>};
export interface StoredQueuedTurnPorts {
  /** No send/start-turn here. Clean partial preparation on rejection. Release only preparation ownership;
   * invoked=true may represent an unknown engine result and must not dispose/retry its live runtime. */
  prepare:(claim:QueueClaim,payload:StoredClaimedTurn,signal:AbortSignal,engineInput?:string)=>Promise<PreparedTurn>;
  prepareInput?:(claim:QueueClaim,payload:StoredClaimedTurn,signal:AbortSignal)=>Promise<string>;
}

/** Loads only the committed message. The complete native runtime/adapter graph binds prepare in T5/T6. */
export class StoredQueuedTurnDispatcher {
  constructor(private readonly port:Pick<CoreStoragePort,'readClaimedTurn'>,private readonly ports:StoredQueuedTurnPorts){}
  async start(claim:QueueClaim,context:StoredDispatchContext):Promise<void>{
    if(context.signal.aborted)throw new StorageContractError('STORAGE_UNAVAILABLE');
    const payload=await this.port.readClaimedTurn({principal:{kind:'system',purpose:'scheduler'},claim});
    if(context.signal.aborted)throw new StorageContractError('STORAGE_UNAVAILABLE');
    if(!payload)throw new StorageContractError('CONFLICT');
    if(payload.message.id!==claim.userMessageId||payload.message.sessionId!==claim.sessionId||payload.message.attemptId!==claim.attemptId)throw new StorageContractError('CONFLICT');
    // Attachment promotion and image capability validation must join the native admission graph first.
    if(payload.message.metadata!==null){
      let metadata:unknown;try{metadata=JSON.parse(payload.message.metadata);}catch{throw new StorageContractError('STORAGE_UNAVAILABLE');}
      if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw new StorageContractError('STORAGE_UNAVAILABLE');
      if(Object.hasOwn(metadata,'attachments')){
        const attachments=(metadata as {attachments?:unknown}).attachments;
        if(!Array.isArray(attachments))throw new StorageContractError('STORAGE_UNAVAILABLE');
        if(attachments.length&&!this.ports.prepareInput)throw new StorageContractError('NOT_SUPPORTED');
      }
    }
    const digest=payload.sourceDigest;
    Object.freeze(payload.message);Object.freeze(payload.session);Object.freeze(payload);
    const engineInput=this.ports.prepareInput?await this.ports.prepareInput(claim,payload,context.signal):undefined;
    if(engineInput!==undefined&&(typeof engineInput!=='string'||Buffer.byteLength(engineInput)>1024*1024))throw new StorageContractError('PAYLOAD_TOO_LARGE');
    const prepared=await this.ports.prepare(claim,payload,context.signal,engineInput);
    let invoked=false;
    try{
      if(context.signal.aborted)throw new StorageContractError('STORAGE_UNAVAILABLE');
      // Snapshot changes during async model/connection preparation cannot start the old payload.
      await context.dispatch(()=>{invoked=true;return prepared.invoke();},{sourceDigest:digest});
    }finally{await prepared.release({invoked});}
  }
}
