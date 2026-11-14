import fs from 'node:fs/promises';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { EngineMaintenanceAdapter } from '../engine/maintenance.js';
import { EngineMaintenanceRegistry } from '../engine/maintenance-registry.js';

/** Provider process counts cannot replace persisted queued/claimed/running task ownership. */
export function createStoredMaintenanceRegistry(port:CoreStoragePort,adapters:readonly EngineMaintenanceAdapter[]){
  const project=async(adapter:EngineMaintenanceAdapter,latest:boolean)=>{
    const status=await(latest?adapter.checkLatest():adapter.getStatus());
    const current=await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}});
    const activeTaskCount=Math.max(status.activeTaskCount,current.byEngine[adapter.id]);
    const actions=status.actions.map(action=>{
      if(activeTaskCount===0)return action;
      if(action.action==='restart')return{...action,interruptsActiveTasks:true};
      return{...action,enabled:false,reason:'存在活动任务，完成或停止后才能维护引擎'};
    });
    return{...status,activeTaskCount,actions,recommendedAction:actions.some(action=>action.action===status.recommendedAction&&action.enabled)?status.recommendedAction:null};
  };
  return new EngineMaintenanceRegistry(adapters.map(adapter=>({id:adapter.id,getStatus:()=>project(adapter,false),checkLatest:()=>project(adapter,true)})));
}

export async function readStoredWorkspaceRoots(port:CoreStoragePort){
  const current=await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}}),roots=new Set<string>();
  for(const root of current.projectRoots){
    try{const resolved=await fs.realpath(root);if((await fs.stat(resolved)).isDirectory())roots.add(resolved);}
    catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }
  return[...roots];
}
