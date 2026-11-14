import fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../storage/command-boundary.js';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema=z.object({operationId:uuid,projectPath:z.string().min(1).max(32768),projectId:uuid,sourceDigest:digest,
  entries:z.array(z.object({messageId:uuid,ownerUserId:uuid}).strict()).max(1024)
    .refine(v=>new Set(v.map(e=>e.messageId)).size===v.length).transform(v=>v.sort((a,b)=>a.messageId.localeCompare(b.messageId)))}).strict();
export type QuarantineRequest=z.input<typeof requestSchema>;
type Request=z.output<typeof requestSchema>;
type Outcome='committed'|'rejected'|'unknown';
export interface QuarantineResult {state:'prepared'|'committed'|'rolled-back'|'unknown';operationId:string;intentDigest:string|null}
export class QuarantineError extends Error {
  constructor(readonly code:'QUARANTINE_CONFLICT'|'QUARANTINE_UNCONFIRMED'|'QUARANTINE_OVERLOADED'|'QUARANTINE_CLOSED'|'QUARANTINE_INVALID') {super(code);}
}
function fail(code:QuarantineError['code']='QUARANTINE_CONFLICT'):never{throw new QuarantineError(code);}
const identitySchema=z.object({dev:z.string().regex(/^\d+$/),ino:z.string().regex(/^\d+$/)}).strict();
const fileSchema=identitySchema.extend({name:z.string().min(1).max(255).refine(v=>v!=='.'&&v!=='..'&&!/[\\/:\0]/.test(v)),
  size:z.number().int().nonnegative().max(50*1024*1024),mtime:z.string().regex(/^\d+$/),digest}).strict();
const snapshotSchema=identitySchema.extend({files:z.array(fileSchema).max(101)}).strict();
const manifestSchema=z.object({version:z.literal(2),messageId:uuid,projectId:uuid,userId:uuid,
  createdAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),updatedAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  attachments:z.array(z.object({uploadId:uuid,attachmentId:uuid,name:z.string().min(1).max(255),storedName:fileSchema.shape.name,
    size:fileSchema.shape.size,mimeType:z.string().min(1).max(255),createdAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)})).max(100)});
const intentSchema=z.object({version:z.literal(1),request:requestSchema,roots:z.array(identitySchema).length(5),unmoved:z.boolean().optional(),
  snapshots:z.array(snapshotSchema.nullable()).max(1024)}).strict();
type Identity=z.infer<typeof identitySchema>;type Snapshot=z.infer<typeof snapshotSchema>;type Intent=z.infer<typeof intentSchema>;
const same=(a:unknown,b:unknown)=>canonicalJson(a,2*1024*1024)===canonicalJson(b,2*1024*1024);
const keyPath=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
const identity=(s:BigIntStats):Identity=>({dev:String(s.dev),ino:String(s.ino)});
const absent=(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT';
async function stat(filename:string){try{return await fs.lstat(filename,{bigint:true});}catch(e){if(absent(e))return null;throw e;}}
async function namesIn(dirname:string,limit:number){const names:string[]=[];const dir=await fs.opendir(dirname);
  for await(const entry of dir){names.push(entry.name);if(names.length>limit)fail('QUARANTINE_INVALID');}return names;}
async function directory(filename:string,expected?:Identity){
  const s=await stat(filename);if(!s||!s.isDirectory()||s.isSymbolicLink()||keyPath(await fs.realpath(filename))!==keyPath(filename)||expected&&!same(identity(s),{dev:expected.dev,ino:expected.ino}))fail();return identity(s);
}
async function regular(filename:string,expected?:z.infer<typeof fileSchema>){
  const s=await stat(filename);if(!s)return null;
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>50n*1024n*1024n||expected&&(!same(identity(s),{dev:expected.dev,ino:expected.ino})||Number(s.size)!==expected.size||String(s.mtimeNs)!==expected.mtime))fail();
  return s;
}
async function fileDigest(filename:string,s:BigIntStats){
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await handle.stat({bigint:true});if(!opened.isFile()||opened.dev!==s.dev||opened.ino!==s.ino||opened.size!==s.size||opened.mtimeNs!==s.mtimeNs)fail();
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let bytes=0;
    for(;;){const read=await handle.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;bytes+=read.bytesRead;if(bytes>Number(s.size))fail();hash.update(buffer.subarray(0,read.bytesRead));}
    const after=await handle.stat({bigint:true}),current=await regular(filename);
    if(bytes!==Number(s.size)||!current||current.dev!==s.dev||current.ino!==s.ino||after.size!==s.size||current.size!==s.size||after.mtimeNs!==s.mtimeNs||current.mtimeNs!==s.mtimeNs)fail();
    return hash.digest('hex');
  }finally{await handle.close();}
}
async function jsonFile(filename:string,max=2*1024*1024):Promise<unknown>{
  const s=await stat(filename);if(!s)return null;if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>BigInt(max))fail();
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const opened=await handle.stat({bigint:true});if(opened.dev!==s.dev||opened.ino!==s.ino||opened.size!==s.size)fail();
    const data=Buffer.alloc(Number(s.size)+1),read=await handle.read(data,0,data.length,0),after=await handle.stat({bigint:true});
    if(read.bytesRead!==Number(s.size)||after.size!==s.size||after.mtimeNs!==s.mtimeNs)fail();return JSON.parse(data.subarray(0,read.bytesRead).toString('utf8'));
  }finally{await handle.close();}
}
async function syncDirectory(dirname:string){
  let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{handle=await fs.open(dirname,'r');await handle.sync();}
  catch(e){const code=e&&typeof e==='object'&&'code'in e?e.code:null;if(process.platform!=='win32'||!['EPERM','EACCES','EINVAL','EISDIR'].includes(String(code)))throw e;}
  finally{await handle?.close();}
}
const active=new Map<string,{key:string;result:Promise<QuarantineResult>}>();
/** Candidate internal file boundary. The application must supply current writer fencing and exact DB receipt resolution.
 * No HTTP input, default DB, service startup or automatic history deletion is wired here. */
