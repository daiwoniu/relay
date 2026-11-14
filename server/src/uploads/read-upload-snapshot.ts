import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectUploadedFileDtoSchema,ProjectUploadUsageDtoSchema } from '../contracts/index.js';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import type { UploadReadScope } from '../storage/contracts.js';
import { MAX_PROJECT_UPLOAD_BYTES } from './project-uploads.js';
import { IncomingUploadRequestSchema } from './incoming-upload-contract.js';

const uuid=z.string().uuid();
export const UploadReadActivitySchema=z.object({version:z.string().min(1).max(256),reservations:z.array(z.object({uploadId:uuid,messageId:uuid,size:z.number().int().nonnegative().max(50*1024*1024)}).strict()).max(32)}).strict()
  .refine(value=>new Set(value.reservations.map(item=>item.uploadId.toLowerCase())).size===value.reservations.length,'Duplicate upload reservation');
export type UploadReadActivity=z.infer<typeof UploadReadActivitySchema>;
const leaf=z.string().min(1).max(255).refine(value=>value!=='.'&&value!=='..'&&!/[\\/:\x00-\x1f]/.test(value)
  &&value.toLowerCase()!=='manifest.json'&&!/^\.manifest-[0-9a-f-]+\.tmp$/i.test(value)&&!(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/i.test(value)));
const safeInteger=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const UploadManifestReadSchema=z.object({version:z.literal(2),messageId:uuid,projectId:uuid,userId:uuid,createdAt:safeInteger,updatedAt:safeInteger,
  attachments:z.array(z.object({uploadId:uuid,attachmentId:uuid,name:z.string().min(1).max(255),storedName:leaf,size:safeInteger,mimeType:z.string().min(1).max(255),createdAt:safeInteger})).max(1000)});
