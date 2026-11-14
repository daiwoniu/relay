import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { UploadManifestReadSchema } from './read-upload-snapshot.js';
import { fileIdentitySchema as identity,fileProofSchema as proof,uploadManifestSchema as manifestSchema,hash,equal as eq,sameId,stat,directory,mkdir,writeNew,readFile,metadata,unchanged,manifest } from './file-journal-primitives.js';

const uuid=z.string().uuid().refine(v=>v===v.toLowerCase());
export const DraftCleanupRequestSchema=z.object({version:z.literal(1),jobId:uuid,projectId:uuid,userId:uuid,uploadId:uuid}).strict();
export type DraftCleanupRequest=z.infer<typeof DraftCleanupRequestSchema>;
const sourceSchema=z.object({messageId:z.string().uuid(),directory:identity,manifest:proof,payload:proof.nullable(),storedName:UploadManifestReadSchema.shape.attachments.element.shape.storedName,nextManifest:manifestSchema}).strict();
const planSchema=z.object({version:z.literal(1),request:DraftCleanupRequestSchema,root:identity,uploads:identity,cleanup:identity,job:identity,source:sourceSchema.nullable()}).strict();
type Plan=z.infer<typeof planSchema>;
function fail():never{throw new StorageContractError('CONFLICT');}

