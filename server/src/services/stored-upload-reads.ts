import { z } from 'zod';
import { ProjectUploadsResponseDtoSchema } from '../contracts/index.js';
import type { CoreStoragePort,StoragePrincipal,UploadReadScope } from '../storage/contracts.js';
import { canonicalJson,parseStoragePrincipal,StorageContractError } from '../storage/command-boundary.js';
import { readUploadSnapshot,UploadReadActivitySchema,type UploadReadActivity } from '../uploads/read-upload-snapshot.js';
type Principal=Extract<StoragePrincipal,{kind:'user'}>;

export function assertUploadScope(scope: UploadReadScope, projectId: string, userId: string, expected?: UploadReadScope) {
  if (scope.projectId !== projectId || scope.viewerUserId !== userId
    || expected && (scope.ownerUserId !== expected.ownerUserId || scope.projectPath !== expected.projectPath)) {
    throw new StorageContractError('CONFLICT');
  }
}

export class StoredUploadReads{
  private closed=false;private readonly pending=new Set<Promise<unknown>>();
  constructor(private readonly options:{port:CoreStoragePort;
    /** Must be the same path-scoped reservation owner used by uploads/fork/purge at composition. */
    activity:(scope:UploadReadScope)=>Promise<UploadReadActivity>;
    readFiles?:typeof readUploadSnapshot}){this.options=Object.freeze({...options});}
  get(raw:Principal,projectId:string){
    const principal=parseStoragePrincipal(raw);if(principal.kind!=='user')return Promise.reject(new StorageContractError('FORBIDDEN'));projectId=z.string().uuid().parse(projectId);
    return this.getInScope(()=>this.options.port.readUploadScope({principal,projectId}));
  }
  getInScope(readScope:()=>Promise<UploadReadScope>){
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));if(this.pending.size>=2)return Promise.reject(new StorageContractError('OVERLOADED'));
    const work=Promise.resolve().then(async()=>{
      const scope=await readScope(),activity=UploadReadActivitySchema.parse(await this.options.activity(scope));
      const value=await(this.options.readFiles??readUploadSnapshot)(scope,activity);
      const current=await readScope(),after=UploadReadActivitySchema.parse(await this.options.activity(current));
      const final=await readScope();
      if(this.closed||current.revision!==scope.revision||final.revision!==current.revision||canonicalJson(activity,16384)!==canonicalJson(after,16384))throw new StorageContractError('CONFLICT');
      return ProjectUploadsResponseDtoSchema.parse({...value,cleanupBlockedReason:scope.active?'项目存在运行中的会话，暂时无法清理上传文件':activity.reservations.length?'项目存在正在上传的文件，暂时无法清理':null});
    });this.pending.add(work);void work.finally(()=>this.pending.delete(work)).catch(()=>undefined);return work;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending]);}
}
