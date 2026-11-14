import fs from 'node:fs/promises';
import { constants,type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { IncomingUploadRequestSchema,type IncomingUploadRequest } from './incoming-upload-contract.js';
import { hasDangerousHeader,MAX_UPLOAD_FILE_BYTES } from './project-uploads.js';
import { UploadedFileDraftDtoSchema,type UploadedFileDraftDto } from '../contracts/index.js';

const idSchema=z.object({dev:z.string().regex(/^\d+$/),ino:z.string().regex(/^\d+$/)}).strict();
const fileSchema=idSchema.extend({size:z.number().int().nonnegative().max(MAX_UPLOAD_FILE_BYTES),mtime:z.string().regex(/^\d+$/),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const intentSchema=z.object({version:z.literal(1),request:IncomingUploadRequestSchema,root:idSchema,uploads:idSchema,incoming:idSchema,journal:idSchema}).strict();
const readySchema=z.object({version:z.literal(1),intentDigest:z.string().regex(/^[a-f0-9]{64}$/),payload:fileSchema}).strict();
const publicationSchema=z.object({version:z.literal(1),proofDigest:z.string().regex(/^[a-f0-9]{64}$/),attachment:UploadedFileDraftDtoSchema,file:fileSchema}).strict();
const dispatchSchema=z.object({version:z.literal(1),proofDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Identity=z.infer<typeof idSchema>;type Intent=z.infer<typeof intentSchema>;
export type IncomingUploadProof=z.infer<typeof readySchema>;
const id=(stat:BigIntStats):Identity=>({dev:String(stat.dev),ino:String(stat.ino)});
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const eq=(a:unknown,b:unknown)=>canonicalJson(a,32768)===canonicalJson(b,32768);
const exact=(value:BigIntStats|null,file:z.infer<typeof fileSchema>)=>!!value&&value.isFile()&&!value.isSymbolicLink()&&value.nlink===1n&&eq(id(value),{dev:file.dev,ino:file.ino})&&Number(value.size)===file.size&&String(value.mtimeNs)===file.mtime;
const key=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
function conflict():never{throw new StorageContractError('CONFLICT');}
const missing=(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT';
async function stat(filename:string){try{return await fs.lstat(filename,{bigint:true});}catch(error){if(missing(error))return null;throw error;}}
async function directory(filename:string,expected?:Identity){
  const value=await stat(filename);if(!value||!value.isDirectory()||value.isSymbolicLink()||key(await fs.realpath(filename))!==key(filename)||expected&&!eq(expected,id(value)))conflict();return id(value);
}
async function mkdir(filename:string){await directory(path.dirname(filename));try{await fs.mkdir(filename);}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw error;}return directory(filename);}
async function writeNew(filename:string,bytes:Uint8Array){
  const handle=await fs.open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function readSmall(filename:string,max:number){
  const before=await stat(filename);if(!before)return null;if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(max))conflict();
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{
    const opened=await handle.stat({bigint:true});if(!eq(id(before),id(opened))||before.size!==opened.size||before.mtimeNs!==opened.mtimeNs)conflict();
    const bytes=Buffer.alloc(Number(before.size)+1);let size=0;
    while(size<bytes.length){const part=await handle.read(bytes,size,bytes.length-size,size);if(!part.bytesRead)break;size+=part.bytesRead;}
    const after=await handle.stat({bigint:true}),current=await stat(filename);
    if(size!==Number(before.size)||!current||current.nlink!==1n||current.isSymbolicLink()||!eq(id(before),id(current))||before.size!==after.size||before.size!==current.size||before.mtimeNs!==after.mtimeNs||before.mtimeNs!==current.mtimeNs)conflict();return bytes.subarray(0,size);
  }finally{await handle.close();}
}
/** Private receive-only journal. Publication/cleanup additionally require current Native authorization and a retained decision. */
export class IncomingUploadJournal{
  constructor(private readonly projectPath:string){}
  private async location(request:Pick<IncomingUploadRequest,'jobId'>,create:boolean){
    const root=await fs.realpath(this.projectPath),uploads=path.join(root,'.relay_upload'),incoming=path.join(uploads,'.incoming'),journal=path.join(incoming,request.jobId);
    const rootId=await directory(root);if(create){await mkdir(uploads);await mkdir(incoming);await mkdir(journal);
      const ignore=path.join(uploads,'.gitignore');if(!await stat(ignore))try{await writeNew(ignore,Buffer.from('*\n'));}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw error;}
      const value=await readSmall(ignore,4096);if(!value||!value.toString('utf8').split(/\r?\n/).includes('*'))conflict();
    }
    return{root,uploads,incoming,journal,expected:{root:rootId,uploads:await directory(uploads),incoming:await directory(incoming),journal:await directory(journal)}};
  }
  private async stable(location:Awaited<ReturnType<IncomingUploadJournal['location']>>,intent:Intent){
    if(key(await fs.realpath(this.projectPath))!==key(location.root))conflict();
    for(const field of ['root','uploads','incoming','journal'] as const)await directory(location[field],intent[field]);
  }
  private async payload(filename:string){
    const before=await stat(filename);if(!before||!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(MAX_UPLOAD_FILE_BYTES))conflict();
    const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{
      const opened=await handle.stat({bigint:true});if(!eq(id(before),id(opened))||before.size!==opened.size||before.mtimeNs!==opened.mtimeNs)conflict();
      const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0,header=Buffer.alloc(0);for(;;){const part=await handle.read(buffer,0,buffer.length,size);if(!part.bytesRead)break;size+=part.bytesRead;if(size>MAX_UPLOAD_FILE_BYTES)conflict();if(header.length<16)header=Buffer.concat([header,buffer.subarray(0,Math.min(part.bytesRead,16-header.length))]);digest.update(buffer.subarray(0,part.bytesRead));}
      const after=await handle.stat({bigint:true}),current=await stat(filename);if(hasDangerousHeader(header)||!current||current.nlink!==1n||current.isSymbolicLink()||!eq(id(before),id(current))||size!==Number(before.size)||before.size!==after.size||before.size!==current.size||before.mtimeNs!==after.mtimeNs||before.mtimeNs!==current.mtimeNs)conflict();
      return{...id(before),size,mtime:String(before.mtimeNs),digest:digest.digest('hex')};
    }finally{await handle.close();}
  }
  private async readIntent(jobId:string){
    if(!await stat(path.join(await fs.realpath(this.projectPath),'.relay_upload','.incoming',jobId)))return null;
    const location=await this.location({jobId},false);
    const bytes=await readSmall(path.join(location.journal,'request.json'),16384);if(!bytes)return null;
    let intent:Intent;try{intent=intentSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{conflict();}if(intent.request.jobId!==jobId)conflict();await this.stable(location,intent);return{location,intent,bytes};
  }
  async findRequest(rawJobId:string){const jobId=z.string().uuid().refine(value=>value===value.toLowerCase()).parse(rawJobId);return(await this.readIntent(jobId))?.intent.request??null;}
  private async evidence(raw:IncomingUploadRequest){
    const request=IncomingUploadRequestSchema.parse(raw),source=await this.readIntent(request.jobId);if(!source)return null;const {location,intent,bytes}=source;if(!eq(intent.request,request))conflict();
    const ready=await readSmall(path.join(location.journal,'complete.json'),16384);if(!ready)return null;let proof:IncomingUploadProof;try{proof=readySchema.parse(JSON.parse(ready.toString('utf8')));}catch{conflict();}
    if(proof.payload.size!==request.size||proof.intentDigest!==hash(bytes))conflict();await this.stable(location,intent);return{...source,proof,proofDigest:hash(canonicalJson(proof,16384))};
  }
  /** Registration metadata only. Verify staged or public bytes separately before acknowledging success. */
  async readReceiveRecord(request:IncomingUploadRequest){const source=await this.evidence(request);return source?{proof:source.proof,proofDigest:source.proofDigest}:null;}
  async hasPublicationAttempt(request:IncomingUploadRequest){
    const source=await this.evidence(request);if(!source)return false;const bytes=await readSmall(path.join(source.location.journal,'dispatch.json'),16384);if(!bytes)return false;
    let record:z.infer<typeof dispatchSchema>;try{record=dispatchSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{conflict();}if(record.proofDigest!==source.proofDigest)conflict();await this.stable(source.location,source.intent);return true;
  }
  async claimPublication(request:IncomingUploadRequest,mayDispatch:()=>Promise<boolean>){
    request=IncomingUploadRequestSchema.parse(request);if(!await mayDispatch())throw new StorageContractError('FORBIDDEN');const source=await this.evidence(request);if(!source)conflict();if(await this.hasPublicationAttempt(request))return false;
    if(!await mayDispatch())throw new StorageContractError('FORBIDDEN');await this.stable(source.location,source.intent);
    try{await writeNew(path.join(source.location.journal,'dispatch.json'),Buffer.from(canonicalJson({version:1,proofDigest:source.proofDigest},16384)));}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST')return false;throw error;}
    await this.stable(source.location,source.intent);return true;
  }
  async inspect(request:IncomingUploadRequest):Promise<{proof:IncomingUploadProof;proofDigest:string}|null>{
    const source=await this.evidence(request);if(!source)return null;if(!eq(source.proof.payload,await this.payload(path.join(source.location.journal,'payload.part'))))conflict();await this.stable(source.location,source.intent);return{proof:source.proof,proofDigest:source.proofDigest};
  }
  private validateDraft(request:IncomingUploadRequest,draft:UploadedFileDraftDto,root:string){
    if(draft.id!==request.attachmentId||draft.projectId!==request.projectId||draft.messageId!==request.messageId||draft.uploadId!==request.uploadId||draft.size!==request.size||draft.mimeType!==request.mimeType||draft.name!==request.name||key(path.dirname(draft.path))!==key(path.join(root,'.relay_upload','tmp',request.messageId)))conflict();
  }
  async readPublicationRecord(request:IncomingUploadRequest){
    request=IncomingUploadRequestSchema.parse(request);
    const source=await this.evidence(request);if(!source)return null;const bytes=await readSmall(path.join(source.location.journal,'published.json'),32768);if(!bytes)return null;
    let record:z.infer<typeof publicationSchema>;try{record=publicationSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{conflict();}
    if(record.proofDigest!==source.proofDigest||record.file.digest!==source.proof.payload.digest||record.file.size!==request.size)conflict();this.validateDraft(request,record.attachment,source.location.root);await this.stable(source.location,source.intent);return{record,digest:source.proof.payload.digest};
  }
  private async publicFile(request:IncomingUploadRequest,draft:UploadedFileDraftDto,root:string){
    this.validateDraft(request,draft,root);await directory(path.join(root,'.relay_upload','tmp'));await directory(path.dirname(draft.path));return this.payload(draft.path);
  }
  async recordPublication(request:IncomingUploadRequest,rawDraft:UploadedFileDraftDto,mayCommit:()=>Promise<boolean>){
    request=IncomingUploadRequestSchema.parse(request);
    if(!await mayCommit())throw new StorageContractError('FORBIDDEN');const draft=UploadedFileDraftDtoSchema.parse(rawDraft),source=await this.evidence(request);if(!source)conflict();
    const file=await this.publicFile(request,draft,source.location.root);if(file.digest!==source.proof.payload.digest||file.size!==request.size)conflict();
    const record:z.infer<typeof publicationSchema>={version:1,proofDigest:source.proofDigest,attachment:draft,file},previous=await this.readPublicationRecord(request);
    if(previous){if(!eq(previous.record,record))conflict();if(!await mayCommit())throw new StorageContractError('FORBIDDEN');await this.stable(source.location,source.intent);return previous.record;}
    if(!await mayCommit())throw new StorageContractError('FORBIDDEN');await this.stable(source.location,source.intent);await writeNew(path.join(source.location.journal,'published.json'),Buffer.from(canonicalJson(record,32768)));await this.stable(source.location,source.intent);if(!await mayCommit())throw new StorageContractError('FORBIDDEN');return record;
  }
  async cleanupReceived(request:IncomingUploadRequest,mayCleanup:()=>Promise<boolean>){
    request=IncomingUploadRequestSchema.parse(request);
    if(!await mayCleanup())throw new StorageContractError('FORBIDDEN');const source=await this.evidence(request),published=await this.readPublicationRecord(request);if(!source||!published)conflict();
    if(!eq(published.record.file,await this.publicFile(request,published.record.attachment,source.location.root)))conflict();
    const filename=path.join(source.location.journal,'payload.part');if(await stat(filename)){
      if(!eq(source.proof.payload,await this.payload(filename)))conflict();if(!await mayCleanup())throw new StorageContractError('FORBIDDEN');await this.stable(source.location,source.intent);
      if(!exact(await stat(filename),source.proof.payload)||!exact(await stat(published.record.attachment.path),published.record.file))conflict();
      await fs.unlink(filename);
    }
    await this.stable(source.location,source.intent);if(!await mayCleanup())throw new StorageContractError('FORBIDDEN');
  }
  async receive(raw:IncomingUploadRequest,body:ReadableStream<Uint8Array>,control:{mayStage:()=>Promise<boolean>;signal:AbortSignal}){
    control=Object.freeze({...control});
    const request=IncomingUploadRequestSchema.parse(raw),check=async()=>{if(control.signal.aborted||!await control.mayStage()||control.signal.aborted)throw new StorageContractError('FORBIDDEN');};
    await check();const prior=await this.inspect(request);if(prior){await check();void body.cancel().catch(()=>undefined);return prior;}
    const location=await this.location(request,true),intent:Intent={version:1,request,...location.expected};await check();await this.stable(location,intent);
    const contents=await fs.opendir(location.journal);for await(const _entry of contents)conflict();
    // Immutable intent must precede any payload writes. An incomplete retry never replaces or deletes this evidence.
    const bytes=Buffer.from(canonicalJson(intent,16384));try{await writeNew(path.join(location.journal,'request.json'),bytes);}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST')conflict();throw error;}await this.stable(location,intent);
    const filename=path.join(location.journal,'payload.part'),handle=await fs.open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
    let reader:ReadableStreamDefaultReader<Uint8Array>;
    try{reader=body.getReader();}catch{await handle.close();throw new StorageContractError('INVALID_ARGUMENT');}
    let size=0,checked=0,header=Buffer.alloc(0),ended=false;const digest=createHash('sha256');
    const abort=()=>{void reader.cancel().catch(()=>undefined);};control.signal.addEventListener('abort',abort,{once:true});if(control.signal.aborted)abort();
    try{
      for(;;){if(control.signal.aborted)throw new StorageContractError('FORBIDDEN');const next=await reader.read();if(control.signal.aborted)throw new StorageContractError('FORBIDDEN');if(next.done){ended=true;break;}const value=next.value;if(!(value instanceof Uint8Array))throw new StorageContractError('INVALID_ARGUMENT');
        const length=value.byteLength;if(size+length>request.size)throw new StorageContractError('PAYLOAD_TOO_LARGE');
        let offset=0;while(offset<length){const chunk=Buffer.from(value.subarray(offset,offset+65536));if(header.length<16)header=Buffer.concat([header,chunk.subarray(0,16-header.length)]);let written=0;
          while(written<chunk.length){const part=await handle.write(chunk,written,chunk.length-written,size+offset+written);if(!part.bytesWritten)throw new StorageContractError('STORAGE_UNAVAILABLE');written+=part.bytesWritten;}
          digest.update(chunk);offset+=chunk.length;if(size+offset-checked>=1024*1024){await check();await this.stable(location,intent);checked=size+offset;}
        }
        size+=length;if(size-checked>=1024*1024){await check();await this.stable(location,intent);checked=size;}
      }
      if(size!==request.size||hasDangerousHeader(header))throw new StorageContractError('INVALID_ARGUMENT');await check();await this.stable(location,intent);await handle.sync();
      const saved=await handle.stat({bigint:true}),current=await stat(filename);if(!current||current.nlink!==1n||current.isSymbolicLink()||!eq(id(saved),id(current))||Number(saved.size)!==size||current.size!==saved.size||current.mtimeNs!==saved.mtimeNs)conflict();
      const proof:IncomingUploadProof={version:1,intentDigest:hash(bytes),payload:{...id(saved),size,mtime:String(saved.mtimeNs),digest:digest.digest('hex')}};
      await writeNew(path.join(location.journal,'complete.json'),Buffer.from(canonicalJson(proof,16384)));await this.stable(location,intent);await check();return{proof,proofDigest:hash(canonicalJson(proof,16384))};
    }finally{control.signal.removeEventListener('abort',abort);if(!ended)void reader.cancel().catch(()=>undefined);reader.releaseLock();await handle.close();}
  }
}
