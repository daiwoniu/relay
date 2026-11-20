import { createHash,randomUUID } from 'node:crypto';
import { SendCommandSchema,type SendCommand,type EngineId,type MessageOriginDto } from '../contracts/index.js';
import type { CoreStoragePort,StoragePrincipal,CoreCommandOutputs } from '../storage/contracts.js';
import { canonicalJson,StorageContractError,operationIdentity } from '../storage/command-boundary.js';
import type { StoredRuntimeGraph } from '../ws/stored-runtime-graph.js';
import type { StoredMessageAttachments } from './stored-message-attachments.js';
import type { EngineRegistry } from '../engine/registry.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { AttachmentAvailability } from '../messages/presenter.js';
import { validateEnginePreferences } from '../engine/models/preferences.js';
import { serializeMessageMetadata } from '../message-metadata.js';

type Actor=Extract<StoragePrincipal,{kind:'user'}>;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value,512*1024)).digest('hex');
function attemptFor(value:string){return`${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-8${value.slice(17,20)}-${value.slice(20,32)}`;}
export function sendIntentDigest(command:SendCommand){return hash({...command,attachments:command.attachments?.map(item=>{if(item.kind!=='host_file')return item;const{accessToken:_,...publicFile}=item;return publicFile;})??[]});}

/** Browser send admission. Client intent, queue/followup and receipt share one Native transaction. */
export class StoredSend {
  private readonly tails=new Map<string,Promise<unknown>>();private pending=0;private closed=false;
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;graph:StoredRuntimeGraph;
    attachments:Pick<StoredMessageAttachments,'prepare'>;registry:Pick<EngineRegistry,'get'>;
    getCatalog:(engine:EngineId,options?:{preferCached?:boolean})=>Promise<EngineModelCatalog>;assertExclusiveWriter:()=>Promise<void>;attachmentAvailability:AttachmentAvailability;
    assertAdmission:(engine:EngineId)=>Promise<void>;
    validateAsyncQuestion?:(actor:Actor,command:SendCommand,engine:EngineId)=>Promise<void>;
    workspaceTaskLink:(actor:Actor,command:SendCommand)=>Promise<{taskId:string;workspacePath:string;workspaceId?:string;connectionScope?:string;targetRef?:string}|undefined>;
  }){}
  send(actor:Actor,raw:SendCommand,origin:MessageOriginDto){
    let command:SendCommand;try{command=SendCommandSchema.parse(JSON.parse(canonicalJson(raw,512*1024)));}catch{return Promise.reject(new StorageContractError('INVALID_ARGUMENT'));}
    if(!command.messageId||origin.senderUserId!==actor.userId||(!command.content.trim()&&!command.attachments?.length))return Promise.reject(new StorageContractError('INVALID_ARGUMENT'));
    if(this.closed||this.pending>=64||!this.tails.has(command.sessionId)&&this.tails.size>=128)return Promise.reject(new StorageContractError(this.closed?'NOT_SUBMITTED':'OVERLOADED'));
    actor=Object.freeze({...actor});origin=structuredClone(origin);const key=command.sessionId;
    this.pending++;const previous=this.tails.get(key)??Promise.resolve(),run=previous.catch(()=>{}).then(()=>this.run(actor,command,origin));this.tails.set(key,run);
    void run.finally(()=>{this.pending--;if(this.tails.get(key)===run)this.tails.delete(key);}).catch(()=>{});return run;
  }
  private async receipt(actor:Actor,command:SendCommand,digest:string){
    return this.options.port.readSendReceipt({principal:actor,sessionId:command.sessionId,messageId:command.messageId!,intentDigest:digest});
  }
  private async publish(value:CoreCommandOutputs['turn.enqueue']){
    const {port,graph,attachmentAvailability}=this.options;
    try{await graph.hub.broadcastMessage(value,{readSession:port.readSession.bind(port),attachmentAvailability,isCurrent:()=>!this.closed});await graph.refresh(value.savedMessage.sessionId);}catch{/* Durable history and reconnect snapshots repair publication. */}
  }
  private async run(actor:Actor,command:SendCommand,origin:MessageOriginDto){
    const {port,graph}=this.options,digest=sendIntentDigest(command),prior=await this.receipt(actor,command,digest);
    if(prior.state==='committed')return{kind:prior.kind,replayed:true};
    if(prior.state!=='not-found')throw new StorageContractError(prior.state==='expired'?'OPERATION_EXPIRED':'STORAGE_UNAVAILABLE');
    const current=await port.readSessionSync({principal:actor,sessionId:command.sessionId,includeMessages:false}),session=current.session;
    const engine=session.engine??command.engine;if(!engine)throw new StorageContractError('INVALID_ARGUMENT');
    if(session.engine&&command.engine&&command.engine!==session.engine)throw new StorageContractError('CONFLICT');
    await this.options.assertAdmission(engine);
    if(!session.project_id)throw new StorageContractError('NOT_FOUND');
    if(command.replyToAsyncQuestionId&&(engine!=='codex'||!await port.checkAsyncQuestionAnswer({principal:actor,sessionId:command.sessionId,questionId:command.replyToAsyncQuestionId,messageId:command.messageId!})))throw new StorageContractError('CONFLICT');
    await this.options.validateAsyncQuestion?.(actor,command,engine);
    const preferences=session.engine?session.engine_preferences:command.enginePreferences??{modelId:null,reasoningEffort:null,serviceTier:null,revision:0};
    const busy=(value:typeof current)=>!!value.activeAttemptId||!!value.queue||!!value.followups?.some(record=>!['steered','delivered','cancelled'].includes(record.state));
    const link=await this.options.workspaceTaskLink(actor,command);
    if(!busy(current)){
      const adapter=this.options.registry.get(engine);if(!adapter.availability.getCurrent().available)throw new StorageContractError('NOT_SUBMITTED');
      validateEnginePreferences(await this.options.getCatalog(engine,{preferCached:true}),preferences);
    }
    const attachments=await this.options.attachments.prepare(actor,session.project_id,command.messageId!,command.attachments??[]);
    const fresh=await port.readSessionSync({principal:actor,sessionId:command.sessionId,includeMessages:false});
    if(fresh.session.project_id!==session.project_id||fresh.session.engine!==session.engine||fresh.session.engine_preferences.revision!==session.engine_preferences.revision)throw new StorageContractError('CONFLICT');
    if(busy(fresh)){
      if(link)throw new StorageContractError('CONFLICT');
      await graph.followups.submit(actor,{sessionId:command.sessionId,messageId:command.messageId!,content:command.content.trim(),attachments,
        replyToAsyncQuestionId:command.replyToAsyncQuestionId??null,origin,clientIntentDigest:digest});
      return{kind:'followup' as const,replayed:false};
    }
    if(busy(current)){
      const adapter=this.options.registry.get(engine);if(!adapter.availability.getCurrent().available)throw new StorageContractError('NOT_SUBMITTED');
      validateEnginePreferences(await this.options.getCatalog(engine,{preferCached:true}),preferences);
    }
    const resource=this.options.registry.get(engine).concurrency?.resolveResource({sessionId:session.id,projectId:session.project_id});if(!resource)throw new StorageContractError('NOT_SUPPORTED');
    const identity=hash([this.options.storeId,actor.userId,command.sessionId,command.messageId]);
    const metadata=serializeMessageMetadata({attachments,origin,clientDiagnostics:command.clientDiagnostics,replyToAsyncQuestionId:command.replyToAsyncQuestionId});
    const request={protocolVersion:1 as const,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),operationId:'send:'+identity,principal:actor,
      command:{name:'turn.enqueue' as const,input:{sessionId:session.id,attemptId:attemptFor(identity),messageId:command.messageId!,engineId:engine,resourceKey:resource.resourceKey,
        content:command.content.trim(),metadata:metadata?JSON.parse(metadata):null,expectedPreferencesRevision:preferences.revision,clientIntentDigest:digest,origin:{kind:'direct' as const},
        ...(session.engine?{}:{bind:{modelId:preferences.modelId,reasoningEffort:preferences.reasoningEffort,serviceTier:preferences.serviceTier??null}}),...(link?{workspaceTaskLink:link}:{})}}};
    await this.options.assertExclusiveWriter();const result=await port.execute(request);
    let value:CoreCommandOutputs['turn.enqueue'];
    if(result.state==='committed')value=result.value;
    else if(result.state==='unknown'){
      const receipt=await port.lookup({storeId:this.options.storeId,operationId:request.operationId,principal:actor,expected:{commandName:'turn.enqueue',inputDigest:operationIdentity(request).inputDigest}});
      if(receipt.state!=='committed'||receipt.commandName!=='turn.enqueue')throw new StorageContractError('STORAGE_UNAVAILABLE');value=receipt.value;
    }else throw new StorageContractError(result.code);
    await this.publish(value);void graph.scheduler.drain(resource.resourceKey).catch(()=>{});return{kind:'turn' as const,replayed:false};
  }
  async close(){this.closed=true;await Promise.allSettled([...this.tails.values()]);}
}
