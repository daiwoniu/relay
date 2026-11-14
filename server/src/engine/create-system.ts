import { CodexAdapter,type CodexAdapterOptions } from '../codex/adapter.js';
import { CodeBuddyAdapter,type CodeBuddyAdapterOptions } from '../codebuddy/adapter.js';
import { OpenCodeAdapter,type OpenCodeAdapterOptions } from '../opencode/adapter.js';
import { ZcodeAdapter,type ZcodeAdapterOptions } from '../zcode/adapter.js';
import { EngineRegistry } from './registry.js';
import { EngineModelCatalogService } from './models/catalog-service.js';

/** Explicit adapter construction. It selects no application repository and starts no provider or monitor. */
export function createDefaultEngineSystem(options:{codex?:CodexAdapterOptions;codebuddy?:CodeBuddyAdapterOptions;opencode?:OpenCodeAdapterOptions;zcode?:ZcodeAdapterOptions}={}){
  let modelCatalog:EngineModelCatalogService|undefined;
  const adapters=[new CodexAdapter(options.codex),new CodeBuddyAdapter({...options.codebuddy,onModelCatalog:catalog=>{modelCatalog?.prime('codebuddy',catalog);options.codebuddy?.onModelCatalog?.(catalog);}}),
    new OpenCodeAdapter({...options.opencode,onModelCatalog:catalog=>{modelCatalog?.prime('opencode',catalog);options.opencode?.onModelCatalog?.(catalog);}}),new ZcodeAdapter(options.zcode)] as const;
  const registry=new EngineRegistry(adapters);modelCatalog=new EngineModelCatalogService(registry);
  return{adapters,registry,modelCatalog};
}
