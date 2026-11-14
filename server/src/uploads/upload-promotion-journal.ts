import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UploadedFileAttachmentDtoSchema,HostFileAttachmentDtoSchema } from '../contracts/index.js';
import { UploadPromotionInputSchema,UploadInspectInputSchema,type UploadPromotionInput,type UploadInspectInput } from './upload-promotion-contract.js';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { directory,mkdir,metadata,manifest,readFile,stat,writeNew,fileIdentitySchema,fileProofSchema,equal,unchanged } from './file-journal-primitives.js';
const intentSchema=z.object({version:z.literal(1),request:UploadPromotionInputSchema,root:fileIdentitySchema,uploads:fileIdentitySchema,tmp:fileIdentitySchema,messages:fileIdentitySchema,
  source:fileIdentitySchema,manifest:fileProofSchema,files:z.array(z.object({name:z.string(),proof:fileProofSchema}).strict()).max(10)}).strict();
const key=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
const conflict=():never=>{throw new StorageContractError('CONFLICT');};

/** Run in a file Worker. A directory rename retains identity; intent/proofs own crash recovery, not memory callbacks. */
export async function promoteUploads(raw:UploadPromotionInput,mayWrite:()=>Promise<boolean>){
  const request=UploadPromotionInputSchema.parse(raw),root=await fs.realpath(request.projectPath),rootId=await directory(root);
  const hosts=[];
  for(const host of request.hosts){
    const real=await fs.realpath(host.path),value=await stat(real);
    if(key(real)!==key(host.path)||!value?.isFile()||value.isSymbolicLink()||!Number.isSafeInteger(Number(value.size)))conflict();
    hosts.push(HostFileAttachmentDtoSchema.parse({...host,path:real,name:path.basename(real),size:Number(value!.size)}));
  }
  if(!request.uploads.length)return{uploads:[],hosts};
  const uploads=path.join(root,'.relay_upload'),tmp=path.join(uploads,'tmp'),messages=path.join(uploads,'messages');
  const source=path.join(tmp,request.messageId),target=path.join(messages,request.messageId),journals=path.join(uploads,'.promotions'),journal=path.join(journals,request.messageId);
  const uploadsId=await directory(uploads),tmpId=await directory(tmp),messagesId=await directory(messages);
  if(!await mayWrite())throw new StorageContractError('FORBIDDEN');
  await mkdir(journals);await mkdir(journal);
  let intent: z.infer<typeof intentSchema>;
  const existing=await metadata(path.join(journal,'intent.json'));
  if(existing){intent=intentSchema.parse(existing.value);if(!equal(intent.request,request))conflict();}
  else{
    const sourceId=await directory(source),document=await metadata(path.join(source,'manifest.json'));if(!document)conflict();
    const value=manifest(document!.value);
    if(value.messageId!==request.messageId||value.projectId!==request.projectId||value.userId!==request.userId||value.attachments.length!==request.uploads.length)conflict();
    const files=[];let total=0;const ids=new Set<string>();
    for(const draft of request.uploads){
      if(draft.projectId!==request.projectId||draft.messageId!==request.messageId||ids.has(draft.uploadId))conflict();ids.add(draft.uploadId);
      const entry=value.attachments.find(entry=>entry.uploadId===draft.uploadId);
      if(!entry||entry.attachmentId!==draft.id||entry.name!==draft.name||entry.size!==draft.size||entry.mimeType!==draft.mimeType||key(draft.path)!==key(path.join(source,entry.storedName)))conflict();
      const payload=await readFile(path.join(source,entry!.storedName),50*1024*1024);if(!payload||payload.proof.size!==draft.size)conflict();
      total+=draft.size;if(total>200*1024*1024)throw new StorageContractError('PAYLOAD_TOO_LARGE');files.push({name:entry!.storedName,proof:payload!.proof});
    }
    const names=new Set(['manifest.json',...files.map(file=>file.name)]);
    for(const name of await fs.readdir(source))if(!names.has(name))conflict();
    intent={version:1,request,root:rootId,uploads:uploadsId,tmp:tmpId,messages:messagesId,source:sourceId,manifest:document!.proof,files};
    await writeNew(path.join(journal,'intent.json'),Buffer.from(canonicalJson(intent,512*1024)));
  }
  const stable=async()=>{await directory(root,intent.root);await directory(uploads,intent.uploads);await directory(tmp,intent.tmp);await directory(messages,intent.messages);await directory(journals);await directory(journal);};
  const verify=async(location:string,full=false)=>{await stable();await directory(location,intent.source);await unchanged(path.join(location,'manifest.json'),intent.manifest);
    for(const file of intent.files){if(!full){await unchanged(path.join(location,file.name),file.proof);continue;}const value=await readFile(path.join(location,file.name),50*1024*1024);if(!value||!equal(value.proof,file.proof))conflict();}};
  const sourceExists=await stat(source),targetExists=await stat(target);
  if(sourceExists&&targetExists||!sourceExists&&!targetExists)conflict();
  if(sourceExists){
    await verify(source,!!existing);if(!await mayWrite())throw new StorageContractError('FORBIDDEN');await verify(source);
    if(await stat(target))conflict();await fs.rename(source,target);
  }
  await verify(target,!sourceExists);
  const document=await metadata(path.join(target,'manifest.json'));const value=manifest(document!.value);
  const result=request.uploads.map(draft=>{const entry=value.attachments.find(entry=>entry.uploadId===draft.uploadId)!;
    return UploadedFileAttachmentDtoSchema.parse({id:entry.attachmentId,kind:'uploaded_file',name:entry.name,path:path.join(target,entry.storedName),size:entry.size,mimeType:entry.mimeType,available:true});});
  const completed=await metadata(path.join(journal,'completed.json'));
  if(completed){if(!equal(completed.value,{uploads:result}))conflict();}else await writeNew(path.join(journal,'completed.json'),Buffer.from(canonicalJson({uploads:result},128*1024)));
  return{uploads:result,hosts};
}

/** Read-only validation at queued dispatch, including legacy archived manifests without a promotion journal. */
export async function inspectPromotedAttachments(raw:UploadInspectInput){
  const input=UploadInspectInputSchema.parse(raw),root=await fs.realpath(input.projectPath);await directory(root);
  const uploads=[],hosts=[];
  for(const attachment of input.attachments){
    if(attachment.kind==='host_file'){
      const real=await fs.realpath(attachment.path),value=await stat(real);
      if(key(real)!==key(attachment.path)||!value?.isFile()||value.isSymbolicLink()||Number(value.size)!==attachment.size)conflict();hosts.push(attachment);continue;
    }
    const managed=path.join(root,'.relay_upload');await directory(managed);await directory(path.join(managed,'messages'));
    const target=path.join(managed,'messages',input.messageId);await directory(target);
    const document=await metadata(path.join(target,'manifest.json'));if(!document)conflict();const value=manifest(document!.value);
    if(value.messageId!==input.messageId||value.projectId!==input.projectId||value.userId!==input.userId)conflict();
    const entry=value.attachments.find(item=>item.attachmentId===attachment.id);
    if(!entry||entry.name!==attachment.name||entry.size!==attachment.size||entry.mimeType!==attachment.mimeType||key(attachment.path)!==key(path.join(target,entry.storedName)))conflict();
    const payload=await readFile(attachment.path,50*1024*1024);if(!payload||payload.proof.size!==attachment.size)conflict();uploads.push({...attachment,available:true});
  }
  return{uploads,hosts};
}
