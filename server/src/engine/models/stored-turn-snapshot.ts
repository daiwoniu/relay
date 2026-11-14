import type { EngineModelCatalog } from './types.js';
import type { EngineId } from '../types.js';
import { validateEnginePreferences } from './preferences.js';
/** Pure Native preparation projection: the caller supplies its own freshly loaded catalog. */
export function buildStoredTurnModelSnapshot(engine:EngineId,preferences:{modelId:string|null;reasoningEffort:string|null;serviceTier?:string|null},catalog:EngineModelCatalog){
  validateEnginePreferences(catalog,preferences);
  const needsDefaults=engine==='codex'&&(preferences.modelId===null||preferences.reasoningEffort===null||preferences.serviceTier==null);
  if(needsDefaults&&(catalog.stale||catalog.configurationRead!==true))throw new Error('无法确认本轮默认配置，请稍后重试');
  const displayNames=Object.fromEntries(catalog.models.map(model=>[model.id,model.displayName]));
  if(engine!=='codex')return{displayNames,modelDefaults:{},defaultModelId:null};
  const modelDefaults:Record<string,{reasoningEffort?:string;serviceTier?:string|null}>=Object.fromEntries(catalog.models.map(model=>[model.id,{
    ...(model.reasoning.defaultOptionId?{reasoningEffort:model.reasoning.defaultOptionId}:{}),serviceTier:model.defaultServiceTier||(model.serviceTiers?.length?'default':null)}]));
  const configured=catalog.configuredDefaults;
  if(configured?.modelId&&!modelDefaults[configured.modelId])modelDefaults[configured.modelId]={...(configured.reasoningEffort?{reasoningEffort:configured.reasoningEffort}:{}),serviceTier:configured.serviceTier??null};
  const defaultModelId=configured?.modelId??catalog.models.find(model=>model.isDefault)?.id??null;
  if(preferences.modelId===null&&!defaultModelId)throw new Error('无法确认本轮默认模型，请稍后重试');
  return{displayNames,modelDefaults,defaultModelId};
}
