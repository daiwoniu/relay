import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StorageContractError } from '../storage/command-boundary.js';
import { UploadReadActivitySchema,type UploadReadActivity } from './read-upload-snapshot.js';
import type { UploadReadScope } from '../storage/contracts.js';

type Reservation=UploadReadActivity['reservations'][number];
type RootState={nonce:string;version:number;pending:number;mutating:boolean;tail:Promise<void>;reservations:Map<string,Reservation>};
// All candidate instances share physical roots, including aliases and projects backed by the same directory.
const roots=new Map<string,RootState>();let uploads=0,mutations=0;
type RootIdentity={root:string;dev:number;ino:number};
async function identity(projectPath:string):Promise<RootIdentity>{
  const root=await fs.realpath(projectPath),stat=await fs.lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new StorageContractError('CONFLICT');return{root,dev:stat.dev,ino:stat.ino};
}
async function stable(projectPath:string,expected:RootIdentity){
  const value=await identity(projectPath);if(value.root!==expected.root||value.dev!==expected.dev||value.ino!==expected.ino)throw new StorageContractError('CONFLICT');
}
function state(root:string){
  let value=roots.get(root);if(value)return value;
  if(roots.size>=128){const idle=[...roots].find(([,item])=>!item.pending&&!item.reservations.size);if(!idle)throw new StorageContractError('OVERLOADED');roots.delete(idle[0]);}
  value={nonce:randomUUID(),version:0,pending:0,mutating:false,tail:Promise.resolve(),reservations:new Map()};roots.set(root,value);return value;
}
type Guard=()=>Promise<void>;
/** Process-local ownership only. T6 must additionally hold the cross-process writer lock and durable file intents. */
export class ProjectFileActivities{
  private closed=false;private readonly pending=new Set<Promise<unknown>>();private readonly abort=new AbortController();
  private track<T>(work:()=>Promise<T>){
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));if(this.pending.size>=16)return Promise.reject(new StorageContractError('OVERLOADED'));
    const result=Promise.resolve().then(()=>{if(this.closed)throw new StorageContractError('NOT_SUBMITTED');return work();});this.pending.add(result);void result.finally(()=>this.pending.delete(result)).catch(()=>undefined);return result;
  }
  async snapshot(scope:UploadReadScope):Promise<UploadReadActivity>{
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');const physical=await identity(scope.projectPath),value=state(physical.root);
    if(this.closed)throw new StorageContractError('NOT_SUBMITTED');if(value.mutating)throw new StorageContractError('CONFLICT');
    return{version:value.nonce+':'+value.version,reservations:[...value.reservations.values()].map(item=>({...item})).sort((a,b)=>a.uploadId.localeCompare(b.uploadId))};
  }
  private async mutate<T>(scope:UploadReadScope,physical:RootIdentity,value:RootState,guard:Guard,work:(signal:AbortSignal)=>Promise<T>,uploadKey?:string){
    if(value.pending>=16)throw new StorageContractError('OVERLOADED');value.pending++;
    let release!:()=>void;const prior=value.tail;value.tail=new Promise<void>(resolve=>{release=resolve;});
    let started=false;try{
      await prior;if(this.closed)throw new StorageContractError('NOT_SUBMITTED');
      if(value.reservations.size&&!uploadKey)throw new StorageContractError('CONFLICT');
      if(uploadKey&&!value.reservations.has(uploadKey))throw new StorageContractError('NOT_SUBMITTED');
      await guard();await stable(scope.projectPath,physical);if(this.closed)throw new StorageContractError('NOT_SUBMITTED');if(mutations>=2)throw new StorageContractError('OVERLOADED');
      value.mutating=true;value.version++;mutations++;started=true;
      // This promise must cover physical completion/Worker termination. An HTTP timeout must never release ownership.
      return await work(this.abort.signal);
    }finally{if(started){value.mutating=false;value.version++;mutations--;}value.pending--;release();}
  }
  withMutation<T>(scope:UploadReadScope,guard:Guard,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    scope=Object.freeze({...scope});
    return this.track(async()=>{await guard();const physical=await identity(scope.projectPath);return this.mutate(scope,physical,state(physical.root),guard,work);});
  }
  withUpload<T>(scope:UploadReadScope,reservation:Reservation,guard:Guard,work:(capability:{projectRoot:string;signal:AbortSignal;assertCurrent:()=>Promise<void>;publish:<U>(action:(signal:AbortSignal)=>Promise<U>)=>Promise<U>})=>Promise<T>):Promise<T>{
    scope=Object.freeze({...scope});
    const parsed=UploadReadActivitySchema.parse({version:'reservation',reservations:[reservation]}).reservations[0]!;
    return this.track(async()=>{
      await guard();const physical=await identity(scope.projectPath),value=state(physical.root),key=parsed.uploadId.toLowerCase();
      if(this.closed)throw new StorageContractError('NOT_SUBMITTED');if(uploads>=2)throw new StorageContractError('OVERLOADED');if(value.pending||value.reservations.has(key))throw new StorageContractError('CONFLICT');
      value.reservations.set(key,{...parsed});value.version++;uploads++;
      let active=true,failure:{error:unknown}|null=null;const publishing=new Set<Promise<unknown>>();
      const assertCurrent=async()=>{if(!active||this.closed)throw new StorageContractError('NOT_SUBMITTED');await guard();await stable(scope.projectPath,physical);if(!active||this.closed)throw new StorageContractError('NOT_SUBMITTED');};
      try{return await work({projectRoot:physical.root,signal:this.abort.signal,assertCurrent,publish:<U>(action:(signal:AbortSignal)=>Promise<U>)=>{
        if(!active)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
        const result=this.mutate(scope,physical,value,guard,action,key);publishing.add(result);void result.catch(error=>{failure={error};}).finally(()=>publishing.delete(result)).catch(()=>undefined);return result;
      }});}finally{
        active=false;await Promise.allSettled([...publishing]);value.reservations.delete(key);value.version++;uploads--;if(failure)throw(failure as {error:unknown}).error;
      }
    });
  }
  async close(){this.closed=true;this.abort.abort();await Promise.allSettled([...this.pending]);}
}
