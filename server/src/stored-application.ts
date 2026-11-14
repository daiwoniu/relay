import type { WebSocketServer } from 'ws';
import { StoredApplicationHost,type StoredApplicationHostOptions,type StoredApplicationScope } from './stored-application-host.js';
import { createStoredDomainServices,type StoredDomainDependencies } from './stored-domain-services.js';
import { createStoredRuntimePreparation } from './ws/stored-runtime-preparation.js';
import { buildStoredTurnModelSnapshot } from './engine/models/stored-turn-snapshot.js';
import { setupStoredWebSocket } from './ws/stored-frontend.js';
import { StorageContractError } from './storage/command-boundary.js';

export interface StoredApplicationOptions{
  storage:StoredApplicationHostOptions['storage'];
  storageOwner?:StoredApplicationHostOptions['storageOwner'];
  runtime:Omit<StoredApplicationHostOptions['graph'],'prepareInput'|'prepareRuntime'|'capacityChanged'>;
  dependencies:(scope:StoredApplicationScope)=>Promise<StoredDomainDependencies>;
  afterRuntimeSuspend?:()=>Promise<void>;
}
/** Complete core composition boundary; no listener, migration, provider call or activation happens implicitly. */
export async function createStoredApplication(options:StoredApplicationOptions){
  let services:ReturnType<typeof createStoredDomainServices>|undefined,dependencies:StoredDomainDependencies|undefined,scope:StoredApplicationScope|undefined;
  const requireServices=()=>{if(!services)throw new StorageContractError('NOT_SUBMITTED');return services;};
  const host=await StoredApplicationHost.open({storage:options.storage,storageOwner:options.storageOwner,afterRuntimeSuspend:options.afterRuntimeSuspend,graph:{...options.runtime,
    prepareInput:(...args)=>requireServices().attachments.prepareEngineInput(...args),
    prepareRuntime:createStoredRuntimePreparation(async(engine,preferences)=>{
      if(!dependencies)throw new StorageContractError('NOT_SUBMITTED');
      await dependencies.assertAdmission(engine);return buildStoredTurnModelSnapshot(engine,preferences,await dependencies.resources.getCatalog(engine));
    }),capacityChanged:key=>requireServices().publishCapacity(key)},build:async context=>{
      scope=context;dependencies=await options.dependencies(context);
      if(dependencies.registry!==options.runtime.registry)throw new StorageContractError('CONFLICT');
      services=createStoredDomainServices(context,dependencies);return services;
    }});
  let frontend=false;
  return{host,app:host.app,services:requireServices(),activate:()=>host.activate(),close:()=>host.close(),
    attachFrontend:(wss:WebSocketServer)=>{
      if(frontend||!['prepared','ready'].includes(host.status)||!scope)throw new StorageContractError('CONFLICT');frontend=true;
      return scope.own(setupStoredWebSocket(wss,{port:host.port,graph:host.graph,commands:requireServices().commands,ready:scope.ready}),value=>value.close());
    }};
}
