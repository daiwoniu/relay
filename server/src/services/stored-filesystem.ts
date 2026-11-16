import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileAccessGrants } from '../file-access.js';
import type { CoreStoragePort,StoragePrincipal } from '../storage/contracts.js';
import { parseStoragePrincipal,StorageContractError,canonicalJson } from '../storage/command-boundary.js';

type Principal=Extract<StoragePrincipal,{kind:'user'}>;
const reads=new Set(['/metadata','/git-diff','/read','/preview-pdf-source','/preview-spreadsheet-sheet','/preview-image-source']);
const gets=new Set([...reads,'/browse','/browse-files']),posts=new Set(['/directories','/authorize-file','/authorize-host-files','/revoke-file']);
type Proof={path:string;realPath:string;dev:number;ino:number;size:number;mtimeMs:number};
/** Bounded physical IO ownership: an HTTP timeout never releases a still-running file operation's slot. */
export class StoredFilesystem{
  private closed=false;private readonly active=new Set<Promise<unknown>>();
  constructor(private readonly options:{port:CoreStoragePort;grants:Pick<FileAccessGrants,'allows'|'grant'|'revoke'>;assertExclusiveWriter:()=>Promise<void>;timeoutMs?:number}){
    this.options=Object.freeze({...options});
    if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>300000))throw new StorageContractError('INVALID_ARGUMENT');
  }
  request(raw:Principal,url:string,method:string,body?:string){
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    if(this.active.size>=4)return Promise.reject(new StorageContractError('OVERLOADED'));
    let timedOut=false,timer:ReturnType<typeof setTimeout>;
    const work=this.run(raw,url,method,body,()=>!timedOut&&!this.closed).catch(error=>{
      // Native preflight/postflight IO must retain a missing-file outcome instead
      // of turning a stale path into a generic service outage. Never expose raw paths.
      if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code??''))throw new StorageContractError('NOT_FOUND');
      throw error;
    });this.active.add(work);
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new StorageContractError('STORAGE_UNAVAILABLE'));},this.options.timeoutMs??30000);timer.unref();});
    void work.finally(()=>{clearTimeout(timer);this.active.delete(work);}).catch(()=>undefined);
    return Promise.race([work,deadline]);
  }
  private async run(raw:Principal,rawUrl:string,method:string,body:string|undefined,current:()=>boolean){
    const parsed=parseStoragePrincipal(raw);if(parsed.kind!=='user')throw new StorageContractError('FORBIDDEN');const principal=parsed;
    const url=new URL(rawUrl,'http://native-files');
    if(rawUrl.length>65536||!rawUrl.startsWith('/')||url.origin!=='http://native-files'||!(method==='GET'?gets:method==='POST'?posts:new Set()).has(url.pathname)||Buffer.byteLength(body??'')>128*1024)throw new StorageContractError('INVALID_ARGUMENT');
    const access=async()=>{const value=await this.options.port.readFrontendAccess({principal,resource:null});if(!value?.allowed)throw new StorageContractError('FORBIDDEN');return value.user;};
    const roots=async()=>{const user=await access(),projects=await this.options.port.listProjects({principal,scope:user.role==='admin'?'all':'mine'});
      return projects.filter(project=>user.role==='admin'||project.owner?.id===principal.userId).map(project=>({id:project.id,path:project.path})).sort((a,b)=>a.id.localeCompare(b.id));};
    const user=await access(),beforeRoots=await roots();let proof:Proof|null=null,allowedPath:string|null=null;
    if(reads.has(url.pathname)){
      const supplied=url.searchParams.get('path');if(!supplied||!path.isAbsolute(supplied))throw new StorageContractError('INVALID_ARGUMENT');
      const realPath=await fs.realpath(supplied),stat=await fs.lstat(realPath);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new StorageContractError('CONFLICT');
      // Private recovery journals never become public previews, even with a host grant.
      for(const value of [supplied,realPath]){const parts=value.toLowerCase().split(/[\\/]/);if(parts.some((part,index)=>part==='.relay_upload'&&['.incoming','.promotions','.quarantine','.trash-quarantine','.cleanup'].includes(parts[index+1]??'')))throw new StorageContractError('FORBIDDEN');}
      proof={path:supplied,realPath,dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs};
      if(this.options.grants.allows(realPath,url.searchParams.get('accessToken')??undefined,principal.userId))allowedPath=realPath;
    }
    await this.options.assertExclusiveWriter();if(!current())throw new StorageContractError('NOT_SUBMITTED');
    const worker=new Worker(new URL('./filesystem-worker-bootstrap.mjs',import.meta.url),{workerData:{actor:{userId:principal.userId,role:user.role},roots:beforeRoots.map(root=>root.path),allowedPath,url:url.pathname+url.search,method,body,proof}});
    let result:any;
    try{result=await new Promise<any>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',()=>reject(new StorageContractError('STORAGE_UNAVAILABLE')));worker.once('exit',()=>reject(new StorageContractError('STORAGE_UNAVAILABLE')));});}
    finally{await worker.terminate();}
    if(!result?.ok||!(result.body instanceof ArrayBuffer)||result.body.byteLength>32*1024*1024)throw new StorageContractError('CONFLICT');
    await access();if(canonicalJson(await roots())!==canonicalJson(beforeRoots))throw new StorageContractError('CONFLICT');
    if(proof){const realPath=await fs.realpath(proof.path),stat=await fs.lstat(realPath);if(realPath!==proof.realPath||stat.dev!==proof.dev||stat.ino!==proof.ino||stat.size!==proof.size||stat.mtimeMs!==proof.mtimeMs||!stat.isFile()||stat.nlink!==1)throw new StorageContractError('CONFLICT');}
    if(allowedPath&&!this.options.grants.allows(allowedPath,url.searchParams.get('accessToken')??undefined,principal.userId))throw new StorageContractError('FORBIDDEN');
    if(!current())throw new StorageContractError('NOT_SUBMITTED');
    let output:BodyInit=new Uint8Array(result.body);
    if(result.grants?.length){
      if(result.grants.length>10||!['/authorize-file','/authorize-host-files'].includes(url.pathname)||result.status!==200)throw new StorageContractError('CONFLICT');
      const replacements=new Map<string,string>(),parsed=JSON.parse(Buffer.from(result.body).toString('utf8'));
      for(const grant of result.grants){const realPath=await fs.realpath(grant.path),stat=await fs.lstat(realPath);if(realPath!==grant.path||!stat.isFile()||stat.isSymbolicLink())throw new StorageContractError('CONFLICT');}
      await access();if(!current())throw new StorageContractError('NOT_SUBMITTED');
      for(const grant of result.grants)replacements.set(grant.token,this.options.grants.grant(grant.path,principal.userId));
      if(parsed.accessToken)parsed.accessToken=replacements.get(parsed.accessToken);
      for(const file of parsed.attachments??[])file.accessToken=replacements.get(file.accessToken);
      output=JSON.stringify(parsed);
    }
    if(result.revoked?.length){if(result.revoked.length!==1||url.pathname!=='/revoke-file')throw new StorageContractError('CONFLICT');this.options.grants.revoke(result.revoked[0],principal.userId);}
    return new Response(output,{status:result.status,headers:result.headers});
  }
  async close(){this.closed=true;await Promise.allSettled([...this.active]);}
}