/** Exact file-only deletion journal. It never recursively removes a user directory or replays against a newer manifest. */
export class DraftUploadCleanup{
  constructor(private readonly projectPath:string){}
  async run(raw:DraftCleanupRequest,mayMutate:()=>Promise<void>,signal?:AbortSignal){
    const request=DraftCleanupRequestSchema.parse(raw),root=await fs.realpath(this.projectPath),uploads=path.join(root,'.relay_upload'),cleanup=path.join(uploads,'.cleanup'),job=path.join(cleanup,request.jobId);
    const rootId=await directory(root),guard=async()=>{if(signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');await mayMutate();if(signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');if(await fs.realpath(this.projectPath)!==root)fail();await directory(root,rootId);};
    await guard();let saved=await metadata(path.join(job,'request.json')),plan:Plan;
    if(saved){try{plan=planSchema.parse(saved.value);}catch{fail();}if(!eq(plan.request,request))fail();}
    else{
      const temporary=path.join(uploads,'tmp');let source:Plan['source']=null,entries=0,total=0;
      if(await stat(temporary)){
        await directory(uploads);await directory(temporary);const stream=await fs.opendir(temporary);
        for await(const entry of stream){if(++entries>10000)throw new StorageContractError('PAYLOAD_TOO_LARGE');if(!z.string().uuid().safeParse(entry.name).success)continue;const target=path.join(temporary,entry.name),directoryId=await directory(target),document=await metadata(path.join(target,'manifest.json'),128*1024);if(!document)continue;
          total+=document.proof.size;if(total>8*1024*1024)throw new StorageContractError('PAYLOAD_TOO_LARGE');const value=manifest(document.value);if(!sameId(value.messageId,entry.name))fail();const selected=value.attachments.find(v=>sameId(v.uploadId,request.uploadId));if(!selected)continue;
          if(!sameId(value.userId,request.userId)||!sameId(value.projectId,request.projectId)||source)fail();const payload=await readFile(path.join(target,selected.storedName),50*1024*1024);if(payload&&payload.proof.size!==selected.size)fail();
          source={messageId:entry.name,directory:directoryId,manifest:document.proof,payload:payload?.proof??null,storedName:selected.storedName,nextManifest:{...value,updatedAt:Math.max(Date.now(),value.updatedAt),attachments:value.attachments.filter(v=>!sameId(v.uploadId,request.uploadId))}};
        }
      }
      await guard();const uploadsId=await mkdir(uploads),cleanupId=await mkdir(cleanup),jobId=await mkdir(job),ignore=path.join(uploads,'.gitignore');
      if(!await stat(ignore))await writeNew(ignore,Buffer.from('*\n'));const ignoreFile=await readFile(ignore,4096,true);if(!ignoreFile||!ignoreFile.bytes!.toString('utf8').split(/\r?\n/).includes('*'))fail();
      plan=planSchema.parse({version:1,request,root:rootId,uploads:uploadsId,cleanup:cleanupId,job:jobId,source});const bytes=Buffer.from(canonicalJson(plan,512*1024));await writeNew(path.join(job,'request.json'),bytes);saved={proof:{...jobId,size:bytes.length,mtime:'0',digest:hash(bytes)},bytes,value:plan};
    }
    if(plan.source&&(!sameId(plan.source.nextManifest.userId,request.userId)||!sameId(plan.source.nextManifest.projectId,request.projectId)||!sameId(plan.source.nextManifest.messageId,plan.source.messageId)||plan.source.nextManifest.attachments.some(value=>sameId(value.uploadId,request.uploadId))))fail();
    const stable=async()=>{await guard();for(const [name,location]of [['root',root],['uploads',uploads],['cleanup',cleanup],['job',job]] as const)await directory(location,plan[name]);};
    const digest=hash(canonicalJson(plan,512*1024)),done=async()=>{
      const record=await metadata(path.join(job,'complete.json'),4096);if(!record)return false;if(!eq(record.value,{version:1,planDigest:digest,deletedCount:plan.source?1:0}))fail();return true;
    };
    await stable();if(await done())return{deletedCount:plan.source?1:0};
    if(plan.source){
      const source=plan.source,temporary=path.join(uploads,'tmp'),target=path.join(temporary,source.messageId),manifestPath=path.join(target,'manifest.json'),payloadPath=path.join(target,source.storedName),quarantined=path.join(job,'payload');
      const sourceStable=async()=>{await stable();await directory(temporary);await directory(target,source.directory);};
      const currentManifest=async()=>{await sourceStable();const document=await metadata(manifestPath,128*1024);if(!document)fail();const value=manifest(document.value);if(!sameId(value.userId,request.userId)||!sameId(value.projectId,request.projectId)||!sameId(value.messageId,source.messageId))fail();return{document,value};};
      let current=await currentManifest();const stillListed=current.value.attachments.some(v=>sameId(v.uploadId,request.uploadId));if(stillListed&&!eq(current.document.proof,source.manifest))fail();
      const original=stillListed?await readFile(payloadPath,50*1024*1024):null,privateFile=await readFile(quarantined,50*1024*1024);
      if(privateFile&&!eq(privateFile.proof,source.payload)||original&&(!source.payload||!eq(original.proof,source.payload))||privateFile&&original)fail();
      if(original){
        if(!stillListed)fail();await sourceStable();const latest=await readFile(payloadPath,50*1024*1024);if(!latest||!eq(latest.proof,source.payload)||await stat(quarantined))fail();await sourceStable();await unchanged(payloadPath,latest.proof);if(await stat(quarantined))fail();await fs.rename(payloadPath,quarantined);
        const moved=await readFile(quarantined,50*1024*1024);if(!moved||!eq(moved.proof,source.payload))fail();
      }
      current=await currentManifest();if(current.value.attachments.some(v=>sameId(v.uploadId,request.uploadId))){
        if(!eq(current.document.proof,source.manifest)||!eq({...current.value,updatedAt:source.nextManifest.updatedAt,attachments:current.value.attachments.filter(v=>!sameId(v.uploadId,request.uploadId))},source.nextManifest))fail();const next=path.join(job,'manifest.next.json'),bytes=Buffer.from(canonicalJson(source.nextManifest,128*1024)),existing=await readFile(next,128*1024,true);
        if(existing){if(existing.proof.digest!==hash(bytes))fail();}else await writeNew(next,bytes);
        await sourceStable();const latest=await metadata(manifestPath,128*1024),prepared=await readFile(next,128*1024);if(!latest||!eq(latest.proof,source.manifest)||!prepared||prepared.proof.digest!==hash(bytes))fail();await sourceStable();await unchanged(manifestPath,latest.proof);await unchanged(next,prepared.proof);await fs.rename(next,manifestPath);
      }
      const applied=await currentManifest();if(applied.value.attachments.some(v=>sameId(v.uploadId,request.uploadId)))fail();
      const remaining=await readFile(quarantined,50*1024*1024);if(remaining){if(!eq(remaining.proof,source.payload))fail();await sourceStable();const latest=await readFile(quarantined,50*1024*1024);if(!latest||!eq(latest.proof,source.payload))fail();await sourceStable();await unchanged(quarantined,latest.proof);await fs.unlink(quarantined);}
    }
    await stable();await writeNew(path.join(job,'complete.json'),Buffer.from(canonicalJson({version:1,planDigest:digest,deletedCount:plan.source?1:0},4096)));await stable();return{deletedCount:plan.source?1:0};
  }
}
