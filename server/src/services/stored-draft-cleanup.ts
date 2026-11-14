import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CoreStoragePort,StoragePrincipal,StorageRejectionCode,UploadReadScope } from '../storage/contracts.js';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { ProjectUploadDeleteResponseDtoSchema } from '../contracts/index.js';
import { DraftUploadCleanup } from '../uploads/draft-upload-cleanup.js';
import { ProjectFileActivities } from '../uploads/project-file-activities.js';
import { StoredUploadReads } from './stored-upload-reads.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
type Outcome={state:'committed';value:z.infer<typeof ProjectUploadDeleteResponseDtoSchema>}|{state:'rejected';code:StorageRejectionCode}|{state:'unknown'};
const pending=new Map<string,{identity:string;result:Promise<Outcome>}>();
const uuid=(value:unknown)=>{const h=createHash('sha256').update(canonicalJson(value)).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
export class StoredDraftCleanup{
  private closed=false;private readonly accepted=new Set<Promise<Outcome>>();private readonly reads:StoredUploadReads;
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number;files:ProjectFileActivities;assertExclusiveWriter:()=>Promise<void>}){
    this.options=Object.freeze({...options});if(!options.storeId||!Number.isSafeInteger(options.generation)||options.generation<1)throw new StorageContractError('INVALID_ARGUMENT');
    this.reads=new StoredUploadReads({port:options.port,activity:scope=>options.files.snapshot(scope)});
  }
  private async scope(principal:Principal,projectId:string,expected?:UploadReadScope){
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');await this.options.assertExclusiveWriter();const value=await this.options.port.readUploadScope({principal,projectId});
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');if(expected&&(value.projectPath!==expected.projectPath||value.ownerUserId!==expected.ownerUserId||value.viewerUserId!==expected.viewerUserId))throw new StorageContractError('CONFLICT');return value;
  }
  delete(raw:Principal,rawProject:string,rawUpload:string):Promise<Outcome>{
    if(this.closed)return Promise.resolve({state:'rejected',code:'NOT_SUBMITTED'});if(this.accepted.size>=16)return Promise.resolve({state:'rejected',code:'OVERLOADED'});
    let actor:Principal,projectId:string,uploadId:string;try{const principal=parseStoragePrincipal(raw);if(principal.kind!=='user')throw new Error();actor=principal;projectId=z.string().uuid().parse(rawProject).toLowerCase();uploadId=z.string().uuid().parse(rawUpload).toLowerCase();}catch{return Promise.resolve({state:'rejected',code:'INVALID_ARGUMENT'});}
    const work=Promise.resolve().then(async()=>{
      const scope=await this.scope(actor,projectId),key=canonicalJson([this.options.storeId,this.options.generation,actor.userId,projectId,uploadId]),identity=canonicalJson(actor);let item=pending.get(key);
      if(item&&item.identity!==identity)return{state:'unknown' as const};
      if(!item){if(pending.size>=16)throw new StorageContractError('OVERLOADED');const result=this.perform(actor,scope,uploadId);item={identity,result};pending.set(key,item);const current=item;void result.finally(()=>{if(pending.get(key)===current)pending.delete(key);}).catch(()=>undefined);}
      const result=await item.result;if(result.state==='committed')await this.scope(actor,projectId,scope);return result;
    }).catch(error=>error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND','NOT_SUBMITTED','OVERLOADED','CONFLICT','INVALID_ARGUMENT'].includes(error.code)?{state:'rejected' as const,code:error.code}:{state:'unknown' as const});
    this.accepted.add(work);void work.finally(()=>this.accepted.delete(work)).catch(()=>undefined);return work;
  }
  private async perform(actor:Principal,scope:UploadReadScope,uploadId:string):Promise<Outcome>{
    let started=false;
    try{
      const guard=async()=>{await this.scope(actor,scope.projectId,scope);},jobId=uuid(['draft-cleanup-v1',actor.userId,scope.projectId,uploadId]);
      const result=await this.options.files.withMutation(scope,guard,signal=>{started=true;return new DraftUploadCleanup(scope.projectPath).run({version:1,jobId,projectId:scope.projectId,userId:actor.userId,uploadId},guard,signal);});
      const value=await this.reads.get(actor,scope.projectId);await guard();return{state:'committed',value:ProjectUploadDeleteResponseDtoSchema.parse({...result,usage:value.usage})};
    }catch(error){return!started&&error instanceof StorageContractError&&['FORBIDDEN','NOT_FOUND','NOT_SUBMITTED','OVERLOADED','CONFLICT'].includes(error.code)?{state:'rejected',code:error.code}:{state:'unknown'};}
  }
  async close(){this.closed=true;await Promise.allSettled([...this.accepted]);await this.reads.close();}
}
