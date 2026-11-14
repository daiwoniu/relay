import { randomUUID } from 'node:crypto';
import type { CoreStoragePort,CoreCommandInputs,CoreCommandOutputs,CoreCommandName,StoragePrincipal,StorageCommandEnvelope } from '../storage/contracts.js';
import { StorageContractError,operationIdentity } from '../storage/command-boundary.js';
import type { SessionFollowupRecord } from '../db/session-followups.js';
import type { StoredStopBinding } from './stored-runtime-stop.js';
type Actor=Extract<StoragePrincipal,{kind:'user'}>;
type State=Awaited<ReturnType<CoreStoragePort['readFollowupState']>>;
const supervisor={kind:'system',purpose:'maintenance'} as const;

/** Async followup orchestration. Unknown external dispatch is retained, never silently replayed. */
export class StoredFollowups{
  private readonly tails=new Map<string,Promise<unknown>>();private closed=false;
  constructor(private readonly port:CoreStoragePort,private readonly options:{storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;
    getBinding:(id:string)=>StoredStopBinding|undefined;enqueue:(record:SessionFollowupRecord,state:State)=>Promise<void>;
    changed:(id:string)=>Promise<void>;accepted?:(message:CoreCommandOutputs['followup.confirmSteer'])=>Promise<void>;diagnostic:()=>void}){}
  private serialize<T>(id:string,work:()=>Promise<T>):Promise<T>{
    if(this.closed)return Promise.reject(new StorageContractError('STORAGE_UNAVAILABLE'));
    if(!this.tails.has(id)&&this.tails.size>=128)return Promise.reject(new StorageContractError('OVERLOADED'));
    const previous=this.tails.get(id)??Promise.resolve(),next=previous.catch(()=>{}).then(work);this.tails.set(id,next);
    void next.finally(()=>{if(this.tails.get(id)===next)this.tails.delete(id);}).catch(()=>{});return next;
  }
  private async execute<K extends CoreCommandName>(principal:StoragePrincipal,name:K,input:CoreCommandInputs[K],operationId:string=randomUUID()):Promise<{value:CoreCommandOutputs[K];replayed:boolean}>{
    await this.options.assertExclusiveWriter();
    const request={protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),operationId,principal,command:{name,input}} as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}};
    const result=await this.port.execute<K>(request);if(result.state==='committed')return result;
    if(result.state==='unknown'){
      const receipt=await this.port.lookup({storeId:this.options.storeId,operationId,principal,expected:{commandName:name,inputDigest:operationIdentity(request).inputDigest}});
      if(receipt.state==='committed'&&receipt.commandName===name)return{value:receipt.value as CoreCommandOutputs[K],replayed:true};
    }
    throw new StorageContractError(result.state==='rejected'?result.code:'STORAGE_UNAVAILABLE');
  }
  private report(){try{this.options.diagnostic();}catch{/* Fixed diagnostic only. */}}
  private async publishAccepted(value:CoreCommandOutputs['followup.confirmSteer']){try{await this.options.accepted?.(value);}catch{this.report();}}
  private async changed(id:string){try{await this.options.changed(id);}catch{this.report();}}
  private async transition(record:SessionFollowupRecord,to:SessionFollowupRecord['state'],errorCode:string|null=null,actor:StoragePrincipal=supervisor){
    const result=await this.execute(actor,'followup.transition',{sessionId:record.sessionId,id:record.id,from:record.state,to,errorCode});
    await this.changed(record.sessionId);return result.value;
  }
  submit(actor:Actor,input:CoreCommandInputs['followup.submit']){
    actor=Object.freeze({...actor});input=structuredClone(input);
    return this.serialize(input.sessionId,async()=>{
      await this.execute(actor,'followup.submit',input,`followup-submit:${input.messageId}`);
      const state=await this.port.readFollowupState({principal:actor,sessionId:input.sessionId,selectedId:input.messageId});
      let record=state.selected!;if(record.state!=='received')return record;
      await this.changed(record.sessionId);
      const binding=this.options.getBinding(record.sessionId),runtime=binding?.runtime,connection=runtime?.engineConnection,turnId=runtime?.currentTurnId;
      const attemptId=runtime?.attemptId,connectionId=runtime?.engineConnectionId,leaseToken=runtime?.leaseToken,version=binding?.version;
      if(binding&&runtime?.isRunning&&connection?.steer&&turnId&&!input.attachments.length){
        const selected=await this.execute(actor,'followup.prepareSteer',{sessionId:record.sessionId,id:record.id,attemptId:runtime.attemptId!,turnId},`followup-steer:${record.id}`);
        record=selected.value.record;
        if(selected.value.prepared){
          if(selected.replayed){this.report();return record;}
          if(this.options.getBinding(record.sessionId)!==binding||runtime.engineConnection!==connection||runtime.currentTurnId!==turnId||!runtime.isRunning
            ||runtime.attemptId!==attemptId||runtime.engineConnectionId!==connectionId||runtime.leaseToken!==leaseToken||binding.version!==version)
            return this.transition(record,'queued');
          let outcome:'accepted'|'turn_changed'|'unsupported';
          try{outcome=await connection.steer({content:record.content,messageId:record.id,expectedTurnId:turnId});}
          catch{return this.transition(record,'uncertain','STEER_RESULT_UNKNOWN');}
          if(outcome==='accepted'){
            try{
              const saved=await this.execute(supervisor,'followup.confirmSteer',{sessionId:record.sessionId,id:record.id},`followup-accepted:${record.id}`);
              await this.publishAccepted(saved.value);
              await this.changed(record.sessionId);return saved.value.record;
            }catch{
              const current=await this.port.readFollowupState({principal:supervisor,sessionId:record.sessionId,selectedId:record.id});
              if(current.selected?.state==='steered')return current.selected;
              return this.transition(record,'uncertain','STEER_MESSAGE_SAVE_FAILED');
            }
          }
        }
      }
      if(record.state==='received'||record.state==='steering')record=await this.transition(record,'queued');
      await this.dispatchNext(record.sessionId);return(await this.port.readFollowupState({principal:actor,sessionId:record.sessionId,selectedId:record.id})).selected!;
    });
  }
  private async dispatchNext(id:string){
    const state=await this.port.readFollowupState({principal:supervisor,sessionId:id});
    if(state.activeAttemptId||!['completed','idle'].includes(state.status)||this.options.getBinding(id)?.runtime.isRunning)return;
    const record=state.records[0];if(!record||record.state!=='queued')return;
    try{await this.options.enqueue(record,state);await this.changed(id);}
    catch{
      const current=await this.port.readFollowupState({principal:supervisor,sessionId:id,selectedId:record.id});
      if(current.selected?.state==='queued')await this.transition(current.selected,'paused','DISPATCH_FAILED');this.report();
    }
  }
  onTerminal(id:string,succeeded:boolean){return this.serialize(id,async()=>{
    if(!succeeded){const state=await this.port.readFollowupState({principal:supervisor,sessionId:id});
      for(const record of state.records)if(record.state==='queued')await this.transition(record,'paused','PREVIOUS_TURN_FAILED');
    }else await this.dispatchNext(id);
  });}
  cancel(actor:Actor,sessionId:string,id:string){return this.serialize(sessionId,async()=>{
    const state=await this.port.readFollowupState({principal:actor,sessionId,selectedId:id});const record=state.selected!;
    if(!['received','queued','paused','uncertain'].includes(record.state))throw new StorageContractError('CONFLICT');
    const result=await this.transition(record,'cancelled',null,actor);await this.dispatchNext(sessionId);return result;
  });}
  resume(actor:Actor,sessionId:string){return this.serialize(sessionId,async()=>{
    const state=await this.port.readFollowupState({principal:actor,sessionId});
    for(const record of state.records)if(record.state==='paused')await this.transition(record,'queued',null,actor);
    await this.dispatchNext(sessionId);
  });}
  recover(sessionId:string){return this.serialize(sessionId,async()=>{
    const state=await this.port.readFollowupState({principal:{kind:'system',purpose:'recovery'},sessionId});
    for(const record of state.records){
      if(record.state==='received')await this.transition(record,'queued');
      else if(record.state==='steering'||record.state==='dispatching')await this.transition(record,'uncertain','RESTART_RESULT_UNKNOWN');
      else if(record.state==='uncertain'&&record.errorCode==='STEER_MESSAGE_SAVE_FAILED'){
        try{const saved=await this.execute(supervisor,'followup.confirmSteer',{sessionId,id:record.id},`followup-accepted:${record.id}`);await this.publishAccepted(saved.value);}catch{this.report();}
      }
    }
    const current=await this.port.readFollowupState({principal:supervisor,sessionId});
    if(!current.activeAttemptId&&!['completed','idle'].includes(current.status)){
      for(const record of current.records)if(record.state==='queued')await this.transition(record,'paused','PREVIOUS_TURN_UNCONFIRMED');
    }else await this.dispatchNext(sessionId);await this.changed(sessionId);
  });}
  async close(){this.closed=true;await Promise.allSettled([...this.tails.values()]);}
}
