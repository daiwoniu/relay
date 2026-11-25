import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { UploadedFileDraftDtoSchema,type UploadedFileDraftDto } from '../contracts/index.js';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { UploadPublishInputSchema,type UploadPublishInput } from './upload-publisher-contract.js';
import { uploadMessageDirectory } from './upload-promotion-contract.js';
/** Called inside the shared physical-root activity owner. This promise ends only after the Worker exits. */
export class UploadPublisher{
  private closed=false;private readonly active=new Set<Worker>();
  constructor(private readonly timeoutMs=30000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new StorageContractError('INVALID_ARGUMENT');}
  async run(raw:UploadPublishInput,mayWrite:()=>Promise<boolean>,signal?:AbortSignal):Promise<UploadedFileDraftDto>{
    if(this.closed||signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');
    const input=UploadPublishInputSchema.parse(JSON.parse(canonicalJson(raw,32768)));if(!await mayWrite())throw new StorageContractError('FORBIDDEN');
    if(this.closed||signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');if(this.active.size>=2)throw new StorageContractError('OVERLOADED');
    const requestId=randomUUID();let worker:Worker;try{worker=new Worker(new URL('./upload-publisher-bootstrap.mjs',import.meta.url),{workerData:{requestId,input},trackUnmanagedFds:true,resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16}});}catch{throw new StorageContractError('NOT_SUBMITTED');}
    this.active.add(worker);
    return new Promise((resolve,reject)=>{
      let draft:UploadedFileDraftDto|undefined,error:'FORBIDDEN'|'NOT_FOUND'|'CONFLICT'|'PAYLOAD_TOO_LARGE'|'INVALID_ARGUMENT'|'STORAGE_UNAVAILABLE'|undefined,failed=false,permissions=0;
      const terminate=()=>{void worker.terminate().catch(()=>undefined);},timer=setTimeout(terminate,this.timeoutMs);timer.unref();signal?.addEventListener('abort',terminate,{once:true});
      worker.on('message',message=>{
        if(message?.requestId!==requestId)return;
        if(typeof message.permissionId==='string'){
          if(++permissions>4){failed=true;terminate();return;}
          void Promise.resolve().then(()=>!this.closed&&!signal?.aborted&&this.active.has(worker)?mayWrite():false).catch(()=>false).then(allowed=>{if(this.active.has(worker))worker.postMessage({requestId,permissionId:message.permissionId,allowed:!!allowed&&!this.closed&&!signal?.aborted});}).catch(()=>{failed=true;terminate();});return;
        }
        if(draft||error){failed=true;return;}
        if(['FORBIDDEN','NOT_FOUND','CONFLICT','PAYLOAD_TOO_LARGE','INVALID_ARGUMENT','STORAGE_UNAVAILABLE'].includes(message.error)){error=message.error;return;}
        try{canonicalJson(message.draft,32768);const value=UploadedFileDraftDtoSchema.parse(message.draft),expected=input.request,key=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
          if(value.id!==expected.attachmentId||value.uploadId!==expected.uploadId||value.messageId!==expected.messageId||value.projectId!==expected.projectId||value.name!==expected.name||value.size!==expected.size||value.mimeType!==expected.mimeType||key(path.dirname(value.path))!==key(uploadMessageDirectory(path.resolve(input.projectPath),'tmp',expected.messageId)))throw new Error();draft=value;
        }catch{failed=true;}
      });
      worker.on('error',()=>{failed=true;});worker.once('exit',code=>{clearTimeout(timer);signal?.removeEventListener('abort',terminate);this.active.delete(worker);if(code===0&&!failed&&draft)resolve(draft);else reject(new StorageContractError(code===0&&!failed&&error?error:'STORAGE_UNAVAILABLE'));});
    });
  }
  async close(){this.closed=true;await Promise.all([...this.active].map(worker=>worker.terminate()));}
}
