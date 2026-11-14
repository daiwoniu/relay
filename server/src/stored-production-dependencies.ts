import fs from 'node:fs/promises';
import path from 'node:path';
import type { StoredApplicationScope } from './stored-application-host.js';
import type { StoredDomainDependencies } from './stored-domain-services.js';
import type { createStoredProductionEngines } from './stored-production-engines.js';
import { createStoredManagedMaintenance } from './system/stored-managed-maintenance.js';
import { inspectCurrentEnvironment } from './system/service-recovery.js';
import { StoredCodexLifecycle } from './system/stored-codex-lifecycle.js';
import { ensureCodexProcessReady } from './system/codex-process-readiness.js';
import { createCodexAccountReader,accountIdentity } from './system/codex-account-reader.js';
import { readCodexLocalAccountId } from './system/codex-local-account.js';
import { streamCodexLocalUsageEvents } from './system/codex-local-usage-stream.js';
import { ResponsibilityReportSource } from './workspace-console/responsibility-report-source.js';
import { readTaskRegistry } from './workspace-console/task-registry-reader.js';
import { readWorkspaceRuns } from './workspace-console/workspace-runs-reader.js';
import { readObservedTaskDurations } from './workspace-console/activity-duration.js';
import { FIXED_WORKSPACE_PATH } from './workspace-console/workspace-snapshot.js';
import { ensureProjectFilesAsync } from './default-workspace.js';
import { archiveCodexThreadGuarded,unarchiveCodexThreadGuarded,isCodexThreadArchivedFresh,listArchivedCodexThreadIdsFresh,forkCodexThreadGuarded } from './codex/thread-admin.js';
import { StorageContractError } from './storage/command-boundary.js';
import { getDebugInfo } from './codex/client.js';

export interface StoredProductionDependencyOptions{
  engines:ReturnType<typeof createStoredProductionEngines>;codexHome:string;personalWorkspacePath:string;
  themeRoot:string;repairSourceRoot:string;chinaDayCacheRoot:string;newsRoot:string;
  publicShares:StoredDomainDependencies['publicShares'];attachmentAvailability:StoredDomainDependencies['attachmentAvailability'];
  diagnostic:(code:string,count?:number)=>void;
  runtimeDiagnostic?:(code:string,detail:import('./storage/runtime-storage.js').RuntimeFailureDiagnostic)=>void;
}
/** Production dependency selection. All authoritative application data remains behind the Native port. */
export async function createStoredProductionDependencies(scope:StoredApplicationScope,options:StoredProductionDependencyOptions){
  const{engines}=options;
  scope.own(engines,value=>value.close());
  const managed=scope.own(await createStoredManagedMaintenance({...scope,adapters:engines.maintenanceAdapters,inspectEnvironment:inspectCurrentEnvironment,onTerminal:engines.onTerminal,
    diagnostic:code=>options.diagnostic(code),released:async()=>{
      for(const adapter of engines.registry.list()){
        const resource=adapter.concurrency?.resolveResource({sessionId:'default',projectId:'default'});if(resource)await scope.graph.scheduler.drain(resource.resourceKey);
      }
    }}),value=>value.close());
  const lifecycle=new StoredCodexLifecycle({port:scope.port,assertExclusiveWriter:scope.assertExclusiveWriter,
    send:message=>{process.send?.(message);},ensureReady:()=>ensureCodexProcessReady()});
  const withCodexReady=async<T>(work:()=>Promise<T>)=>{await lifecycle.ensureReady();try{return await work();}finally{lifecycle.releaseReady();}};
  const account=createCodexAccountReader({ensureReady:()=>lifecycle.ensureReady(),releaseReady:()=>lifecycle.releaseReady()});
  const responsibility=new ResponsibilityReportSource();
  const dependencies:StoredDomainDependencies={registry:engines.registry,themeRoot:options.themeRoot,repairSourceRoot:options.repairSourceRoot,
    chinaDayCacheRoot:options.chinaDayCacheRoot,newsRoot:options.newsRoot,codexLifecycle:lifecycle,
    auth:{workspacePath:options.personalWorkspacePath},publicShares:options.publicShares,codexDebugInfo:getDebugInfo,
    system:{version:engines.version,engines:engines.status,resources:engines.resources,models:engines.models,recovery:managed.recovery,maintenance:managed.maintenance},
    resources:{prepareProject:async requested=>{
      if(!path.isAbsolute(requested))throw new StorageContractError('INVALID_ARGUMENT');const resolved=await fs.realpath(requested);
      if(!(await fs.stat(resolved)).isDirectory())throw new StorageContractError('NOT_FOUND');return resolved;
    },initializeProjectFiles:async root=>{await ensureProjectFilesAsync(root,scope.assertExclusiveWriter);},
    getCatalog:(engine,options)=>engines.modelCatalog.get(engine,options),isEngineAvailable:async engine=> (await engines.models.getAvailability(engine)).available},
    snapshots:{responsibilityIdentity:()=>responsibility.readIdentity(),loadResponsibility:identity=>responsibility.loadFresh(identity),loadOfficial:()=>account.readSnapshot(true)},
    creditReset:{loadIdentity:async()=>{const{snapshot}=await account.readSnapshot(true);return snapshot.status==='ready'&&snapshot.authMode!=='apikey'?accountIdentity(snapshot):null;},
      consume:(input,context)=>account.consumeResetCredit(input,context)},
    usage:{resolveAccount:async()=>{
      const result=await account.readSnapshot(true),snapshot=result.snapshot;
      if(snapshot.status!=='ready'||snapshot.authMode==='apikey'||snapshot.authMode==='unknown'||!snapshot.email)return null;
      return{email:snapshot.email,accountId:await readCodexLocalAccountId(options.codexHome,snapshot.email)};
    },events:(since,until)=>streamCodexLocalUsageEvents(options.codexHome,since,until)},
    workspace:{registry:()=>readTaskRegistry(FIXED_WORKSPACE_PATH),listRuns:()=>readWorkspaceRuns(FIXED_WORKSPACE_PATH),activityDurations:(ids,now)=>readObservedTaskDurations(FIXED_WORKSPACE_PATH,ids,now)},
    threads:{isThreadArchived:thread=>withCodexReady(()=>isCodexThreadArchivedFresh(thread)),archiveThread:(thread,mayDispatch)=>withCodexReady(()=>archiveCodexThreadGuarded(thread,mayDispatch)),
      unarchiveThread:(thread,mayDispatch)=>withCodexReady(()=>unarchiveCodexThreadGuarded(thread,mayDispatch))},
    fetchArchivedThreadIds:()=>withCodexReady(async()=>[...await listArchivedCodexThreadIdsFresh()]),
    fork:(plan,mayDispatch)=>{
      if(plan.engine==='codex')return withCodexReady(()=>forkCodexThreadGuarded(plan.threadId,plan.anchorTurnId??undefined,mayDispatch));
      const adapter=engines.registry.get('zcode');if(!adapter.sessions)throw new StorageContractError('NOT_SUPPORTED');
      return adapter.sessions.forkSession(plan.threadId,plan.projectRoot,plan.turnIndex===null?{kind:'latest'}:{kind:'turn',turnIndex:plan.turnIndex},mayDispatch).then(value=>value.forkedSessionId);
    },assertAdmission:managed.assertAdmission,maintenanceBusy:managed.busy,attachmentAvailability:options.attachmentAvailability,diagnostic:options.diagnostic
  };
  return{dependencies,withCodexReady,managed,lifecycle};
}
