import type { EngineId } from '../contracts/index.js';
import type { EngineMaintenanceAdapter } from '../engine/maintenance.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { StoredMaintenanceGate } from './stored-maintenance-gate.js';
import { createStoredMaintenanceRegistry,readStoredWorkspaceRoots } from './stored-maintenance.js';
import { createProcessEngineMaintenanceService,type EngineMaintenanceService } from './engine-maintenance.js';
import { createProcessServiceRecovery,type SetupEnvironmentStatus } from './service-recovery.js';

/** One durable admission authority shared by service recovery and engine maintenance. */
export async function createStoredManagedMaintenance(options:{port:CoreStoragePort;storeId:string;generation:number;assertExclusiveWriter:()=>Promise<void>;
  adapters:readonly EngineMaintenanceAdapter[];processLike?:Pick<NodeJS.Process,'env'|'send'|'on'|'off'>;
  inspectEnvironment:()=>Promise<SetupEnvironmentStatus>|SetupEnvironmentStatus;
  onTerminal?:NonNullable<Parameters<typeof createProcessEngineMaintenanceService>[2]>['onTerminal'];
  released?:()=>Promise<void>;diagnostic?:(code:'NATIVE_MAINTENANCE_FENCE_UNRESOLVED')=>void;
}){
  const gate=new StoredMaintenanceGate(options),processLike=options.processLike??process;
  let closed=false;
  let current:{operationId:string;fenceId:string;engineId:EngineId|null;phase:'acquiring'|'held'|'unknown'|'releasing'}|null=null;
  const pending=new Set<Promise<unknown>>(),listeners:Array<[string,(...args:any[])=>void]>=[];
  const processBridge={env:processLike.env,send:processLike.send?((message:any,...args:any[])=>{
    if(closed){const callback=args.find(value=>typeof value==='function');callback?.(new Error('Native maintenance closed'));return false;}
    return(processLike.send as any).call(processLike,message,...args);
  }):undefined,on:(event:string,listener:(...args:any[])=>void)=>{listeners.push([event,listener]);processLike.on(event,listener);}} as Pick<NodeJS.Process,'env'|'send'|'on'>;
  const report=()=>{try{options.diagnostic?.('NATIVE_MAINTENANCE_FENCE_UNRESOLVED');}catch{}};
  const prepare=async(operationId:string,engineId:EngineId|null)=>{
    if(closed)throw new StorageContractError('NOT_SUBMITTED');if(current)throw new StorageContractError('CONFLICT');
    const reservation={operationId,fenceId:'managed:'+operationId,engineId,phase:'acquiring' as const};current=reservation;
    let result;
    try{result=await gate.acquire({fenceId:reservation.fenceId,engineId});}
    catch(error){current={...reservation,phase:'unknown'};report();throw error;}
    if(result.state==='committed'){current={...reservation,phase:'held'};return;}
    if(result.state==='rejected'){current=null;throw new StorageContractError(result.code);}
    current={...reservation,phase:'unknown'};report();throw new StorageContractError('STORAGE_UNAVAILABLE');
  };
  const settle=(operationId:string,safe:boolean)=>{
    if(!current||current.operationId!==operationId)return;
    if(!safe||current.phase==='unknown'){current={...current,phase:'unknown'};report();return;}
    if(current.phase!=='held')return;
    const reservation=current;current={...reservation,phase:'releasing'};
    const run=(async()=>{
      try{
        const result=await gate.release(reservation.fenceId);
        if(result.state!=='committed')throw new StorageContractError('STORAGE_UNAVAILABLE');
        if(current?.fenceId===reservation.fenceId)current=null;
        if(!closed)await options.released?.();
      }catch{if(current?.fenceId===reservation.fenceId)current={...reservation,phase:'unknown'};report();}
    })();pending.add(run);void run.finally(()=>pending.delete(run)).catch(()=>undefined);
  };
  try{
    const persisted=(await gate.read()).fence;
    if(persisted){current={operationId:'unreconciled',fenceId:persisted.fenceId,engineId:persisted.engineId,phase:'unknown'};report();}
  }catch(error){await gate.close();throw error;}
  const inherited=current;
  // A new ready backend is the completion evidence for an inherited service restart.
  // Unknown engine upgrades and reservations made by this process keep their fences.
  const completeServiceStartup=async()=>{
    if(closed)throw new StorageContractError('NOT_SUBMITTED');
    if(!inherited||current!==inherited||inherited.engineId!==null||!/^managed:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(inherited.fenceId))return;
    await options.assertExclusiveWriter();
    if(closed||current!==inherited)throw new StorageContractError('CONFLICT');
    const result=await gate.release(inherited.fenceId);
    if(result.state!=='committed'){report();throw new StorageContractError('STORAGE_UNAVAILABLE');}
    if(current===inherited)current=null;
    await options.released?.();
  };
  let maintenance:EngineMaintenanceService|undefined;
  const recovery=createProcessServiceRecovery({processLike:processBridge,inspectEnvironment:options.inspectEnvironment,
    countActiveTasks:async()=>{await options.assertExclusiveWriter();return(await gate.read()).activeTasks;},
    prepareOperation:async(operationId:string,target:string)=>{if(target!=='frontend')await prepare(operationId,null);},settleOperation:settle,
    isOtherOperationInProgress:()=>current!==null||maintenance?.isOperationInProgress()===true});
  const registry=createStoredMaintenanceRegistry(options.port,options.adapters);
  maintenance=createProcessEngineMaintenanceService(registry,processBridge,{inspectEnvironment:options.inspectEnvironment,
    getCodexWorkspaceRoots:()=>readStoredWorkspaceRoots(options.port),onTerminal:options.onTerminal,prepareOperation:prepare,settleOperation:settle,
    isOtherOperationInProgress:()=>current!==null||recovery.isOperationInProgress()});
  return{recovery,maintenance,registry,completeServiceStartup,
    busy:()=>current!==null||recovery.isOperationInProgress()||maintenance!.isOperationInProgress(),
    assertAdmission:async(engine:EngineId)=>{
      if(closed)throw new StorageContractError('NOT_SUBMITTED');
      if(recovery.getAdmissionBlock()||maintenance!.getEngineAdmissionBlock(engine)||current&&(current.engineId===null||current.engineId===engine))throw new StorageContractError('CONFLICT');
      await options.assertExclusiveWriter();
    },
    close:async()=>{closed=true;for(const[event,listener]of listeners.splice(0))processLike.off(event,listener);await Promise.allSettled([...pending]);await gate.close();}
  };
}
