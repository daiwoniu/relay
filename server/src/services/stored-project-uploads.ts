import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CoreStoragePort,StoragePrincipal,UploadReadScope } from '../storage/contracts.js';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { ProjectUploadResponseDtoSchema,type UploadedFileDraftDto } from '../contracts/index.js';
import { IncomingUploadRequestSchema } from '../uploads/incoming-upload-contract.js';
import { IncomingUploadJournal } from '../uploads/incoming-upload-journal.js';
import { ProjectFileActivities } from '../uploads/project-file-activities.js';
import { UploadPublisher } from '../uploads/upload-publisher.js';
import { StoredUploadReads } from './stored-upload-reads.js';

type Principal=Extract<StoragePrincipal,{kind:'user'}>;
export const StoredUploadIntentSchema=IncomingUploadRequestSchema.pick({projectId:true,messageId:true,uploadId:true,name:true,mimeType:true,size:true});
export type StoredUploadIntent=z.infer<typeof StoredUploadIntentSchema>;
type Value=z.infer<typeof ProjectUploadResponseDtoSchema>;
type Outcome={state:'committed';value:Value}|{state:'rejected';code:'INVALID_ARGUMENT'|'FORBIDDEN'|'NOT_FOUND'|'PAYLOAD_TOO_LARGE'|'CONFLICT'|'NOT_SUBMITTED'|'OVERLOADED'}|{state:'unknown'};
const pending=new Map<string,{identity:string;result:Promise<Outcome>}>();
const uuid=(value:unknown)=>{const h=createHash('sha256').update(canonicalJson(value,16384)).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const cancel=(body:ReadableStream<Uint8Array>)=>{if(!body.locked)void body.cancel().catch(()=>undefined);};

/** File-only upload authority stays in manifests/journals; Native supplies fresh authorization and deletion fences. */
export class StoredProjectUploads{
  private closed=false;private readonly accepted=new Set<Promise<Outcome>>();private readonly controllers=new Set<AbortController>();
  private readonly reads:StoredUploadReads;private readonly publisher:Pick<UploadPublisher,'run'>;private readonly ownedPublisher:UploadPublisher|null;
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;files:ProjectFileActivities;assertExclusiveWriter:()=>Promise<void>;
    publisher?:Pick<UploadPublisher,'run'>;bodyTimeoutMs?:number;now?:()=>number}){
    this.options=Object.freeze({...options});if(!options.storeId||!Number.isSafeInteger(options.generation)||options.generation<1||options.bodyTimeoutMs!==undefined&&(!Number.isSafeInteger(options.bodyTimeoutMs)||options.bodyTimeoutMs<1||options.bodyTimeoutMs>600000))throw new StorageContractError('INVALID_ARGUMENT');
    this.ownedPublisher=options.publisher?null:new UploadPublisher();this.publisher=options.publisher??this.ownedPublisher!;
    this.reads=new StoredUploadReads({port:options.port,activity:scope=>options.files.snapshot(scope)});
  }
  private async scope(principal:Principal,projectId:string,expected?:UploadReadScope){
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');await this.options.assertExclusiveWriter();const value=await this.options.port.readUploadScope({principal,projectId});
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');if(expected&&(value.ownerUserId!==expected.ownerUserId||value.projectPath!==expected.projectPath||value.viewerUserId!==expected.viewerUserId))throw new StorageContractError('CONFLICT');return value;
  }
  upload(raw:Principal,rawIntent:StoredUploadIntent,body:ReadableStream<Uint8Array>):Promise<Outcome>{
    if(this.closed){cancel(body);return Promise.resolve({state:'rejected',code:'NOT_SUBMITTED'});}if(this.accepted.size>=16){cancel(body);return Promise.resolve({state:'rejected',code:'OVERLOADED'});}
    let actor:Principal,intent:StoredUploadIntent;try{const parsed=parseStoragePrincipal(raw);if(parsed.kind!=='user')throw new Error();actor=parsed;intent=StoredUploadIntentSchema.parse(JSON.parse(canonicalJson(rawIntent,16384)));}catch{cancel(body);return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    const work=Promise.resolve().then(async()=>{
      const scope=await this.scope(actor,intent.projectId),key=canonicalJson([this.options.storeId,this.options.generation,actor.userId,intent.projectId,intent.uploadId]),identity=canonicalJson([actor,intent]);let item=pending.get(key);
      if(item){cancel(body);if(item.identity!==identity)return{state:'unknown' as const};}
      else{if(pending.size>=16)throw new StorageContractError('OVERLOADED');const result=this.perform(actor,intent,scope,body).catch(error=>{
        if(error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND','INVALID_ARGUMENT','PAYLOAD_TOO_LARGE','OVERLOADED'].includes(error.code))return{state:'rejected' as const,code:error.code as Extract<Outcome,{state:'rejected'}>['code']};return{state:'unknown' as const};
      });item={identity,result};pending.set(key,item);const current=item;void result.finally(()=>{if(pending.get(key)===current)pending.delete(key);}).catch(()=>undefined);}
      const result=await item.result;if(result.state==='committed')await this.scope(actor,intent.projectId,scope);return result;
    }).catch(error=>{cancel(body);return error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND','INVALID_ARGUMENT','PAYLOAD_TOO_LARGE','NOT_SUBMITTED','OVERLOADED','CONFLICT'].includes(error.code)?{state:'rejected' as const,code:error.code as Extract<Outcome,{state:'rejected'}>['code']}:{state:'unknown' as const};});
    this.accepted.add(work);void work.finally(()=>this.accepted.delete(work)).catch(()=>undefined);return work;
  }
  private async perform(actor:Principal,intent:StoredUploadIntent,scope:UploadReadScope,body:ReadableStream<Uint8Array>):Promise<Outcome>{
    const controller=new AbortController();this.controllers.add(controller);
    try{return await this.options.files.withUpload(scope,{uploadId:intent.uploadId,messageId:intent.messageId,size:intent.size},async()=>{await this.scope(actor,intent.projectId,scope);},async capability=>{
      const onAbort=()=>controller.abort();capability.signal.addEventListener('abort',onAbort,{once:true});if(capability.signal.aborted)controller.abort();
      const guard=async()=>{if(controller.signal.aborted||this.closed)throw new StorageContractError('NOT_SUBMITTED');await capability.assertCurrent();return true;};
      try{
        const jobId=uuid(['incoming-upload-v1',actor.userId,intent.projectId,intent.uploadId]),attachmentId=uuid(['incoming-attachment-v1',actor.userId,intent.projectId,intent.uploadId]),journal=new IncomingUploadJournal(capability.projectRoot),stored=await journal.findRequest(jobId);
        const request=IncomingUploadRequestSchema.parse(stored??{version:1,jobId,attachmentId,userId:actor.userId,...intent,createdAt:this.options.now?.()??Date.now()});
        const storedIntent={projectId:request.projectId,messageId:request.messageId,uploadId:request.uploadId,name:request.name,mimeType:request.mimeType,size:request.size};
        if(request.jobId!==jobId||request.attachmentId!==attachmentId||request.userId!==actor.userId||canonicalJson(storedIntent,16384)!==canonicalJson(intent,16384)){cancel(body);return{state:'rejected',code:'CONFLICT'};}
        let received=await journal.readReceiveRecord(request),attachment:UploadedFileDraftDto|null=null;const attempted=received&&await journal.hasPublicationAttempt(request),published=received&&await journal.readPublicationRecord(request);
        const inspect=async()=>{try{return await this.publisher.run({projectPath:capability.projectRoot,request,digest:received!.proof.payload.digest,mode:'inspect'},guard,controller.signal);}catch(error){if(error instanceof StorageContractError&&error.code==='NOT_FOUND')return null;throw error;}};
        if(received)attachment=await capability.publish(inspect);
        if(!attachment){
          if(attempted||published){cancel(body);return{state:'unknown'};}
          const usage=(await this.reads.get(actor,intent.projectId)).usage;if(usage.usedBytes+usage.reservedBytes>usage.limitBytes)throw new StorageContractError('PAYLOAD_TOO_LARGE');
          if(!received){const timer=setTimeout(()=>controller.abort(),this.options.bodyTimeoutMs??300000);timer.unref();try{received=await journal.receive(request,body,{mayStage:guard,signal:controller.signal});}catch(error){if(controller.signal.aborted)return{state:'unknown'};throw error;}finally{clearTimeout(timer);}}
          else{cancel(body);await journal.inspect(request);}
          attachment=await capability.publish(async()=>{
            if(!await journal.claimPublication(request,guard))return inspect();
            try{return await this.publisher.run({projectPath:capability.projectRoot,request,digest:received!.proof.payload.digest,mode:'publish'},guard,controller.signal);}catch(error){const confirmed=await inspect();if(confirmed)return confirmed;throw error;}
          });
          if(!attachment)return{state:'unknown'};
        }else cancel(body);
        await capability.publish(async()=>{await journal.recordPublication(request,attachment!,guard);await journal.cleanupReceived(request,guard);});
        const value=await this.reads.get(actor,intent.projectId);if(value.usage.reservedBytes<intent.size)throw new StorageContractError('STORAGE_UNAVAILABLE');await guard();
        return{state:'committed',value:ProjectUploadResponseDtoSchema.parse({attachment,usage:{...value.usage,reservedBytes:value.usage.reservedBytes-intent.size}})};
      }finally{capability.signal.removeEventListener('abort',onAbort);}
    });}finally{cancel(body);this.controllers.delete(controller);}
  }
  async close(){this.closed=true;for(const controller of this.controllers)controller.abort();await this.ownedPublisher?.close();await Promise.allSettled([...this.accepted]);await this.reads.close();}
}
