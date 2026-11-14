import { createDefaultEngineSystem } from './engine/create-system.js';
import { createEngineStatusService,type EngineStatusServiceOptions } from './system/engine-status.js';
import { createSystemResourceStatusService } from './system/resource-status.js';
import { codexVersionService } from './system/codex-version.js';
import { codeBuddyVersionService } from './system/codebuddy-version.js';
import { CodexMaintenanceAdapter } from './system/codex-maintenance.js';
import { CodeBuddyMaintenanceAdapter } from './system/codebuddy-maintenance.js';
import { OpenCodeMaintenanceAdapter } from './system/opencode-maintenance.js';
import { ZcodeMaintenanceAdapter } from './system/zcode-maintenance.js';
import { codeBuddyProcessManager } from './codebuddy/process-manager.js';
import { openCodeProcessManager } from './opencode/process-manager.js';
import { inspectOpenCodeInstallation } from './opencode/installation.js';
import { readNpmGlobalInstalledAt } from './system/npm-install-time.js';
import { listCodexModels } from './codex/model-catalog.js';
import type { EngineId } from './contracts/index.js';

/** Real provider adapters without the legacy default-system singleton or startup side effects. */
export function createStoredProductionEngines(options:{root:string;withCodexReady:<T>(work:()=>Promise<T>)=>Promise<T>;
  statusOptions?:EngineStatusServiceOptions;codexModelReader?:typeof listCodexModels;
}){
  const status=createEngineStatusService({...options.statusOptions,root:options.root});
  const engines=createDefaultEngineSystem({codex:{inspectLocalHealth:()=>status.inspectCodexLocalHealth(),
    listModels:()=>options.withCodexReady(()=> (options.codexModelReader??listCodexModels)())},
    codebuddy:{getAvailability:()=>status.getCodeBuddyAvailability(),inspectLocalHealth:()=>status.inspectCodeBuddyLocalHealth()},
    opencode:{getAvailability:()=>status.getOpenCodeAvailability(),inspectLocalHealth:()=>status.inspectOpenCodeLocalHealth()},
    zcode:{getAvailability:()=>status.getZcodeAvailability(),inspectLocalHealth:()=>status.inspectZcodeLocalHealth()}});
  const unsubscribe=status.subscribeAvailabilityChanges(engine=>engines.modelCatalog.invalidate(engine));
  let runningCodexVersion=process.env.RELAY_CODEX_RUNNING_VERSION??null;
  const readiness=async(id:'codex'|'codebuddy')=>{
    const engine=(await status.getSnapshot()).engines.find(value=>value.id===id);
    return{readiness:engine?.available?'ready' as const:engine?.availabilityStage==='readiness_stale'?'stale' as const:'failed' as const,
      checkedAt:engine?.available?Date.now():null,availabilityStage:engine?.availabilityStage,message:engine?.message};
  };
  const adapters=[
    new CodexMaintenanceAdapter({getVersionSnapshot:codexVersionService.getReadySnapshot,checkLatestVersion:codexVersionService.checkLatest,
      readRunningVersion:async()=> (await status.getSnapshot()).engines.find(engine=>engine.id==='codex')?.processReady?runningCodexVersion:null,
      readActiveTaskCount:()=>0,readInstallSource:()=>status.getInstallSource('codex'),readInstalledAt:()=>readNpmGlobalInstalledAt('@openai/codex'),readReadiness:()=>readiness('codex')}),
    new CodeBuddyMaintenanceAdapter({getVersionSnapshot:codeBuddyVersionService.getSnapshot,checkLatestVersion:codeBuddyVersionService.checkLatest,
      readInstallSource:()=>status.getInstallSource('codebuddy'),readInstalledAt:()=>readNpmGlobalInstalledAt('@tencent-ai/codebuddy-code'),
      readInstanceSummary:()=>codeBuddyProcessManager.getInstanceSummary(),readReadiness:()=>readiness('codebuddy')}),
    new OpenCodeMaintenanceAdapter({getStatus:async()=>{
      const engine=(await status.getSnapshot()).engines.find(value=>value.id==='opencode'),installation=inspectOpenCodeInstallation();
      return{cliInstalled:engine?.cliInstalled===true,installedVersion:installation.version??engine?.version??null,installSource:installation.installSource,
        installedAt:readNpmGlobalInstalledAt('opencode-ai'),readiness:engine?.available?'ready':'unknown',readinessCheckedAt:engine?.available?Date.now():null,availabilityStage:engine?.availabilityStage};
    },fetchLatestVersion:async()=>{
      const response=await fetch('https://registry.npmjs.org/opencode-ai',{headers:{Accept:'application/json','User-Agent':'daiwoniu-relay'},signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error('OPENCODE_REGISTRY_UNAVAILABLE');
      const payload=await response.json() as{'dist-tags'?:{latest?:string};time?:Record<string,string>},version=payload['dist-tags']?.latest;
      if(typeof version!=='string')throw new Error('OPENCODE_REGISTRY_INVALID');
      const publishedAt=Date.parse(payload.time?.[version]??'');return{version,publishedAt:Number.isFinite(publishedAt)?publishedAt:null};
    },readActiveInstanceCount:()=>openCodeProcessManager.size}),
    new ZcodeMaintenanceAdapter({})
  ];
  const availability=async(engineId:EngineId)=>{const engine=(await status.getSnapshot()).engines.find(value=>value.id===engineId);return{available:engine?.available===true,message:engine?.message};};
  return{...engines,status,version:codexVersionService,resources:createSystemResourceStatusService(),maintenanceAdapters:adapters,
    models:{getAvailability:availability,getCatalog:(engineId:EngineId,settings:{refresh:boolean})=>engines.modelCatalog.get(engineId,settings)},
    onTerminal:({engineId}:{engineId:EngineId})=>{
      engines.modelCatalog.invalidate(engineId);
      if(engineId==='codex'){codexVersionService.refreshCurrentVersion();runningCodexVersion=codexVersionService.getSnapshot().currentVersion;}
      if(engineId==='codebuddy')codeBuddyVersionService.refreshInstalled();
    },close:()=>{unsubscribe();}};
}