export class JournaledUploadQuarantine {
  private closed=false;
  private readonly owned=new Set<Promise<QuarantineResult>>();
  constructor(private readonly options:{assertWriter:(request:Readonly<Request>)=>Promise<void>;
    resolveDecision:(request:Readonly<Request>,intentDigest:string)=>Promise<Outcome>;timeoutMs?:number}){
    this.options=Object.freeze({...options});if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>30000))fail('QUARANTINE_INVALID');
  }
  async run(raw:QuarantineRequest,action:'prepare'|'reconcile'|'rollback'):Promise<QuarantineResult>{
    if(this.closed)fail('QUARANTINE_CLOSED');let input:Request;
    try{input=requestSchema.parse(JSON.parse(canonicalJson(raw,256*1024)));if(!path.isAbsolute(input.projectPath)||input.projectPath.includes('\0')||keyPath(path.resolve(input.projectPath))!==keyPath(input.projectPath))fail();}
    catch{fail('QUARANTINE_INVALID');}
    if(action!=='prepare'&&action!=='reconcile'&&action!=='rollback')fail('QUARANTINE_INVALID');
    const root=keyPath(input.projectPath),key=canonicalJson([input,action],256*1024);let job=active.get(root);
    if(job&&job.key!==key)fail('QUARANTINE_OVERLOADED');
    if(!job){if(active.size>=2)fail('QUARANTINE_OVERLOADED');
      const result=Promise.resolve().then(()=>this.perform(input,action)).catch(e=>{throw e instanceof QuarantineError?e:new QuarantineError('QUARANTINE_UNCONFIRMED');});
      job={key,result};active.set(root,job);this.owned.add(result);const owned=job;
      void result.finally(()=>{if(active.get(root)===owned)active.delete(root);this.owned.delete(result);}).catch(()=>undefined);
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([job.result,new Promise<QuarantineResult>(resolve=>{timer=setTimeout(()=>resolve({state:'unknown',operationId:input.operationId,intentDigest:null}),this.options.timeoutMs??10000);timer.unref();})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  async close(){this.closed=true;await Promise.allSettled([...this.owned]);}
  private async perform(input:Request,action:'prepare'|'reconcile'|'rollback'):Promise<QuarantineResult>{
    const upload=path.join(input.projectPath,'.relay_upload'),messages=path.join(upload,'messages'),quarantine=path.join(upload,'.trash-quarantine'),operation=path.join(quarantine,input.operationId);
    const roots=[input.projectPath,upload,messages,quarantine,operation];
    await this.options.assertWriter(structuredClone(input));
    for(const root of roots.slice(0,3))await directory(root);
    if(action==='prepare'||action==='rollback'){
      for(const root of roots.slice(3)){try{await fs.mkdir(root);}catch(e){if(!e||typeof e!=='object'||!('code'in e)||e.code!=='EEXIST')throw e;}await directory(root);}
    }else for(const root of roots.slice(3))await directory(root);
    const intentPath=path.join(operation,'intent.json');let raw=await jsonFile(intentPath),intent:Intent;
    if(raw===null){
      if(action!=='prepare'&&action!=='rollback')fail('QUARANTINE_UNCONFIRMED');
      const names=await namesIn(operation,16);if(names.some(n=>!/^\.write-[a-f0-9-]{36}\.tmp$/.test(n)))fail();
      const snapshots:Intent['snapshots']=[],budget={files:0,bytes:0};
      for(const entry of input.entries){const source=path.join(messages,entry.messageId),s=await stat(source);
        if(action==='rollback'){if(await stat(path.join(operation,entry.messageId)))fail();snapshots.push(null);continue;}
        if(!s){snapshots.push(null);continue;}
        const snapshot=await this.capture(source,input.projectId,entry,budget);snapshots.push(snapshot);
      }
      intent={version:1,request:input,roots:await Promise.all(roots.map(root=>directory(root))),unmoved:action==='rollback',snapshots};
      // An invalid/partial temporary journal is never used as recovery authority. No move precedes publication.
      await this.writeJson(intentPath,intent,()=>this.checkRoots(roots,intent,input));raw=intent;
    }
    intent=intentSchema.parse(raw);if(!same(intent.request,input)||intent.snapshots.length!==input.entries.length)fail();
    if(intent.snapshots.reduce((n,s)=>n+(s?.files.length??0),0)>4096||intent.snapshots.reduce((n,s)=>n+(s?.files.reduce((bytes,f)=>bytes+f.size,0)??0),0)>1024*1024*1024)fail();
    const intentDigest=createHash('sha256').update(canonicalJson(intent,2*1024*1024)).digest('hex');
    const result=(state:QuarantineResult['state']):QuarantineResult=>({state,operationId:input.operationId,intentDigest});
    const check=()=>this.checkRoots(roots,intent,input);await check();
    const decisionPath=path.join(operation,'decision.json'),donePath=path.join(operation,'done.json'),preparedPath=path.join(operation,'prepared.json');
    const stored=await jsonFile(decisionPath),done=await jsonFile(donePath);
    const decisionSchema=z.object({intentDigest:digest,outcome:z.enum(['committed','rejected'])}).strict();
    const prior=stored===null?null:decisionSchema.parse(stored);if(prior&&prior.intentDigest!==intentDigest)fail();
    if(done!==null&&(!prior||!same(done,prior)))fail();
    if(action==='prepare'){
      if(intent.unmoved)fail();
      if(done!==null)return result(prior!.outcome==='committed'?'committed':'rolled-back');
      if(prior)fail();
      for(let i=0;i<input.entries.length;i++){
        await check();const source=path.join(messages,input.entries[i]!.messageId),target=path.join(operation,input.entries[i]!.messageId),snapshot=intent.snapshots[i]!;
        const [a,b]=await Promise.all([stat(source),stat(target)]);
        if(snapshot===null){if(a||b)fail();continue;}
        if(!!a===!!b)fail();
        await this.verify(a?source:target,snapshot,false);
        if(a){await check();if(await stat(target))fail();await fs.rename(source,target);await syncDirectory(messages);await syncDirectory(operation);await this.verify(target,snapshot,false);}
      }
      await this.writeJson(preparedPath,{intentDigest},check);return result('prepared');
    }
    const outcome=await this.options.resolveDecision(structuredClone(input),intentDigest);await check();
    if(outcome==='unknown')return result('unknown');if(outcome!=='committed'&&outcome!=='rejected'||prior&&prior.outcome!==outcome)fail();
    if((action==='rollback'||intent.unmoved)&&outcome!=='rejected')fail();
    if(done!==null)return result(outcome==='committed'?'committed':'rolled-back');
    if(outcome==='committed'&&!same(await jsonFile(preparedPath),{intentDigest}))fail();
    const decision={intentDigest,outcome};await this.writeJson(decisionPath,decision,check);
    for(let i=0;i<input.entries.length;i++){
      await check();const source=path.join(messages,input.entries[i]!.messageId),target=path.join(operation,input.entries[i]!.messageId),snapshot=intent.snapshots[i]!;
      const [a,b]=await Promise.all([stat(source),stat(target)]);
      if(intent.unmoved){if(b)fail();continue;}
      if(snapshot===null){if(a||b)fail();continue;}
      if(outcome==='rejected'){
        if(!!a===!!b)fail();await this.verify(a?source:target,snapshot,false);
        if(b){await check();if(await stat(source))fail();await fs.rename(target,source);await syncDirectory(messages);await syncDirectory(operation);}
      }else{
        if(a)fail();if(!b)continue;await this.verify(target,snapshot,true);
        for(const file of snapshot.files){const filename=path.join(target,file.name);if(!await stat(filename))continue;
          await check();await this.verifyFile(filename,file);await check();await fs.unlink(filename);}
        await check();await directory(target,snapshot);await fs.rmdir(target);await syncDirectory(operation);
      }
    }
    await this.writeJson(donePath,decision,check);return result(outcome==='committed'?'committed':'rolled-back');
  }
  private async checkRoots(roots:string[],intent:Intent,input:Request){
    await this.options.assertWriter(structuredClone(input));for(let i=0;i<roots.length;i++)await directory(roots[i]!,intent.roots[i]);
  }
  private async writeJson(filename:string,value:unknown,check:()=>Promise<void>){
    const encoded=canonicalJson(value,2*1024*1024);await check();const previous=await jsonFile(filename);
    if(previous!==null){if(!same(previous,value))fail();return;}
    const temporary=path.join(path.dirname(filename),`.write-${randomUUID()}.tmp`),handle=await fs.open(temporary,'wx');
    try{await handle.writeFile(encoded,'utf8');await handle.sync();}finally{await handle.close();}
    await check();if(await stat(filename))fail();await fs.rename(temporary,filename);await syncDirectory(path.dirname(filename));
  }
  private async capture(dirname:string,projectId:string,entry:Request['entries'][number],budget:{files:number;bytes:number}):Promise<Snapshot>{
    const before=await directory(dirname),raw=await jsonFile(path.join(dirname,'manifest.json'),128*1024);
    const parsed=manifestSchema.safeParse(raw);if(!parsed.success)fail();const manifest=parsed.data;
    if(manifest.messageId!==entry.messageId||manifest.projectId!==projectId||manifest.userId!==entry.ownerUserId
      ||new Set(manifest.attachments.map(a=>a.attachmentId)).size!==manifest.attachments.length||new Set(manifest.attachments.map(a=>a.uploadId)).size!==manifest.attachments.length)fail();
    const names=['manifest.json',...manifest.attachments.map(a=>a.storedName)].sort();
    if(new Set(names.map(n=>n.toLowerCase())).size!==names.length||!same((await namesIn(dirname,101)).sort(),names))fail();
    const files:Snapshot['files']=[];let messageBytes=0;
    for(const name of names){if(!fileSchema.shape.name.safeParse(name).success)fail();const filename=path.join(dirname,name),s=await regular(filename);if(!s)fail();
      const declared=manifest.attachments.find(a=>a.storedName===name);if(declared&&declared.size!==Number(s.size))fail();
      budget.files++;budget.bytes+=Number(s.size);messageBytes+=Number(s.size);
      if(budget.files>4096||budget.bytes>1024*1024*1024||messageBytes>200*1024*1024+128*1024)fail('QUARANTINE_INVALID');
      files.push({...identity(s),name,size:Number(s.size),mtime:String(s.mtimeNs),digest:await fileDigest(filename,s)});}
    if(!same(await jsonFile(path.join(dirname,'manifest.json'),128*1024),raw))fail();
    await directory(dirname,before);return {...before,files};
  }
  private async verifyFile(filename:string,file:Snapshot['files'][number]){const s=await regular(filename,file);if(!s||await fileDigest(filename,s)!==file.digest)fail();}
  private async verify(dirname:string,snapshot:Snapshot,allowMissing:boolean){
    await directory(dirname,snapshot);const names=await namesIn(dirname,101),expected=new Set(snapshot.files.map(f=>f.name));
    if(names.some(n=>!expected.has(n))||!allowMissing&&names.length!==expected.size)fail();
    for(const file of snapshot.files){if(!names.includes(file.name)){if(allowMissing)continue;fail();}await this.verifyFile(path.join(dirname,file.name),file);}
  }
}
