import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { CoreStoragePort, StoragePrincipal } from '../storage/contracts.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { HostedSiteSchema, HostingPublicIdSchema, HostingSourceSchema, HOSTING_UPLOAD_BYTES, HOSTING_FILE_COUNT, type HostedSite, type HostingInspection, type HostingSource } from './contract.js';
import { safePackagePath } from './file-paths.js';
import { HostingError } from './errors.js';
export { HostingError } from './errors.js';

type Principal = Extract<StoragePrincipal, {kind:'user'}>;
type HostingInput = {
  source: HostingSource;
  body: ReadableStream<Uint8Array> | null;
  length: number;
};
export function createHostingPublicId(sites:Pick<HostedSite,'publicId'>[],generate=()=>Array.from({length:10},()=>'abcdefghijklmnopqrstuvwxyz0123456789'[randomInt(36)]).join('')){
  const used=new Set(sites.map(site=>site.publicId));
  for(let attempt=0;attempt<100;attempt++){const id=generate();if(HostingPublicIdSchema.safeParse(id).success&&!used.has(id))return id;}
  throw new HostingError('生成访问地址失败，请重试',503);
}
const uuid = z.string().uuid();
const STAGE_TTL = 60 * 60 * 1000;
const markerSchema = z.object({owner:z.string(),source:HostingSourceSchema.optional(),inspection:z.object({uploadId:uuid,previewToken:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number(),entries:z.array(z.string()).max(HOSTING_FILE_COUNT),suggestedEntry:z.string().nullable(),fileCount:z.number(),totalBytes:z.number(),rewritten:z.number(),warnings:z.array(z.string()).max(40),warningCount:z.number()})});
const journalSchema = z.object({old:HostedSiteSchema.nullable(),next:HostedSiteSchema.nullable(),uploadId:uuid.nullable()}).refine(value=>
  !!(value.old||value.next)&&(!value.old||!value.next||value.old.id===value.next.id)&&(!value.next||!!value.uploadId));
