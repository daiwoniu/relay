import { createHash,randomUUID } from 'node:crypto';
import type { CoreStoragePort,StoragePrincipal,StorageCommandEnvelope,CoreCommandInputs } from '../storage/contracts.js';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { CreateShareRequestSchema,CreateShareResponseDtoSchema,type CreateShareRequest } from '../contracts/index.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;
type Names='share.create'|'share.revoke'|'share.delete';
/** No legacy services, SQL, file I/O or default engine dependencies. */
export class StoredShares {
  private readonly pending=new Map<string,Promise<any>>();
  constructor(private readonly options:{port:CoreStoragePort;storeId:string;generation:number}){this.options=Object.freeze({...options});}
  private request<K extends Names>(principal:Principal,operationId:string,name:K,input:CoreCommandInputs[K]){
    return {protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),operationId,principal,command:{name,input}} as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}};
  }
  private tracked<T>(identity:string,work:()=>Promise<T>):Promise<T>{
    const previous=this.pending.get(identity);if(previous)return previous;if(this.pending.size>=128)return Promise.reject(new StorageContractError('OVERLOADED'));
    const tracked=Promise.resolve().then(work).finally(()=>{if(this.pending.get(identity)===tracked)this.pending.delete(identity);});this.pending.set(identity,tracked);return tracked;
  }
  private prefix(principal:Principal,key:string){return `share:${createHash('sha256').update(principal.userId).digest('hex').slice(0,32)}:${key}`;}
  preview(principal:Principal,request:CreateShareRequest){return this.options.port.previewShare({principal,request:CreateShareRequestSchema.parse(request)}).then((result)=>result.preview);}
  create(principal:Principal,raw:CreateShareRequest,key:string){
    const request=CreateShareRequestSchema.parse(raw),actor=structuredClone(principal),prefix=this.prefix(actor,key),digest=createHash('sha256').update(canonicalJson(request)).digest('hex');
    return this.tracked(canonicalJson([actor,prefix,digest]),async()=>{
      const prior=await this.options.port.lookup({storeId:this.options.storeId,operationId:prefix,principal:actor});
      if(prior.state==='committed'){
        if(prior.commandName!=='share.create'||prior.value.requestDigest!==digest)throw new StorageContractError('CONFLICT');
        return {state:'committed' as const,value:CreateShareResponseDtoSchema.parse({id:prior.value.shareId,publicToken:prior.value.publicToken,createdAt:prior.value.createdAt,expiresAt:prior.value.expiresAt})};
      }
      if(prior.state==='expired')throw new StorageContractError('OPERATION_EXPIRED');if(prior.state!=='not-found')return {state:'unknown' as const};
      const prepared=await this.options.port.previewShare({principal:actor,request});
      const result=await executeStoredCommand(this.options.port,this.request(actor,prefix,'share.create',{request,sourceDigest:prepared.sourceDigest,availability:prepared.availability}));
      if(result.state==='rejected')throw new StorageContractError(result.code);if(result.state!=='committed')return {state:'unknown' as const};
      return {state:'committed' as const,value:CreateShareResponseDtoSchema.parse({id:result.value.shareId,publicToken:result.value.publicToken,createdAt:result.value.createdAt,expiresAt:result.value.expiresAt})};
    });
  }
  mutate(principal:Principal,name:'share.revoke'|'share.delete',shareId:string,key:string){
    const actor=structuredClone(principal);return this.tracked(canonicalJson([actor,name,shareId,key]),async()=>{
      const result=await executeStoredCommand(this.options.port,this.request(actor,`${this.prefix(actor,key)}:${name}`,name,{shareId}));
      if(result.state==='rejected')throw new StorageContractError(result.code);return result.state==='committed'?{state:'committed' as const}:{state:'unknown' as const};
    });
  }
}
