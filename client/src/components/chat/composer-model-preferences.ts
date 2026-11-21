import type { EngineId, PublicUserDto } from '../../generated/relay-contracts';
type Preferences={modelId:string|null;reasoningEffort:string|null;serviceTier?:string|null};

/** Saved sessions and explicit drafts win, including explicit null (follow engine). */
export function resolveComposerModelPreferences(engine:EngineId|null,user:PublicUserDto|null,authority?:Preferences,draft?:Preferences):Preferences {
  if(authority)return authority;
  if(draft)return draft;
  if(!user||engine!==user.defaultEngine)return{modelId:null,reasoningEffort:null,serviceTier:null};
  return{modelId:user.defaultModelId,reasoningEffort:user.defaultReasoningEffort??null,serviceTier:user.defaultServiceTier??null};
}
