import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { fileIdentitySchema as identity,fileProofSchema as proof,uploadManifestSchema,hash,equal,sameId,stat,directory,mkdir,writeNew,readFile,metadata,unchanged,manifest,journalConflict } from './file-journal-primitives.js';
const uuid=z.string().uuid(),lower=uuid.transform(v=>v.toLowerCase());
const requestSchema=z.object({jobId:lower,projectId:lower,projectPath:z.string().min(1).max(32768).refine(v=>path.isAbsolute(v)&&!v.includes('\0')),ownerUserId:lower,uploaderUserId:lower.nullable(),attachmentIds:z.array(lower).min(1).max(10).refine(v=>new Set(v).size===v.length).nullable()}).strict();
export type ArchivedCleanupRequest=z.input<typeof requestSchema>;
type Request=z.output<typeof requestSchema>;
const targetSchema=z.object({entry:uploadManifestSchema.shape.attachments.element,payload:proof.nullable()}).strict();
const groupSchema=z.object({messageId:uuid,directory:identity,bucket:identity,manifest:proof,before:uploadManifestSchema,after:uploadManifestSchema,targets:z.array(targetSchema).min(1).max(1000)}).strict();
const rootsSchema=z.object({root:identity,uploads:identity,messages:identity.nullable(),cleanup:identity,job:identity}).strict();
const planSchema=z.object({version:z.literal(1),kind:z.literal('archived-cleanup'),request:requestSchema,roots:rootsSchema,unmoved:z.boolean(),groups:z.array(groupSchema).max(1000)}).strict();
type Plan=z.infer<typeof planSchema>;type Group=Plan['groups'][number];
export interface ArchivedCleanupResult{state:'prepared'|'committed'|'rolled-back'|'unknown';intentDigest:string;deletedCount:number}
function fail():never{return journalConflict();}