const missing = (error:unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
async function exists(filename:string){try{await fs.lstat(filename);return true;}catch(error){if(missing(error))return false;throw error;}}

export class PageHosting {
  private tail:Promise<unknown> = Promise.resolve();
  private activeUploads=0;
  private closed=false;
  private reads=0;
  private initialized?:Promise<void>;
  private workers=new Set<Worker>();
  private imports=new Set<Promise<HostingInspection>>();
  private closing=new AbortController();
  private readStreams=new Set<Readable>();
  private cleanupTimer:ReturnType<typeof setInterval>;
  constructor(private options:{root:string;port:CoreStoragePort;storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;processingTimeoutMs?:number}){
    this.cleanupTimer=setInterval(()=>{if(this.initialized)void this.lock(async()=>{await this.recover();await this.prune();}).catch(()=>undefined);},10*60*1000);this.cleanupTimer.unref();
  }
  async close(){
    this.closed=true;this.closing.abort();clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.readStreams].map(stream=>new Promise<void>(resolve=>{stream.once('close',()=>resolve());stream.destroy();})));
    await Promise.allSettled([...this.workers].map(worker=>worker.terminate()));
    await Promise.allSettled([...this.imports]);await this.tail;
  }
  private async inspect(input:Parameters<typeof import('./package.js').inspectPackage>[0]):Promise<Omit<HostingInspection,'uploadId'|'previewToken'|'expiresAt'>>{
    if(this.closed)throw new HostingError('页面托管暂不可用',503);
    const worker=new Worker(new URL('./package-worker-bootstrap.mjs',import.meta.url),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:256}});this.workers.add(worker);
    try{return await new Promise((resolve,reject)=>{
      let reply:any,timedOut=false,failed=false;
      const timer=setTimeout(()=>{timedOut=true;void worker.terminate().catch(()=>undefined);},this.options.processingTimeoutMs??120_000);
      worker.on('message',value=>{reply=value;});
      worker.once('error',()=>{failed=true;});
      worker.once('exit',code=>{
        clearTimeout(timer);
        if(timedOut)reject(new HostingError('处理超时，请缩小文件或目录后重试',413));
        else if(code===0&&!failed&&reply?.value)resolve(reply.value);
        else reject(new HostingError(reply?.error??'文件处理未完成，请重试',reply?.status??503));
      });
    });}finally{this.workers.delete(worker);}
  }
  private root(...parts:string[]){return path.join(this.options.root,...parts);}
  private async lock<T>(work:()=>Promise<T>):Promise<T>{
    if(this.closed)throw new HostingError('页面托管暂不可用',503);
    const next=this.tail.then(()=>{if(this.closed)throw new HostingError('页面托管暂不可用',503);return work();});this.tail=next.catch(()=>undefined);return next;
  }
  async initialize(){return this.initialized??=this.lock(async()=>{
    await this.options.assertExclusiveWriter();
    for(const parts of [[],['staging'],['sites']]){
      const target=this.root(...parts);await fs.mkdir(target,{recursive:true});
      const stat=await fs.lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('HOSTING_INVALID_ROOT');
    }
    await this.recover();await this.prune();
  });}
  async list(principal:Principal){await this.initialize();return this.options.port.readHostedSites({principal});}
  private async prune(){
    if(!await exists(this.root('staging')))return;
    await this.options.assertExclusiveWriter();
    for(const item of await fs.readdir(this.root('staging'),{withFileTypes:true})){
      if(!uuid.safeParse(item.name).success||!item.isDirectory()||item.isSymbolicLink())continue;
      const target=this.root('staging',item.name);
      if((await fs.stat(target)).mtimeMs<Date.now()-STAGE_TTL)await fs.rm(target,{recursive:true,force:true});
    }
  }
  private async recover(){
    await this.options.assertExclusiveWriter();
    const sites=await this.options.port.readHostedSites({principal:{kind:'system',purpose:'recovery'}});
    for(const item of await fs.readdir(this.root('staging'),{withFileTypes:true})){
      if(!/^swap-[0-9a-f-]{36}$/.test(item.name)||!item.isDirectory()||item.isSymbolicLink())continue;
      const folder=this.root('staging',item.name);
      if(!await exists(path.join(folder,'journal.json'))){
        // The final journal is renamed into place before any content is moved.
        if(await exists(path.join(folder,'previous')))throw Error('HOSTING_JOURNAL_MISSING');
        await fs.rm(folder,{recursive:true,force:true});continue;
      }
      const journal=journalSchema.parse(JSON.parse(await fs.readFile(path.join(folder,'journal.json'),'utf8')));
      const id=(journal.next??journal.old)!.id;if(item.name!==`swap-${id}`)throw Error('HOSTING_INVALID_JOURNAL');
      const current=sites.find(site=>site.id===id),committed=journal.next?current?.contentToken===journal.next.contentToken:!current;
      const target=this.root('sites',id),backup=path.join(folder,'previous');
      if(!committed){
        if(await exists(backup)){
          if(await exists(target)){
            if(journal.uploadId&&!await exists(this.root('staging',journal.uploadId,'content')))await fs.rename(target,this.root('staging',journal.uploadId,'content'));
            else await fs.rm(target,{recursive:true,force:true});
          }
          await fs.rename(backup,target);
        }else if(!journal.old&&await exists(target)){
          if(journal.uploadId&&!await exists(this.root('staging',journal.uploadId,'content')))await fs.rename(target,this.root('staging',journal.uploadId,'content'));
          else await fs.rm(target,{recursive:true,force:true});
        }
      }
      await fs.rm(folder,{recursive:true,force:true});
    }
    // Never silently publish an orphan directory after an interrupted first publication.
  }
  upload(principal:Principal,filename:string,body:ReadableStream<Uint8Array>,length:number){return this.prepare(principal,{source:{kind:'upload',filename},body,length});}
  async importLocal(principal:Principal,source:string){
    await this.initialize();await this.options.port.readHostedSites({principal});
    if(!path.isAbsolute(source)||/^[\\/]{2}/.test(source))throw new HostingError('请选择服务器本地磁盘上的绝对路径');
    const real=await fs.realpath(source),stat=await fs.lstat(source);
    if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw new HostingError('不能导入链接或特殊文件');
    const hostingRoot=await fs.realpath(this.options.root);
    if(real===hostingRoot||real.startsWith(hostingRoot+path.sep)||hostingRoot.startsWith(real+path.sep))throw new HostingError('请选择独立的静态页面目录，不能导入托管数据目录或其上层');
    const origin:HostingSource={kind:'local',path:real};
    if(stat.isDirectory())return this.prepare(principal,{source:origin,body:null,length:0});
    if(stat.size>HOSTING_UPLOAD_BYTES)throw new HostingError('单文件不能超过 32 MB',413);
    const sourceStream=createReadStream(real);
    try{return await this.prepare(principal,{source:origin,body:Readable.toWeb(sourceStream) as ReadableStream<Uint8Array>,length:stat.size});}
    finally{sourceStream.destroy();}
  }
  private prepare(principal:Principal,input:HostingInput){
    const work=this.prepareInner(principal,input);this.imports.add(work);
    void work.finally(()=>this.imports.delete(work)).catch(()=>undefined);return work;
  }
  private async prepareInner(principal:Principal,{source,body,length}:HostingInput):Promise<HostingInspection>{
    await this.initialize();await this.options.port.readHostedSites({principal});
    if(this.activeUploads>=1)throw new HostingError('另一个文件正在处理，请稍后重试',409);
    if(length>HOSTING_UPLOAD_BYTES)throw new HostingError('上传文件不能超过 32 MB',413);
    const filename=source.kind==='upload'?source.filename:path.basename(source.path);
    const localDirectory=source.kind==='local'&&body===null?source.path:undefined;
    if(!localDirectory&&!/\.(html?|zip)$/i.test(filename))throw new HostingError('请选择 HTML 文件或 ZIP 压缩包');
    if(!HostingSourceSchema.safeParse(source).success)throw new HostingError('来源路径或文件名太长');
    this.activeUploads++;
    const uploadId=randomUUID(),folder=this.root('staging',uploadId),content=path.join(folder,'content');
    try{
      await this.lock(async()=>{
        await this.options.assertExclusiveWriter();await this.prune();
        if((await fs.readdir(this.root('staging'))).filter(name=>uuid.safeParse(name).success).length>=4)throw new HostingError('待发布文件过多，请先发布或取消已有上传',409);
        await fs.mkdir(content,{recursive:true});
      });
      const archive=path.join(folder,'upload.bin');let received=0;
      if(!localDirectory){
        await pipeline(Readable.fromWeb(body as any),new Transform({transform(chunk,_encoding,callback){received+=chunk.length;callback(received>HOSTING_UPLOAD_BYTES?new HostingError('上传文件不能超过 32 MB',413):null,chunk);}}),createWriteStream(archive,{flags:'wx'}),{signal:AbortSignal.any([this.closing.signal,AbortSignal.timeout(180_000)])});
        if(!received)throw new HostingError('上传文件为空');
      }
      const result=await this.inspect({filename,archive,content,folder,received,localDirectory});
      const inspection:HostingInspection={uploadId,previewToken:randomBytes(32).toString('hex'),expiresAt:Date.now()+STAGE_TTL,...result};
      await this.options.port.readHostedSites({principal});await this.options.assertExclusiveWriter();
      await fs.writeFile(path.join(folder,'meta.json'),JSON.stringify({owner:principal.userId,source,inspection}),{flush:true});
      await fs.rm(archive,{force:true});return inspection;
    }catch(error){await fs.rm(folder,{recursive:true,force:true}).catch(()=>undefined);throw error;}
    finally{this.activeUploads--;}
  }
  private async stage(uploadId:string){
    if(!uuid.safeParse(uploadId).success)throw new HostingError('上传不存在',404);
    try{
      const marker=markerSchema.parse(JSON.parse(await fs.readFile(this.root('staging',uploadId,'meta.json'),'utf8')));
      if(marker.inspection.expiresAt<Date.now())throw new HostingError('上传已过期，请重新上传',404);return marker;
    }catch(error){if(error instanceof HostingError)throw error;if(missing(error))throw new HostingError('上传不存在或已发布',404);throw error;}
  }
  async cancel(principal:Principal,uploadId:string){await this.initialize();return this.lock(async()=>{
    await this.options.port.readHostedSites({principal});const stage=await this.stage(uploadId);
    if(stage.owner!==principal.userId)throw new HostingError('上传不存在',404);
    await this.options.assertExclusiveWriter();await fs.rm(this.root('staging',uploadId),{recursive:true,force:true});
  });}
  private async command(principal:Principal,name:'hosting.save'|'hosting.delete',input:any){
    const result=await executeStoredCommand(this.options.port,{protocolVersion:1,storeId:this.options.storeId,workerGeneration:this.options.generation,requestId:randomUUID(),operationId:randomUUID(),principal,command:{name,input}});
    if(result.state==='unknown')throw new HostingError('操作结果待确认，请刷新列表后重试',503);
    if(result.state==='rejected')throw new StorageContractError(result.code);
  }
  async publish(principal:Principal,input:{uploadId:string;name:string;entry:string;siteId?:string;expectedToken?:string}){
    await this.initialize();return this.lock(async()=>{
      const sites=await this.options.port.readHostedSites({principal}),old=input.siteId?sites.find(site=>site.id===input.siteId):undefined;
      if(input.siteId&&(!old||old.contentToken!==input.expectedToken))throw new HostingError('站点已变化，请刷新列表后重试',409);
      const stage=await this.stage(input.uploadId);if(stage.owner!==principal.userId)throw new HostingError('上传不存在',404);
      if(!stage.inspection.entries.includes(input.entry))throw new HostingError('请选择有效的 HTML 首页');
      if(sites.reduce((sum,site)=>sum+site.totalBytes,0)-(old?.totalBytes??0)+stage.inspection.totalBytes>1024*1024*1024)throw new HostingError('托管内容总量不能超过 1 GB',413);
      const now=Date.now(),site=HostedSiteSchema.parse({id:old?.id??randomUUID(),publicId:old?.publicId??createHostingPublicId(sites),name:input.name,entry:input.entry,enabled:old?.enabled??true,fileCount:stage.inspection.fileCount,totalBytes:stage.inspection.totalBytes,contentToken:randomUUID(),createdAt:old?.createdAt??now,updatedAt:now,...(stage.source?{source:stage.source}:{})});
      await this.swap(principal,old??null,site,input.uploadId);
      await fs.rm(this.root('staging',input.uploadId),{recursive:true,force:true}).catch(()=>undefined);return site;
    });
  }
  private async swap(principal:Principal,old:HostedSite|null,next:HostedSite|null,uploadId:string|null){
    await this.options.assertExclusiveWriter();
    const id=(next??old)!.id,folder=this.root('staging',`swap-${id}`),target=this.root('sites',id);
    // Any unresolved journal is recovered before another change to the same site.
    if(await exists(folder))await this.recover();
    await fs.mkdir(folder);
    try{
      await fs.writeFile(path.join(folder,'journal.tmp'),JSON.stringify({old,next,uploadId}),{flush:true});
      await fs.rename(path.join(folder,'journal.tmp'),path.join(folder,'journal.json'));
    }catch(error){await fs.rm(folder,{recursive:true,force:true}).catch(()=>undefined);throw error;}
    try{
      if(old)await fs.rename(target,path.join(folder,'previous'));
      if(next)await fs.rename(this.root('staging',uploadId!,'content'),target);
      await this.options.assertExclusiveWriter();
      if(next)await this.command(principal,'hosting.save',{site:next,expectedToken:old?.contentToken??null});
      else await this.command(principal,'hosting.delete',{id,expectedToken:old!.contentToken});
    }catch(error){await this.recover();throw error;}
    // Cleanup is retryable; a cleanup failure must not report a committed publication as failed.
    await fs.rm(folder,{recursive:true,force:true}).catch(()=>undefined);
  }
  async patch(principal:Principal,id:string,expectedToken:string,patch:{name?:string;enabled?:boolean}){
    await this.initialize();return this.lock(async()=>{
      await this.recover();
      const old=(await this.options.port.readHostedSites({principal})).find(site=>site.id===id);
      if(!old||old.contentToken!==expectedToken)throw new HostingError('站点已变化，请刷新列表后重试',409);
      const site=HostedSiteSchema.parse({...old,...patch,contentToken:randomUUID(),updatedAt:Date.now()});
      await this.options.assertExclusiveWriter();await this.command(principal,'hosting.save',{site,expectedToken});return site;
    });
  }
  async remove(principal:Principal,id:string,expectedToken:string){
    await this.initialize();return this.lock(async()=>{
      const old=(await this.options.port.readHostedSites({principal})).find(site=>site.id===id);
      if(!old||old.contentToken!==expectedToken)throw new HostingError('站点已变化，请刷新列表后重试',409);
      await this.swap(principal,old,null,null);
    });
  }
  async read(id:string,requested:string,previewToken?:string):Promise<{bytes:Buffer;filename:string;entry:string}|null>{
    const file=await this.open(id,requested,previewToken);if(!file)return null;
    return {bytes:Buffer.from(await new Response(file.stream).arrayBuffer()),filename:file.filename,entry:file.entry};
  }
  async open(id:string,requested:string,previewToken?:string):Promise<{stream:ReadableStream<Uint8Array>;size:number;filename:string;entry:string;siteId:string}|null>{
    await this.initialize();if(!(previewToken?uuid.safeParse(id).success:uuid.safeParse(id).success||HostingPublicIdSchema.safeParse(id).success))return null;
    if(this.reads>=32)throw new HostingError('访问繁忙，请稍后重试',503);this.reads++;let transferred=false;
    try{return await this.lock(async()=>{
      let base:string,entry:string,siteId=id;
      if(previewToken){const stage=await this.stage(id);if(stage.inspection.previewToken!==previewToken)return null;base=this.root('staging',id,'content');entry=stage.inspection.suggestedEntry??stage.inspection.entries[0];}
      else{const site=(await this.options.port.readHostedSites({siteId:id}))[0];if(!site)return null;siteId=site.id;base=this.root('sites',site.id);entry=site.entry;}
      let name=requested||entry;
      if(name.endsWith('/'))name+='index.html';
      try{safePackagePath(name);}catch{return null;}
      let filename=path.join(base,...name.split('/'));
      try{
        const baseStat=await fs.lstat(base);if(baseStat.isSymbolicLink()||!baseStat.isDirectory())return null;
        let cursor=base;for(const part of name.split('/')){cursor=path.join(cursor,part);const stat=await fs.lstat(cursor);if(stat.isSymbolicLink())return null;}
        if((await fs.stat(filename)).isDirectory()){
          name=name.replace(/\/$/,'')+'/index.html';filename=path.join(base,...name.split('/'));
          if((await fs.lstat(filename)).isSymbolicLink())return null;
        }
        const stat=await fs.stat(filename);if(!stat.isFile()||stat.size>HOSTING_UPLOAD_BYTES)return null;
        const real=await fs.realpath(filename),realBase=await fs.realpath(base);if(!real.startsWith(realBase+path.sep))return null;
        const handle=await fs.open(filename,'r');
        if(this.closed){await handle.close();throw new HostingError('页面托管暂不可用',503);}
        const stream=handle.createReadStream();this.readStreams.add(stream);
        stream.once('close',()=>{this.readStreams.delete(stream);this.reads--;});
        const web=Readable.toWeb(stream,{strategy:{highWaterMark:64*1024,size:(chunk:Uint8Array)=>chunk.byteLength}}) as ReadableStream<Uint8Array>;
        transferred=true;return {stream:web,size:stat.size,filename:name,entry,siteId};
      }catch(error){if(missing(error))return null;throw error;}
    });}finally{if(!transferred)this.reads--;}
  }
}
