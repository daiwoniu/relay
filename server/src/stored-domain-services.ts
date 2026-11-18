import fs from 'node:fs/promises';
import path from 'node:path';
import { PageHosting } from './page-hosting/service.js';
import type { StoredApplicationScope } from './stored-application-host.js';
import type { StoredHttpApplicationOptions } from './stored-http-application.js';
import type { EngineRegistry } from './engine/registry.js';
import { FileAccessGrants } from './file-access.js';
import { ProjectFileActivities } from './uploads/project-file-activities.js';
import { UploadPromoter } from './uploads/upload-promoter.js';
import { ForkUploadCopier } from './uploads/fork-copy-worker.js';
import { RepairSourceReader } from './storage/repair-source-reader.js';
import { StoredMessageAttachments } from './services/stored-message-attachments.js';
import { StoredProjectUploads } from './services/stored-project-uploads.js';
import { StoredUploadReads } from './services/stored-upload-reads.js';
import { StoredDraftCleanup } from './services/stored-draft-cleanup.js';
import { StoredArchivedCleanup } from './services/stored-archived-cleanup.js';
import { StoredFileDownloads } from './services/stored-file-downloads.js';
import { StoredFilesystem } from './services/stored-filesystem.js';
import { StoredThemeAssets } from './services/stored-theme-assets.js';
import { StoredProviderSnapshots } from './services/stored-provider-snapshots.js';
import { StoredLocalUsage } from './system/stored-local-usage.js';
import { StoredCreditReset } from './services/stored-credit-reset.js';
import { StoredWorkspaceConsole } from './workspace-console/stored-workspace-console.js';
import { StoredUnarchiveService } from './services/stored-unarchive.js';
import { StoredSoftDelete } from './services/stored-soft-delete.js';
import { StoredTrash } from './services/stored-trash.js';
import { StoredPurge } from './services/stored-purge.js';
import { StoredShares } from './services/stored-shares.js';
import { StoredSessionForkService } from './services/stored-session-fork.js';
import { StoredArchiveSync } from './services/stored-archive-sync.js';
import { StoredMessageRepair } from './services/stored-message-repair.js';
import { StoredSend } from './services/stored-send.js';
import { StoredFrontendCommands } from './ws/stored-frontend-commands.js';
import { StoredStartupRecovery } from './services/stored-startup-recovery.js';
import { presentRuntimeSession } from './ws/frontend-runtime-policy.js';
import { EngineConcurrencyDtoSchema } from './contracts/index.js';
import { StorageContractError } from './storage/command-boundary.js';
import { ChinaDayPanelCache } from './services/china-day-panel-cache.js';
import { StoredNews } from './news/stored-news.js';
import type { NewsSource } from './news/sources/source-types.js';
type Configuration<T>=Omit<T,'port'|'storeId'|'generation'|'assertExclusiveWriter'>;
export interface StoredDomainDependencies{
  registry:EngineRegistry;themeRoot:string;repairSourceRoot:string;chinaDayCacheRoot:string;grants?:FileAccessGrants;
  newsRoot:string;newsSources?:NewsSource[];newsInitialize?:boolean;
  chinaDay?:Omit<StoredHttpApplicationOptions['chinaDay'],'cache'>;
  auth:StoredHttpApplicationOptions['auth'];system:StoredHttpApplicationOptions['system'];publicShares:StoredHttpApplicationOptions['publicShares'];
  resources:Pick<StoredHttpApplicationOptions['writes'],'prepareProject'|'initializeProjectFiles'|'getCatalog'|'isEngineAvailable'>;
  snapshots:Configuration<ConstructorParameters<typeof StoredProviderSnapshots>[0]>;
  usage:Configuration<ConstructorParameters<typeof StoredLocalUsage>[0]>;
  creditReset:Omit<Configuration<ConstructorParameters<typeof StoredCreditReset>[0]>,'invalidateOfficial'>;
  workspace:Configuration<ConstructorParameters<typeof StoredWorkspaceConsole>[0]>;
  threads:Pick<ConstructorParameters<typeof StoredSoftDelete>[0],'isThreadArchived'|'archiveThread'>&Pick<ConstructorParameters<typeof StoredUnarchiveService>[0],'unarchiveThread'>;
  fetchArchivedThreadIds:()=>Promise<readonly string[]>;
  fork:ConstructorParameters<typeof StoredSessionForkService>[0]['fork'];
  assertAdmission:ConstructorParameters<typeof StoredSend>[0]['assertAdmission'];
  attachmentAvailability:ConstructorParameters<typeof StoredSend>[0]['attachmentAvailability'];
  maintenanceBusy:()=>boolean;
  codexLifecycle?:{start:()=>Promise<void>;close:()=>Promise<void>};
  diagnostic:(code:'NATIVE_STARTUP_WORK_BLOCKED',count:number)=>void;
  codexDebugInfo?:()=>unknown;
}
/** One concrete Native service graph. Provider adapters are injected; no synchronous repository defaults are selected. */
export function createStoredDomainServices(scope:StoredApplicationScope,dependencies:StoredDomainDependencies){
  const {port,storeId,generation,graph,assertExclusiveWriter}=scope,base={port,storeId,generation,assertExclusiveWriter};
  const own=<T extends{close:()=>void|Promise<void>}>(resource:T)=>scope.own(resource,value=>value.close());
  if(dependencies.codexLifecycle)own(dependencies.codexLifecycle);
  const files=own(new ProjectFileActivities()),promoter=own(new UploadPromoter()),copier=scope.own(new ForkUploadCopier(),value=>value.dispose());
  const source=scope.own(new RepairSourceReader({root:dependencies.repairSourceRoot}),value=>value.dispose()),grants=dependencies.grants??new FileAccessGrants();
  const changed=async(kind:'project'|'session',id:string)=>{
    await graph.hub.broadcastResource({kind,id},port.readResourceEvent.bind(port),event=>event.type==='session_updated'?{...event,session:presentRuntimeSession(event.session,graph.runtimes.get(event.sessionId))}:event);
    if(kind==='session')await graph.refresh(id);
    // Deletion/revocation invalidates existing subscriptions from fresh Native authorization.
    for(const userId of new Set(graph.hub.clients().map(client=>client.userId)))await graph.hub.recheckUserAccess(userId);
  };
  const closeIdle=async(sessionId:string,threadId:string,mayClose:()=>Promise<boolean>)=>{
    await graph.connections.closeIdleExternal(sessionId,threadId,mayClose);
  };
  const attachments=own(new StoredMessageAttachments({port,files,promoter,grants,assertExclusiveWriter}));
  const uploads=own(new StoredProjectUploads({...base,files})),uploadReads=own(new StoredUploadReads({port,activity:scope=>files.snapshot(scope)}));
  const draftCleanup=own(new StoredDraftCleanup({...base,files})),archivedCleanup=own(new StoredArchivedCleanup({...base,files,changed:id=>changed('project',id)}));
  const downloads=own(new StoredFileDownloads({port,grants})),filesystem=own(new StoredFilesystem({port,grants,assertExclusiveWriter}));
  const theme=own(new StoredThemeAssets({...base,root:dependencies.themeRoot}));
  const hosting=own(new PageHosting({...base,root:path.join(path.dirname(dependencies.newsRoot),'page-hosting')}));
  const chinaDayCache=own(new ChinaDayPanelCache(dependencies.chinaDayCacheRoot,Date.now,{assertExclusiveWriter}));
  const news=own(new StoredNews({port,root:dependencies.newsRoot,writerProof:scope.writerProof,assertExclusiveWriter,sources:dependencies.newsSources,initialize:dependencies.newsInitialize}));
  const snapshots=own(new StoredProviderSnapshots({...dependencies.snapshots,...base})),localUsage=own(new StoredLocalUsage({...dependencies.usage,...base}));
  const creditReset=own(new StoredCreditReset({...dependencies.creditReset,...base,invalidateOfficial:()=>snapshots.invalidateOfficial()}));
  const workspace=own(new StoredWorkspaceConsole({...dependencies.workspace,...base,hasFeishuWorkItem:(actor,id)=>snapshots.hasResponsibilityWorkItem(actor,id)}));
  const archive=own(new StoredArchiveSync({...base,fetchArchivedThreadIds:async()=>{
    // The injected observer must return a fresh complete list, including an empty list only on real success.
    return dependencies.fetchArchivedThreadIds();
  },changed:id=>changed('session',id)}));
  const unarchive=own(new StoredUnarchiveService({...base,unarchiveThread:dependencies.threads.unarchiveThread,isThreadArchived:dependencies.threads.isThreadArchived,closeIdleConnection:closeIdle,changed:id=>{archive.invalidate();return changed('session',id);}}));
  const resourceChanged=async(value:{kind:'project'|'session';id:string})=>{archive.invalidate();await changed(value.kind,value.id);};
  const softDelete=own(new StoredSoftDelete({...base,...dependencies.threads,restoreThread:dependencies.threads.unarchiveThread,closeIdleConnection:closeIdle,changed:resourceChanged}));
  const purge=own(new StoredPurge({...base,changed:resourceChanged}));
  const trash=own(new StoredTrash({...base,verifyDirectory:async projectPath=>{const real=await fs.realpath(projectPath);if(!(await fs.stat(real)).isDirectory())throw new StorageContractError('NOT_FOUND');},unarchive,projectChanged:id=>changed('project',id),sessionChanged:id=>changed('session',id),sidebarChanged:async()=>{/* Resource events reconcile the sidebar; custom order remains per-account. */}}));
  const shares=new StoredShares(base);
  const fork=own(new StoredSessionForkService({...base,fork:dependencies.fork,copy:async(input,context)=>{
    const current=await port.readUploadScope({principal:context.principal,projectId:input.targetIdentity.projectId});
    if(current.projectPath!==input.projectPath)throw new StorageContractError('CONFLICT');
    return files.withMutation(current,async()=>{await assertExclusiveWriter();if(!await context.mayCopy())throw new StorageContractError('CONFLICT');const fresh=await port.readUploadScope({principal:context.principal,projectId:current.projectId});if(fresh.revision!==current.revision)throw new StorageContractError('CONFLICT');},()=>copier.copy(input,{settleOnTimeout:true}));
  },changed:async(sessionId,projectId)=>{await changed('project',projectId);await changed('session',sessionId);}}));
  const repair=new StoredMessageRepair({...base,loadSnapshots:values=>source.loadSnapshots(values),maintenanceBusy:dependencies.maintenanceBusy,changed:id=>changed('session',id)});
  const sender=own(new StoredSend({...base,graph,attachments,registry:dependencies.registry,getCatalog:dependencies.resources.getCatalog,assertAdmission:dependencies.assertAdmission,attachmentAvailability:dependencies.attachmentAvailability,
    workspaceTaskLink:async(actor,command)=>command.workspaceTaskId?workspace.prepareFirstSendLink(actor,command.workspaceTaskId,command.sessionId):undefined}));
  const commands=own(new StoredFrontendCommands({...base,graph,sender}));
  const resources=dependencies.registry.list().flatMap(adapter=>{const value=adapter.concurrency?.resolveResource({sessionId:'default',projectId:'default'});return value?[{resourceKey:value.resourceKey,engineId:adapter.id,label:value.label}]:[];});
  const publishCapacity=async(resourceKey:string)=>{
    const resource=resources.find(value=>value.resourceKey===resourceKey);if(!resource)return;
    await graph.hub.broadcastLoaded(async principal=>({type:'engine_concurrency_updated',concurrency:EngineConcurrencyDtoSchema.parse({...await port.readConcurrency({principal,resourceKey}),engineId:resource.engineId,label:resource.label})}));
    for(const client of graph.hub.clients())for(const sessionId of client.subscribedSessionIds)await graph.sync.subscribe(client,sessionId,client.activeSubscriptionSessionId===sessionId,false);
  };
  const startup=new StoredStartupRecovery({...base,graph,purge,softDelete,theme,uploads:archivedCleanup});
  const assertNotDeleting=()=>{/* Native commands enforce deletion fences transactionally. */};
  const http:Omit<StoredHttpApplicationOptions,'port'|'storeId'|'generation'|'graph'|'ready'>={auth:dependencies.auth,codexDebugInfo:dependencies.codexDebugInfo,reads:{refreshSessionArchiveState:()=>archive.refresh()},writes:{...dependencies.resources,assertNotDeleting,changed,softDelete},
    uploads:{service:uploads},uploadReads:{service:uploadReads},draftCleanup:{service:draftCleanup},archivedCleanup:{service:archivedCleanup},downloads:{service:downloads},filesystem:{service:filesystem},themeAssets:{service:theme},
    unarchive:{service:unarchive,assertNotDeleting},fork:{service:fork,assertNotDeleting},shares:{service:shares},publicShares:dependencies.publicShares,trash:{service:trash,purge},repair:{service:repair},workspace:{service:workspace,snapshots},accountResources:{snapshots,localUsage,creditReset},system:dependencies.system,
    hosting,news:{service:news},chinaDay:{...dependencies.chinaDay,cache:chinaDayCache},concurrency:{resources,changed:async key=>{await publishCapacity(key);void graph.scheduler.drain(key).catch(()=>undefined);}}};
  return{http,sender,commands,attachments,publishCapacity,recover:async()=>{await hosting.initialize();await news.initialize();await dependencies.codexLifecycle?.start();const result=await startup.recover();if(result.blockedCount)dependencies.diagnostic('NATIVE_STARTUP_WORK_BLOCKED',result.blockedCount);},resume:async()=>{await news.resume();await startup.resume();}};
}
