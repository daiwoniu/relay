import type { EngineEvent } from '../engine/adapter.js';
import type { SessionRuntime } from '../engine/runtime.js';
import type { EngineTerminalProjectionSnapshot } from '../services/engine-terminal-projection.js';
import type { MessageMetadata } from '../message-metadata.js';
import { removeNarrativeItem } from '../process-timeline.js';
import { VISIBLE_ITEM_TYPES } from './frontend-protocol.js';

export type TerminalFileChanges=Pick<MessageMetadata,'changedFiles'|'changedFilesIncomplete'>;

/** Shared by the actual legacy entry and its Native replacement; no database or filesystem access. */
export function buildRuntimeAssistantSnapshot(runtime:SessionRuntime,event:Extract<EngineEvent,{type:'message_complete'}>,options:{
  messageId:string;fileChanges:TerminalFileChanges;now:number;
}):EngineTerminalProjectionSnapshot{
  const items=runtime.turnItems.filter(item=>VISIBLE_ITEM_TYPES.has(item.type));
  return{
    messageId:options.messageId,turnId:event.turnId,content:event.content,
    items:items.length?JSON.stringify(items):null,duration:runtime.turnStartTime?options.now-runtime.turnStartTime:null,
    metadata:{
      processContent:event.processContent?.trim()||undefined,
      processTimeline:event.finalAnswerItemId?removeNarrativeItem(runtime.processTimeline,event.finalAnswerItemId):runtime.processTimeline,
      ...options.fileChanges,
      executionStage:'responding',tokenUsage:runtime.tokenUsage||undefined,
      ...(runtime.turnModelSnapshot?.modelInfo?{modelInfo:runtime.turnModelSnapshot.modelInfo}:{}),
    },
  };
}
