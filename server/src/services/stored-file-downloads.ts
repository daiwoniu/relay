import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CoreStoragePort,StoragePrincipal,UploadReadScope } from '../storage/contracts.js';
import { parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import type { FileAccessGrants } from '../file-access.js';

type Principal=Extract<StoragePrincipal,{kind:'user'}>;
const inputSchema=z.object({path:z.string().min(1).max(32768).refine(p=>path.isAbsolute(p)&&!p.includes('\0')),accessToken:z.string().uuid().optional()}).strict();
type Input=z.infer<typeof inputSchema>;
type Stat=Awaited<ReturnType<typeof fs.lstat>>;
const key=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
const same=(a:Stat,b:Stat)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
const inside=(root:string,target:string)=>{const relative=path.relative(root,target);return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const fail=()=>new StorageContractError('CONFLICT');

/** No full-file buffers or synchronous filesystem work. Accepted streams retain their handle until physical IO settles. */
export class StoredFileDownloads{
  private closed=false;private readonly preparing=new Set<Promise<unknown>>();private readonly streams=new Set<()=>Promise<void>>();
  constructor(private readonly options:{port:CoreStoragePort;grants:Pick<FileAccessGrants,'allows'>;timeoutMs?:number}){
    this.options=Object.freeze({...options});if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>300000))throw new StorageContractError('INVALID_ARGUMENT');
  }
  open(raw:Principal,rawInput:Input,signal?:AbortSignal){
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    if(this.preparing.size+this.streams.size>=4)return Promise.reject(new StorageContractError('OVERLOADED'));
    const parsed=parseStoragePrincipal(raw);if(parsed.kind!=='user')return Promise.reject(new StorageContractError('FORBIDDEN'));
    const input=inputSchema.parse(rawInput),principal=parsed;
    const work=this.prepare(principal,input,signal);this.preparing.add(work);void work.finally(()=>this.preparing.delete(work)).catch(()=>undefined);return work;
  }
  private async prepare(principal:Principal,input:Input,signal?:AbortSignal){
    const current=async()=>{if(this.closed||signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');const access=await this.options.port.readFrontendAccess({principal,resource:null});if(!access?.allowed)throw new StorageContractError('FORBIDDEN');if(this.closed||signal?.aborted)throw new StorageContractError('NOT_SUBMITTED');return access.user;};
    const user=await current();let target:string;
    try{target=await fs.realpath(input.path);}catch{throw new StorageContractError('NOT_FOUND');}
    // These are server-owned recovery records, not public project attachments.
    for(const location of [target,path.resolve(input.path)]){const parts=key(location).split(path.sep);if(parts.some((part,index)=>part==='.relay_upload'&&['.incoming','.promotions','.quarantine','.trash-quarantine','.cleanup'].includes(parts[index+1]??'')))throw new StorageContractError('FORBIDDEN');}
    let scope:UploadReadScope|null=null,root:string|null=null;
    const tokenAllowed=()=>this.options.grants.allows(target,input.accessToken,principal.userId);
    if(!tokenAllowed()){
      const projects=await this.options.port.listProjects({principal,scope:user.role==='admin'?'all':'mine'});
      for(const project of projects){
        if(user.role!=='admin'&&project.owner?.id!==principal.userId)continue;
        let resolved:string;try{resolved=await fs.realpath(project.path);}catch{continue;}
        if(!inside(resolved,target))continue;
        const candidate=await this.options.port.readUploadScope({principal,projectId:project.id});
        if(key(await fs.realpath(candidate.projectPath))!==key(resolved)||candidate.projectPath!==project.path)throw fail();scope=candidate;root=resolved;break;
      }
      if(!scope)throw new StorageContractError('FORBIDDEN');
    }
    const rootIdentity=root?await fs.lstat(root):null;
    const authorize=async()=>{
      await current();if(scope){const after=await this.options.port.readUploadScope({principal,projectId:scope.projectId});if(after.projectPath!==scope.projectPath||after.ownerUserId!==scope.ownerUserId||after.viewerUserId!==scope.viewerUserId||key(await fs.realpath(after.projectPath))!==key(root!))throw fail();}
      else if(!tokenAllowed())throw new StorageContractError('FORBIDDEN');
      if(rootIdentity){const after=await fs.lstat(root!);if(after.dev!==rootIdentity.dev||after.ino!==rootIdentity.ino||!after.isDirectory()||after.isSymbolicLink())throw fail();}
      if(key(await fs.realpath(input.path))!==key(target))throw fail();
    };
    await authorize();const before=await fs.lstat(target);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw fail();if(before.size>100*1024*1024)throw new StorageContractError('PAYLOAD_TOO_LARGE');
    const handle=await fs.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let transferred=false;
    try{
      if(!same(before,await handle.stat()))throw fail();await authorize();
      let offset=0,stopped=false,pulling:Promise<void>|null=null,closing:Promise<void>|null=null,controller:ReadableStreamDefaultController<Uint8Array>;
      const finish=()=>{if(!closing)closing=(async()=>{await pulling?.catch(()=>undefined);await handle.close();this.streams.delete(stop);clearTimeout(timer);signal?.removeEventListener('abort',onAbort);})();return closing;};
      const stop=async()=>{if(!stopped){stopped=true;controller.error(new StorageContractError('NOT_SUBMITTED'));}await finish();};
      const onAbort=()=>{void stop().catch(()=>undefined);};
      const timer=setTimeout(onAbort,this.options.timeoutMs??120000);timer.unref();
      const stream=new ReadableStream<Uint8Array>({
        start(value){controller=value;},
        pull:async()=>{
          const action=(async()=>{
            try{
              if(stopped)return;await authorize();if(stopped)return;
              const currentPath=await fs.lstat(target);if(!same(before,currentPath)||currentPath.isSymbolicLink()||currentPath.nlink!==1||!same(before,await handle.stat()))throw fail();
              const buffer=Buffer.alloc(Math.min(65536,Math.max(1,before.size-offset))),{bytesRead}=await handle.read(buffer,0,buffer.length,offset);
              if(stopped)return;offset+=bytesRead;
              if(offset>before.size||!same(before,await handle.stat())||!same(before,await fs.lstat(target)))throw fail();
              await authorize();if(stopped)return;
              if(!bytesRead){if(offset!==before.size)throw fail();stopped=true;controller.close();}
              else controller.enqueue(buffer.subarray(0,bytesRead));
            }catch(error){if(!stopped){stopped=true;controller.error(error instanceof StorageContractError?error:new StorageContractError('STORAGE_UNAVAILABLE'));}}
          })();pulling=action;await action;if(pulling===action)pulling=null;if(stopped)await finish();
        },
        cancel:async()=>{stopped=true;await finish();},
      },{highWaterMark:0});
      this.streams.add(stop);signal?.addEventListener('abort',onAbort,{once:true});transferred=true;if(this.closed||signal?.aborted)await stop();
      return{stream,size:before.size,name:path.basename(target)};
    }finally{if(!transferred)await handle.close();}
  }
  async close(){this.closed=true;await Promise.allSettled([...this.streams].map(stop=>stop()));await Promise.allSettled([...this.preparing]);await Promise.allSettled([...this.streams].map(stop=>stop()));}
}