const manifestSchema=UploadManifestReadSchema;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missing=(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT';
const changed=()=>new StorageContractError('CONFLICT');
type Stat=Awaited<ReturnType<typeof fs.lstat>>;
const same=(a:Stat,b:Stat)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;

/** Bounded, read-only source. No cleanup, mkdir, filesystem sync APIs or database access. */
export async function readUploadSnapshot(scope:UploadReadScope,rawActivity:UploadReadActivity){
  const activity=UploadReadActivitySchema.parse(rawActivity),directories=new Map<string,Stat>(),files:z.infer<typeof ProjectUploadedFileDtoSchema>[]=[];
  let entries=0,manifestBytes=0,usedBytes=0,archivedFileCount=0,temporaryFileCount=0;
  const limit=()=>{if(++entries>10000)throw new StorageContractError('PAYLOAD_TOO_LARGE');};
  const directory=async(target:string,optional=false)=>{
    let stat:Stat;try{stat=await fs.lstat(target);}catch(error){if(optional&&missing(error))return false;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(target)!==target)throw changed();directories.set(target,stat);return true;
  };
  const root=await fs.realpath(scope.projectPath);if(!await directory(root))throw changed();
  const uploadRoot=path.join(root,'.relay_upload');
  const payload=async(target:string)=>{const stat=await fs.lstat(target);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||!Number.isSafeInteger(stat.size))throw changed();return stat;};
  const readDocument=async(target:string):Promise<unknown>=>{
    const before=await payload(target);if(before.size>128*1024||manifestBytes+before.size>8*1024*1024)throw new StorageContractError('PAYLOAD_TOO_LARGE');manifestBytes+=before.size;
    const handle=await fs.open(target,'r');try{
      if(!same(before,await handle.stat()))throw changed();const bytes=Buffer.alloc(before.size+1);let count=0;
      while(count<bytes.length){const part=await handle.read(bytes,count,bytes.length-count,count);if(!part.bytesRead)break;count+=part.bytesRead;}
      if(count!==before.size||!same(before,await handle.stat())||!same(before,await payload(target)))throw changed();
      try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)));}catch{throw changed();}
    }finally{await handle.close();}
  };
  const readManifest=async(target:string)=>{let value:z.infer<typeof manifestSchema>;try{value=manifestSchema.parse(await readDocument(target));}catch(error){if(error instanceof StorageContractError||missing(error))throw error;throw changed();}
    for(const field of ['uploadId','attachmentId','storedName'] as const){const values=value.attachments.map(item=>item[field].toLowerCase());if(new Set(values).size!==values.length)throw changed();}return value;
  };
  const countPayloads=async(target:string,ignored:Set<string>,depth=0):Promise<void>=>{
    if(depth>8)throw new StorageContractError('PAYLOAD_TOO_LARGE');
    const stream=await fs.opendir(target);for await(const item of stream){limit();
      if(item.name.toLowerCase()==='manifest.json'||/^\.manifest-[0-9a-f-]+\.tmp$/i.test(item.name)||ignored.has(item.name.toLowerCase()))continue;
      const filename=path.join(target,item.name);if(item.isDirectory()){await directory(filename);await countPayloads(filename,ignored,depth+1);}else{
        const stat=await payload(filename);usedBytes+=stat.size;if(!Number.isSafeInteger(usedBytes))throw new StorageContractError('PAYLOAD_TOO_LARGE');
      }
    }
  };
  const hasUploads=await directory(uploadRoot,true);
  if(hasUploads)for(const [name,temporary]of [['tmp',true],['messages',false]] as const){
    const category=path.join(uploadRoot,name);if(!await directory(category,true))continue;const stream=await fs.opendir(category);
    for await(const item of stream){limit();if(!uuidPattern.test(item.name))continue;const target=path.join(category,item.name);await directory(target);
      const ignored=new Set(temporary?activity.reservations.filter(item=>item.messageId.toLowerCase()===path.basename(target).toLowerCase()).map(item=>item.uploadId.toLowerCase()+'.part'):[]);
      await countPayloads(target,ignored);let manifest;
      try{manifest=await readManifest(path.join(target,'manifest.json'));}catch(error){if(missing(error))continue;throw error;}
      if(manifest.messageId.toLowerCase()!==item.name.toLowerCase())throw changed();
      if(temporary)temporaryFileCount+=manifest.attachments.length;else archivedFileCount+=manifest.attachments.length;
      if(temporary||manifest.projectId.toLowerCase()!==scope.projectId.toLowerCase()||scope.viewerRole!=='admin'&&manifest.userId.toLowerCase()!==scope.viewerUserId.toLowerCase())continue;
      for(const entry of manifest.attachments){let available=false;try{available=(await payload(path.join(target,entry.storedName))).size===entry.size;}catch(error){if(!missing(error))throw error;}
        files.push(ProjectUploadedFileDtoSchema.parse({id:entry.attachmentId,kind:'uploaded_file',name:entry.name,size:entry.size,mimeType:entry.mimeType,available,createdAt:entry.createdAt}));if(files.length>1000)throw new StorageContractError('PAYLOAD_TOO_LARGE');
      }
    }
  }
  const incoming=path.join(uploadRoot,'.incoming');
  if(hasUploads&&await directory(incoming,true)){
    const stream=await fs.opendir(incoming);for await(const item of stream){limit();if(!uuidPattern.test(item.name))throw changed();const target=path.join(incoming,item.name);await directory(target);
      let request:z.infer<typeof IncomingUploadRequestSchema>|null=null;
      try{request=z.object({request:IncomingUploadRequestSchema}).parse(await readDocument(path.join(target,'request.json'))).request;}catch(error){if(!missing(error)){if(error instanceof StorageContractError)throw error;throw changed();}}
      if(request&&request.jobId!==item.name.toLowerCase())throw changed();
      const reservation=request?activity.reservations.find(item=>item.uploadId.toLowerCase()===request!.uploadId&&item.messageId.toLowerCase()===request!.messageId):null;
      if(reservation&&reservation.size!==request!.size)throw changed();const reserved=!!reservation;
      // Inactive private payloads still consume quota after a restart; they are never silently cleaned by GET.
      await countPayloads(target,new Set(['request.json','complete.json','published.json','dispatch.json',...(reserved?['payload.part']:[])]));
    }
  }
  const cleanup=path.join(uploadRoot,'.cleanup');
  if(hasUploads&&await directory(cleanup,true)){
    const stream=await fs.opendir(cleanup);for await(const item of stream){limit();if(!uuidPattern.test(item.name))throw changed();const target=path.join(cleanup,item.name);await directory(target);await countPayloads(target,new Set(['request.json','complete.json','manifest.next.json','manifest.restore.json','prepared.json','decision.json']));}
  }
  for(const [target,before]of directories){const after=await fs.lstat(target);if(after.isSymbolicLink()||!same(before,after)||await fs.realpath(target)!==target)throw changed();}
  if(await fs.realpath(scope.projectPath)!==root)throw changed();
  const usage=ProjectUploadUsageDtoSchema.parse({usedBytes,reservedBytes:activity.reservations.reduce((sum,item)=>sum+item.size,0),limitBytes:MAX_PROJECT_UPLOAD_BYTES,archivedFileCount,temporaryFileCount});
  const result={usage,files:files.sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id))};canonicalJson(result,1024*1024);return result;
}