/** Must run inside ProjectFileActivities and the cross-process owner. Native decides before irreversible byte cleanup. */
export class ArchivedUploadCleanup{
  constructor(private readonly options:{assertWriter:(request:Request,control:{mode:'read'|'write';intentDigest:string|null})=>Promise<void>;resolveDecision:(request:Request,intentDigest:string)=>Promise<'committed'|'rejected'|'unknown'>}){this.options=Object.freeze({...options});}
  async run(raw:ArchivedCleanupRequest,action:'prepare'|'reconcile'|'rollback',signal?:AbortSignal):Promise<ArchivedCleanupResult>{
    const request=requestSchema.parse(JSON.parse(canonicalJson(raw,16384)));if(!['prepare','reconcile','rollback'].includes(action))throw new StorageContractError('INVALID_ARGUMENT');
    const root=await fs.realpath(request.projectPath),uploads=path.join(root,'.relay_upload'),messages=path.join(uploads,'messages'),cleanup=path.join(uploads,'.cleanup'),job=path.join(cleanup,request.jobId),locations={root,uploads,messages,cleanup,job};
    let intentDigestForGuard:string|null=null,writeMode=false;
    const rootId=await directory(root),guard=async()=>{if(signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');await this.options.assertWriter(structuredClone(request),{mode:writeMode?'write':'read',intentDigest:intentDigestForGuard});if(signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');if(await fs.realpath(request.projectPath)!==root)fail();await directory(root,rootId);};
    await guard();let saved=await metadata(path.join(job,'request.json'),2*1024*1024),plan:Plan;
    if(saved){const parsed=planSchema.safeParse(saved.value);if(!parsed.success)fail();plan=parsed.data;if(!equal(plan.request,request))fail();}
    else{
      if(action==='reconcile')throw new StorageContractError('NOT_FOUND');const groups:Group[]=[];let entries=0,totalMetadata=0,totalPayload=0,selectedCount=0;const hasMessages=!!await stat(messages);
      if(hasMessages){await directory(uploads);await directory(messages);}
      if(action==='prepare'&&hasMessages){const stream=await fs.opendir(messages);
        for await(const item of stream){if(++entries>10000)throw new StorageContractError('PAYLOAD_TOO_LARGE');if(!uuid.safeParse(item.name).success)continue;const target=path.join(messages,item.name),sourceId=await directory(target),document=await metadata(path.join(target,'manifest.json'),128*1024);if(!document)continue;
          totalMetadata+=document.proof.size;if(totalMetadata>8*1024*1024)throw new StorageContractError('PAYLOAD_TOO_LARGE');const before=manifest(document.value);if(!sameId(before.messageId,item.name))fail();
          if(!sameId(before.projectId,request.projectId)||request.uploaderUserId&&!sameId(before.userId,request.uploaderUserId))continue;
          const selected=before.attachments.filter(entry=>!request.attachmentIds||request.attachmentIds.includes(entry.attachmentId.toLowerCase()));if(!selected.length)continue;
          if(selectedCount+selected.length>1000)throw new StorageContractError('PAYLOAD_TOO_LARGE');selectedCount+=selected.length;const targets:Group['targets']=[];
          for(const entry of selected){totalPayload+=entry.size;if(totalPayload>1024*1024*1024)throw new StorageContractError('PAYLOAD_TOO_LARGE');const value=await readFile(path.join(target,entry.storedName),50*1024*1024);if(value&&value.proof.size!==entry.size)fail();targets.push({entry,payload:value?.proof??null});}
          const ids=new Set(selected.map(entry=>entry.attachmentId.toLowerCase()));groups.push({messageId:item.name,directory:sourceId,bucket:{dev:'0',ino:'0'},manifest:document.proof,before,after:{...before,updatedAt:Math.max(Date.now(),before.updatedAt),attachments:before.attachments.filter(entry=>!ids.has(entry.attachmentId.toLowerCase()))},targets});
        }
      }
      writeMode=true;await guard();const uploadsId=await mkdir(uploads),cleanupId=await mkdir(cleanup),jobId=await mkdir(job),ignore=path.join(uploads,'.gitignore');if(!await stat(ignore))await writeNew(ignore,Buffer.from('*\n'));const ignored=await readFile(ignore,4096,true);if(!ignored||!ignored.bytes!.toString('utf8').split(/\r?\n/).includes('*'))fail();
      for await(const entry of await fs.opendir(job)){if(!uuid.safeParse(entry.name).success)fail();const location=path.join(job,entry.name);await directory(location);for await(const _ of await fs.opendir(location))fail();}
      for(const group of groups)group.bucket=await mkdir(path.join(job,group.messageId));
      plan=planSchema.parse({version:1,kind:'archived-cleanup',request,roots:{root:rootId,uploads:uploadsId,messages:hasMessages?await directory(messages):null,cleanup:cleanupId,job:jobId},unmoved:action==='rollback',groups});await guard();await writeNew(path.join(job,'request.json'),Buffer.from(canonicalJson(plan,2*1024*1024)));
    }
    if(plan.groups.reduce((n,g)=>n+g.targets.length,0)>1000||plan.groups.reduce((n,g)=>n+g.targets.reduce((v,t)=>v+t.entry.size,0),0)>1024*1024*1024||plan.unmoved&&plan.groups.length)fail();
    const messageIds=plan.groups.map(g=>g.messageId.toLowerCase()),attachmentIds=plan.groups.flatMap(g=>g.targets.map(t=>t.entry.attachmentId.toLowerCase()));if(new Set(messageIds).size!==messageIds.length||new Set(attachmentIds).size!==attachmentIds.length)fail();
    for(const group of plan.groups){const ids=new Set(group.targets.map(t=>t.entry.attachmentId.toLowerCase()));if(!sameId(group.before.projectId,request.projectId)||!sameId(group.before.messageId,group.messageId)||request.uploaderUserId&&!sameId(group.before.userId,request.uploaderUserId)||request.attachmentIds&&[...ids].some(id=>!request.attachmentIds!.includes(id)))fail();
      for(const target of group.targets){if(!equal(group.before.attachments.find(v=>sameId(v.attachmentId,target.entry.attachmentId)),target.entry)||target.payload&&target.payload.size!==target.entry.size)fail();}
      if(!equal({...group.before,updatedAt:group.after.updatedAt,attachments:group.before.attachments.filter(v=>!ids.has(v.attachmentId.toLowerCase()))},group.after))fail();
    }
    const stable=async()=>{await guard();for(const name of ['root','uploads','cleanup','job'] as const)await directory(locations[name],plan.roots[name]);if(plan.roots.messages)await directory(messages,plan.roots.messages);};
    const intentDigest=hash(canonicalJson(plan,2*1024*1024)),deletedCount=attachmentIds.length,result=(state:ArchivedCleanupResult['state']):ArchivedCleanupResult=>({state,intentDigest,deletedCount});
    intentDigestForGuard=intentDigest;writeMode=true;
    const ready={version:1,intentDigest,deletedCount},readyPath=path.join(job,'prepared.json'),decisionPath=path.join(job,'decision.json'),donePath=path.join(job,'complete.json');
    const assertRecord=async(filename:string,value:unknown)=>{const record=await metadata(filename,4096);if(record&&!equal(record.value,value))fail();return!!record;};
    await stable();
    const groupState=async(group:Group)=>{
      await stable();const publicDirectory=path.join(messages,group.messageId),bucket=path.join(job,group.messageId);await directory(publicDirectory,group.directory);await directory(bucket,group.bucket);
      const filename=path.join(publicDirectory,'manifest.json'),document=await metadata(filename,128*1024);if(!document)fail();const value=manifest(document.value);if(!sameId(value.messageId,group.messageId)||!sameId(value.projectId,request.projectId)||!sameId(value.userId,group.before.userId))fail();
      return{publicDirectory,bucket,filename,document,value};
    };
    const replaceManifest=async(group:Group,value:Group['before'],expected:NonNullable<Awaited<ReturnType<typeof metadata>>>,name:string)=>{
      const state=await groupState(group),bytes=Buffer.from(canonicalJson(value,128*1024)),temporary=path.join(state.bucket,name),existing=await readFile(temporary,128*1024);
      if(existing){if(existing.proof.digest!==hash(bytes))fail();}else await writeNew(temporary,bytes);
      await stable();const current=await metadata(state.filename,128*1024),prepared=await readFile(temporary,128*1024);if(!current||!equal(current.proof,expected.proof)||!prepared||prepared.proof.digest!==hash(bytes))fail();await stable();await unchanged(state.filename,current.proof);await unchanged(temporary,prepared.proof);await fs.rename(temporary,state.filename);
    };
    if(action==='prepare'){
      if(plan.unmoved)fail();if(await metadata(decisionPath,4096)||await metadata(donePath,4096))fail();
      for(const group of plan.groups){let state=await groupState(group);const before=equal(state.document.proof,group.manifest),after=equal(state.value,group.after);if(!before&&!after)fail();
        for(const target of group.targets){const source=path.join(state.publicDirectory,target.entry.storedName),privatePath=path.join(state.bucket,target.entry.attachmentId.toLowerCase()+'.payload'),a=await readFile(source,50*1024*1024),b=await readFile(privatePath,50*1024*1024);
          if(!target.payload){if(a||b)fail();continue;}if(a&&b||!a&&!b||a&&!equal(a.proof,target.payload)||b&&!equal(b.proof,target.payload)||after&&a)fail();
          if(a){await stable();await unchanged(source,a.proof);if(await stat(privatePath))fail();await fs.rename(source,privatePath);const moved=await readFile(privatePath,50*1024*1024);if(!moved||!equal(moved.proof,target.payload))fail();}
        }
        state=await groupState(group);if(equal(state.document.proof,group.manifest))await replaceManifest(group,group.after,state.document,'manifest.next.json');else if(!equal(state.value,group.after))fail();
      }
      for(const group of plan.groups){const state=await groupState(group);if(!equal(state.value,group.after))fail();for(const target of group.targets){if(await stat(path.join(state.publicDirectory,target.entry.storedName)))fail();const value=await readFile(path.join(state.bucket,target.entry.attachmentId.toLowerCase()+'.payload'),50*1024*1024);if(target.payload?!value||!equal(value.proof,target.payload):!!value)fail();}}
      await stable();if(!await assertRecord(readyPath,ready))await writeNew(readyPath,Buffer.from(canonicalJson(ready,4096)));await stable();return result('prepared');
    }
    const outcome=await this.options.resolveDecision(structuredClone(request),intentDigest);if(outcome==='unknown'||action==='rollback'&&outcome!=='rejected')return result('unknown');
    const decision={version:1,intentDigest,outcome,deletedCount};if(outcome==='committed'&&!await assertRecord(readyPath,ready))return result('unknown');
    const existing=await metadata(decisionPath,4096);if(existing&&!equal(existing.value,decision))fail();await stable();if(!existing)await writeNew(decisionPath,Buffer.from(canonicalJson(decision,4096)));
    if(await assertRecord(donePath,decision))return result(outcome==='committed'?'committed':'rolled-back');
    for(const group of plan.groups){let state=await groupState(group);
      if(outcome==='committed'){
        const ids=new Set(group.targets.map(t=>t.entry.attachmentId.toLowerCase()));if(state.value.attachments.some(entry=>ids.has(entry.attachmentId.toLowerCase())))fail();
        for(const target of group.targets){const filename=path.join(state.bucket,target.entry.attachmentId.toLowerCase()+'.payload'),value=await readFile(filename,50*1024*1024);if(!value)continue;if(!target.payload||!equal(value.proof,target.payload))fail();await stable();await unchanged(filename,value.proof);await fs.unlink(filename);}
      }else{
        if(!equal(state.value,group.before)&&!equal(state.value,group.after))fail();
        for(const target of group.targets){const source=path.join(state.bucket,target.entry.attachmentId.toLowerCase()+'.payload'),publicPath=path.join(state.publicDirectory,target.entry.storedName),a=await readFile(source,50*1024*1024),b=await readFile(publicPath,50*1024*1024);
          if(!target.payload){if(a||b)fail();continue;}if(a&&b||!a&&!b||a&&!equal(a.proof,target.payload)||b&&!equal(b.proof,target.payload))fail();
          if(a){await stable();await unchanged(source,a.proof);if(await stat(publicPath))fail();await fs.rename(source,publicPath);const restored=await readFile(publicPath,50*1024*1024);if(!restored||!equal(restored.proof,target.payload))fail();}
        }
        state=await groupState(group);if(equal(state.value,group.after))await replaceManifest(group,group.before,state.document,'manifest.restore.json');else if(!equal(state.value,group.before))fail();
      }
    }
    await stable();await writeNew(donePath,Buffer.from(canonicalJson(decision,4096)));await stable();return result(outcome==='committed'?'committed':'rolled-back');
  }
}
