import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredRuntimeGraph } from '../ws/stored-runtime-graph.js';
import type { StoredPurge } from './stored-purge.js';
import type { StoredSoftDelete } from './stored-soft-delete.js';
import type { StoredThemeAssets } from './stored-theme-assets.js';
import type { StoredArchivedCleanup } from './stored-archived-cleanup.js';
import { StorageContractError } from '../storage/command-boundary.js';
type Record=Awaited<ReturnType<CoreStoragePort['readStartupWorkPage']>>['records'][number];
const recovery={kind:'system',purpose:'recovery'} as const,maintenance={kind:'system',purpose:'maintenance'} as const;
/** Complete bounded enumeration. Unknown provider operations remain fenced and are never resent at startup. */
export class StoredStartupRecovery{
  constructor(private readonly options:{port:CoreStoragePort;graph:StoredRuntimeGraph;assertExclusiveWriter:()=>Promise<void>;
    purge:Pick<StoredPurge,'recover'>;softDelete:Pick<StoredSoftDelete,'recover'|'recoverCancellation'>;
    theme:Pick<StoredThemeAssets,'recover'>;uploads:Pick<StoredArchivedCleanup,'recover'>}){}
  private async each(phase:'files'|'dispatch',visit:(record:Record)=>Promise<void>){
    let after:string|null=null,count=0;
    do{
      await this.options.assertExclusiveWriter();const page=await this.options.port.readStartupWorkPage({principal:recovery,phase,after,limit:32});
      for(const record of page.records){await this.options.assertExclusiveWriter();await visit(record);count++;}
      if(page.next!==null&&(page.next===after||!page.records.length))throw new StorageContractError('STORAGE_UNAVAILABLE');after=page.next;
    }while(after!==null);return count;
  }
  async recover(){
    const {port}=this.options,blocked:Record[]=[];let blockedCount=0;
    const count=await this.each('files',async record=>{
      let settled=false;
      switch(record.kind){
        case'purge':await this.options.purge.recover(record.id);settled=!!(await port.readPurgeJob({principal:maintenance,jobId:record.id}))?.filesFinished;break;
        case'theme':await this.options.theme.recover(record.id);settled=!!(await port.readThemeAssetJob({principal:maintenance,jobId:record.id}))?.filesFinished;break;
        case'upload-cleanup':await this.options.uploads.recover(record.id);settled=!!(await port.readUploadCleanupJob({principal:maintenance,jobId:record.id}))?.filesFinished;break;
        case'soft-delete':case'soft-delete-cancel':{
          await(record.kind==='soft-delete'?this.options.softDelete.recover(record.id):this.options.softDelete.recoverCancellation(record.id));
          const job=await port.readSoftDeleteJob({principal:maintenance,jobId:record.id});settled=!!job&&['committed','abandoned'].includes(job.phase);break;
        }
        case'external':break; // A stored intent or dispatched marker is not proof of a provider result.
        default:throw new StorageContractError('CONFLICT');
      }
      if(!settled){blockedCount++;if(blocked.length<64)blocked.push(record);}
    });return{count,blockedCount,blocked,truncated:blockedCount>blocked.length};
  }
  async resume(){
    return this.each('dispatch',async record=>{
      if(record.kind==='followup')await this.options.graph.followups.recover(record.id);
      else if(record.kind==='queue')await this.options.graph.scheduler.drain(record.id);
      else throw new StorageContractError('CONFLICT');
    });
  }
}
