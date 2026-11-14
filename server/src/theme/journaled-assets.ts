import fs from 'node:fs/promises';
import { constants,type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import type { ThemeAssetJob } from '../storage/contracts.js';
import { validateThemeBackgroundUpload,type ThemeAssetVariant,MAX_THEME_ASSET_BYTES } from './theme-assets.js';

type Request=ThemeAssetJob['request'];type Pair={desktop:Uint8Array;mobile:Uint8Array};
const uuid=z.string().uuid().refine(v=>v===v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const fileInput=z.object({digest:hash,size:z.number().int().min(1).max(MAX_THEME_ASSET_BYTES)}).strict();
const requestSchema=z.object({jobId:uuid,kind:z.enum(['upload','delete']),assetId:uuid,userId:uuid,desktop:fileInput.nullable(),mobile:fileInput.nullable(),sourceCreatedAt:z.number().int().nonnegative().nullable()}).strict();
const identitySchema=z.object({dev:z.string().regex(/^\d+$/),ino:z.string().regex(/^\d+$/)}).strict();
const fileSchema=identitySchema.extend({size:z.number().int().min(1).max(MAX_THEME_ASSET_BYTES),digest:hash,mtime:z.string().regex(/^\d+$/)}).strict();
const manifestSchema=z.object({version:z.literal(1),request:requestSchema,root:identitySchema,user:identitySchema,journal:identitySchema,
  ready:z.boolean(),files:z.object({desktop:fileSchema.nullable(),mobile:fileSchema.nullable()}).strict()}).strict()
  .refine(value=>value.ready||value.files.desktop===null&&value.files.mobile===null);
type Identity=z.infer<typeof identitySchema>;type File=z.infer<typeof fileSchema>;type Manifest=z.infer<typeof manifestSchema>;
const variants=['desktop','mobile'] as const;
const identity=(s:BigIntStats):Identity=>({dev:String(s.dev),ino:String(s.ino)});
const eq=(a:unknown,b:unknown)=>canonicalJson(a,16384)===canonicalJson(b,16384);
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const key=(filename:string)=>process.platform==='win32'?filename.toLowerCase():filename;
const absent=(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT';
function fail():never{throw new StorageContractError('CONFLICT');}
async function stat(filename:string){try{return await fs.lstat(filename,{bigint:true});}catch(e){if(absent(e))return null;throw e;}}
async function directory(filename:string,expected?:Identity){
  const s=await stat(filename);if(!s||!s.isDirectory()||s.isSymbolicLink()||key(await fs.realpath(filename))!==key(filename)||expected&&!eq(identity(s),expected))fail();return identity(s);
}
async function ensureDirectory(filename:string){await directory(path.dirname(filename));try{await fs.mkdir(filename);await syncDirectory(path.dirname(filename));}catch(e){if(!e||typeof e!=='object'||!('code'in e)||e.code!=='EEXIST')throw e;}return directory(filename);}
async function readFile(filename:string,max:number,links:readonly bigint[]=[1n]){
  const before=await stat(filename);if(!before)return null;
  if(!before.isFile()||before.isSymbolicLink()||!links.includes(before.nlink)||before.size>BigInt(max))fail();
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await handle.stat({bigint:true});if(!eq(identity(opened),identity(before))||opened.size!==before.size||opened.mtimeNs!==before.mtimeNs)fail();
    const bytes=Buffer.alloc(Number(before.size)+1);let size=0;
    for(;;){const part=await handle.read(bytes,size,bytes.length-size,null);if(!part.bytesRead)break;size+=part.bytesRead;if(size>Number(before.size))fail();}
    const after=await handle.stat({bigint:true}),current=await stat(filename);
    if(size!==Number(before.size)||!current||!eq(identity(current),identity(before))||after.size!==before.size||current.size!==before.size||after.mtimeNs!==before.mtimeNs||current.mtimeNs!==before.mtimeNs||!links.includes(current.nlink))fail();
    return{bytes:bytes.subarray(0,size),snapshot:{...identity(before),size,digest:digest(bytes.subarray(0,size)),mtime:String(before.mtimeNs)} as File};
  }finally{await handle.close();}
}
async function writeExclusive(filename:string,bytes:Uint8Array){
  const handle=await fs.open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function syncDirectory(filename:string){
  if(process.platform==='win32')return; // Windows directory durability is an explicit T7 gate, not a fake fsync success.
  const handle=await fs.open(filename,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}
}
/** All paths derive from current, private DB requests and a fixed trusted root. No arbitrary deletion or recursive cleanup. */
export class JournaledThemeAssets {
  readonly root:string;
  constructor(root:string,private readonly assertWriter:(request:Request)=>Promise<void>){if(!path.isAbsolute(root))throw new StorageContractError('INVALID_ARGUMENT');this.root=path.resolve(root);}
  private paths(request:Request){
    request=requestSchema.parse(request);const user=path.join(this.root,request.userId),journals=path.join(this.root,'.relay-assets'),journal=path.join(journals,request.jobId);
    return{user,journals,journal,manifest:path.join(journal,'intent.json'),final:(v:ThemeAssetVariant)=>path.join(user,`${request.assetId}-${v}.webp`),stage:(v:ThemeAssetVariant)=>path.join(journal,`${v}.webp`)};
  }
  private async guard(manifest:Manifest){
    await this.assertWriter(manifest.request);const p=this.paths(manifest.request);
    await directory(this.root,manifest.root);await directory(p.user,manifest.user);await directory(p.journals);await directory(p.journal,manifest.journal);return p;
  }
  private async load(request:Request){
    await this.assertWriter(request);const p=this.paths(request);await directory(this.root);await directory(p.user);await directory(p.journals);await directory(p.journal);
    const file=await readFile(p.manifest,16384);if(!file)fail();const parsed=manifestSchema.safeParse(JSON.parse(file.bytes.toString('utf8')));if(!parsed.success||!eq(parsed.data.request,request))fail();
    if(parsed.data.ready&&request.kind==='upload')for(const v of variants){const expected=request[v],actual=parsed.data.files[v];if(!expected||!actual||actual.size!==expected.size||actual.digest!==expected.digest)fail();}
    await this.guard(parsed.data);return parsed.data;
  }
  private async verify(filename:string,snapshot:File,links:readonly bigint[]=[1n,2n]){
    const file=await readFile(filename,MAX_THEME_ASSET_BYTES,links);if(!file||!eq(file.snapshot,snapshot))fail();return file;
  }
  private async unlink(filename:string,snapshot:File,manifest:Manifest){
    if(!await stat(filename))return;
    await this.guard(manifest);await this.verify(filename,snapshot);await fs.unlink(filename);
  }
  private async link(from:string,to:string,snapshot:File,manifest:Manifest){
    await this.guard(manifest);await this.verify(from,snapshot);
    if(await stat(to)){await this.verify(to,snapshot);return;}
    await fs.link(from,to);await this.verify(to,snapshot);
  }
  async prepare(raw:Request,pair?:Pair):Promise<{proofDigest:string}>{
    const request=requestSchema.parse(JSON.parse(canonicalJson(raw,4096))),p=this.paths(request);await this.assertWriter(request);
    await ensureDirectory(this.root);await ensureDirectory(p.user);await ensureDirectory(p.journals);
    let manifest:Manifest;
    if(await stat(p.journal))manifest=await this.load(request);
    else{
      const journal=await ensureDirectory(p.journal);manifest={version:1,request,root:await directory(this.root),user:await directory(p.user),journal,ready:request.kind==='delete',files:{desktop:null,mobile:null}};
      if(request.kind==='delete')for(const variant of variants){const original=await readFile(p.final(variant),MAX_THEME_ASSET_BYTES);manifest.files[variant]=original?.snapshot??null;}
      await writeExclusive(p.manifest,Buffer.from(canonicalJson(manifest,16384)));await syncDirectory(p.journal);await syncDirectory(p.journals);
    }
    await this.guard(manifest);
    if(!manifest.ready){
      if(!pair)fail();
      for(const variant of variants){const expected=request[variant];if(!expected||pair[variant].byteLength!==expected.size||digest(pair[variant])!==expected.digest||!validateThemeBackgroundUpload(variant,pair[variant]).ok)fail();
        if(!await stat(p.stage(variant)))await writeExclusive(p.stage(variant),pair[variant]);
        const staged=await readFile(p.stage(variant),MAX_THEME_ASSET_BYTES);if(!staged||staged.snapshot.digest!==expected.digest||staged.snapshot.size!==expected.size)fail();manifest.files[variant]=staged.snapshot;
      }
      const current=await readFile(p.manifest,16384);if(!current||!eq(JSON.parse(current.bytes.toString('utf8')),{...manifest,ready:false,files:{desktop:null,mobile:null}}))fail();
      manifest.ready=true;await this.guard(manifest);const temporary=path.join(p.journal,'intent.next');await writeExclusive(temporary,Buffer.from(canonicalJson(manifest,16384)));
      await fs.rename(temporary,p.manifest);await syncDirectory(p.journal);
    }
    return{proofDigest:digest(canonicalJson(manifest,16384))};
  }
  /** The service must bind this exact immutable proof in the DB before any public file is linked or isolated. */
  async apply(raw:Request,expectedProof:string):Promise<{proofDigest:string}>{
    const request=requestSchema.parse(raw),manifest=await this.load(request),p=this.paths(request),proofDigest=digest(canonicalJson(manifest,16384));
    if(!manifest.ready||proofDigest!==expectedProof)fail();
    for(const variant of variants){
      const snapshot=manifest.files[variant];
      if(request.kind==='upload'){
        if(!snapshot)fail();await this.link(p.stage(variant),p.final(variant),snapshot,manifest);
      }else if(snapshot){
        if(await stat(p.final(variant))){await this.link(p.final(variant),p.stage(variant),snapshot,manifest);await this.unlink(p.final(variant),snapshot,manifest);}
        else await this.verify(p.stage(variant),snapshot);
      }else if(await stat(p.final(variant)))fail();
    }
    await syncDirectory(p.user);await syncDirectory(p.journal);return{proofDigest};
  }
  async settle(raw:Request,decision:'committed'|'rejected',expectedProof:string|null):Promise<{proofDigest:string}>{
    const request=requestSchema.parse(raw),p=this.paths(request);
    if(!await stat(p.journal))fail(); // A missing started journal is not proof that no file action happened.
    const manifest=await this.load(request),proofDigest=digest(canonicalJson(manifest,16384));if(expectedProof&&expectedProof!==proofDigest)fail();
    if(!manifest.ready){if(decision!=='rejected')fail();return{proofDigest};} // Preserve partial private staging; never recursively erase unverifiable data.
    for(const variant of variants){const snapshot=manifest.files[variant];
      if(request.kind==='upload'){
        if(!snapshot)fail();
        if(decision==='committed'){await this.verify(p.final(variant),snapshot);await this.unlink(p.stage(variant),snapshot,manifest);}
        else{await this.unlink(p.final(variant),snapshot,manifest);await this.unlink(p.stage(variant),snapshot,manifest);}
      }else if(snapshot){
        if(decision==='committed'){if(await stat(p.final(variant)))fail();await this.unlink(p.stage(variant),snapshot,manifest);}
        else{
          if(await stat(p.stage(variant))){await this.link(p.stage(variant),p.final(variant),snapshot,manifest);await this.unlink(p.stage(variant),snapshot,manifest);}
          else await this.verify(p.final(variant),snapshot,[1n]);
        }
      }else if(await stat(p.final(variant)))fail();
    }
    await syncDirectory(p.user);await syncDirectory(p.journal);return{proofDigest};
  }
  async read(userId:string,assetId:string,variant:ThemeAssetVariant):Promise<Buffer|null>{
    uuid.parse(userId);uuid.parse(assetId);if(!variants.includes(variant))throw new StorageContractError('INVALID_ARGUMENT');
    await directory(this.root);const user=path.join(this.root,userId);await directory(user);
    const file=await readFile(path.join(user,`${assetId}-${variant}.webp`),MAX_THEME_ASSET_BYTES);if(!file)return null;
    if(!validateThemeBackgroundUpload(variant,file.bytes).ok)fail();await directory(this.root);await directory(user);return file.bytes;
  }
}
