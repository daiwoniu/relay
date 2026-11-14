import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { UploadedFileAttachmentDtoSchema,HostFileAttachmentDtoSchema } from '../contracts/index.js';
import { UploadPromotionInputSchema,UploadInspectInputSchema,type UploadPromotionInput,type UploadInspectInput } from './upload-promotion-contract.js';
import { StorageContractError,canonicalJson } from '../storage/command-boundary.js';
const output=z.object({uploads:z.array(UploadedFileAttachmentDtoSchema).max(10),hosts:z.array(HostFileAttachmentDtoSchema).max(10)}).strict();
/** Promise retains file ownership until actual Worker exit, including cancellation and lost replies. */
export class UploadPromoter{
  private closed=false;private readonly workers=new Set<Worker>();
  constructor(private readonly timeoutMs=30000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new StorageContractError('INVALID_ARGUMENT');}
  async run(raw:UploadPromotionInput,mayWrite:()=>Promise<boolean>,signal?:AbortSignal):Promise<z.infer<typeof output>>{
    const input=UploadPromotionInputSchema.parse(JSON.parse(canonicalJson(raw,512*1024)));
    return this.execute('promote',input,mayWrite,signal);
  }
  async inspect(raw:UploadInspectInput,mayRead:()=>Promise<boolean>,signal?:AbortSignal){
    const input=UploadInspectInputSchema.parse(JSON.parse(canonicalJson(raw,512*1024)));return this.execute('inspect',input,mayRead,signal);
  }
  private async execute(mode:'promote'|'inspect',input:UploadPromotionInput|UploadInspectInput,mayWrite:()=>Promise<boolean>,signal?:AbortSignal):Promise<z.infer<typeof output>>{
    if(this.closed||signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');
    if(!await mayWrite())throw new StorageContractError('FORBIDDEN');
    if(this.closed||signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');if(this.workers.size>=2)throw new StorageContractError('OVERLOADED');
    const requestId=randomUUID(),worker=new Worker(new URL('./upload-promotion-bootstrap.mjs',import.meta.url),{workerData:{requestId,input,mode},trackUnmanagedFds:true,resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16}});
    this.workers.add(worker);
    return new Promise((resolve,reject)=>{
      let value:z.infer<typeof output>|undefined,error:string|undefined,invalid=false,permissions=0;
      const terminate=()=>{void worker.terminate().catch(()=>{});};
      const timer=setTimeout(terminate,this.timeoutMs);timer.unref();signal?.addEventListener('abort',terminate,{once:true});
      worker.on('message',message=>{
        if(message?.requestId!==requestId)return;
        if(typeof message.permissionId==='string'){
          if(++permissions>4){invalid=true;terminate();return;}
          void Promise.resolve().then(()=>!this.closed&&!signal?.aborted?mayWrite():false).catch(()=>false).then(allowed=>{
            if(this.workers.has(worker))worker.postMessage({requestId,permissionId:message.permissionId,allowed:!!allowed&&!this.closed&&!signal?.aborted});
          }).catch(()=>{invalid=true;terminate();});return;
        }
        if(value||error){invalid=true;return;}
        if(typeof message.error==='string'){error=message.error;return;}
        try{canonicalJson(message.result,512*1024);value=output.parse(message.result);
          const uploads='uploads'in input?input.uploads:input.attachments.filter(item=>item.kind==='uploaded_file'),hosts='hosts'in input?input.hosts:input.attachments.filter(item=>item.kind==='host_file');
          if(value.uploads.length!==uploads.length||value.hosts.length!==hosts.length)throw Error();
          const key=(s:string)=>process.platform==='win32'?s.toLowerCase():s;
          value.uploads.forEach((item,i)=>{const expected=uploads[i]!;if(item.id!==expected.id||item.size!==expected.size||item.name!==expected.name||item.mimeType!==expected.mimeType
            ||key(item.path)!==key(path.join(input.projectPath,'.relay_upload','messages',input.messageId,path.basename(expected.path))))throw Error();});
          value.hosts.forEach((item,i)=>{if(item.id!==hosts[i]!.id||key(item.path)!==key(hosts[i]!.path))throw Error();});
        }catch{invalid=true;}
      });
      worker.on('error',()=>{invalid=true;});
      worker.once('exit',code=>{clearTimeout(timer);signal?.removeEventListener('abort',terminate);this.workers.delete(worker);
        if(code===0&&!invalid&&value)resolve(value);else reject(new StorageContractError(code===0&&!invalid&&['FORBIDDEN','CONFLICT','NOT_FOUND','INVALID_ARGUMENT','PAYLOAD_TOO_LARGE'].includes(error??'')?error as 'CONFLICT':'STORAGE_UNAVAILABLE'));
      });
    });
  }
  async close(){this.closed=true;await Promise.all([...this.workers].map(worker=>worker.terminate()));}
}
