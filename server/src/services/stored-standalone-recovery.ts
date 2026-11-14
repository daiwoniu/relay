import { createHash,randomUUID } from 'node:crypto';
import type { CoreStoragePort } from '../storage/contracts.js';
import { operationIdentity,StorageContractError } from '../storage/command-boundary.js';

/** Startup-only, before any runtime is registered. Never invokes an engine or replays an answer. */
export async function recoverStoredStandalone(options:{port:CoreStoragePort;storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>}){
  const principal={kind:'system',purpose:'recovery'} as const;
  const blocked:Array<{interactionId:string;sessionId:string;phase:'prepared'|'submitted'}>=[];
  let after:string|null=null,closed=0,seen=0;
  do{
    await options.assertExclusiveWriter();
    const page=await options.port.readPendingStandalone({principal,after,limit:64});
    for(const record of page.records){
      if(++seen>4096)throw new StorageContractError('PAYLOAD_TOO_LARGE');
      if(record.responsePhase){blocked.push({interactionId:record.interactionId,sessionId:record.sessionId,phase:record.responsePhase});continue;}
      const operationId='standalone-recovery:'+createHash('sha256').update(record.interactionId).digest('hex');
      const request={protocolVersion:1 as const,storeId:options.storeId,workerGeneration:options.generation,requestId:randomUUID(),operationId,principal,
        command:{name:'turn.closeStandalone' as const,input:{sessionId:record.sessionId,interactionId:record.interactionId}}};
      await options.assertExclusiveWriter();const result=await options.port.execute(request);
      if(result.state==='rejected')throw new StorageContractError(result.code);
      if(result.state==='unknown'){
        const receipt=await options.port.lookup({storeId:options.storeId,operationId,principal,expected:{commandName:request.command.name,inputDigest:operationIdentity(request).inputDigest}});
        if(receipt.state!=='committed'||receipt.commandName!==request.command.name)throw new StorageContractError('STORAGE_UNAVAILABLE');
      }
      closed++;
    }
    if(page.next!==null&&(page.next===after||!page.records.length))throw new StorageContractError('STORAGE_UNAVAILABLE');
    after=page.next;
  }while(after!==null);
  return{closed,blocked};
}
