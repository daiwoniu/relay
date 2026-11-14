import type { SessionRuntime } from '../engine/runtime.js';
import type { EngineEvent } from '../engine/adapter.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { serializeMessageMetadata } from '../message-metadata.js';
import { buildRuntimeAssistantSnapshot,type TerminalFileChanges } from './frontend-terminal-snapshot.js';

type Context=Parameters<Parameters<RuntimeStorage['process']>[1]>[1];
/** Actual message_complete adapter. Completion publication/cleanup runs only after finishTerminal confirms. */
export function finishStoredAssistant(runtime:SessionRuntime,event:Extract<EngineEvent,{type:'message_complete'}>,context:Context,options:{
  messageId:string;fileChanges:TerminalFileChanges;now:number;
}){
  context.guard.assertCurrent();
  const snapshot=buildRuntimeAssistantSnapshot(runtime,event,options);
  return context.finishTerminal({id:snapshot.messageId,turnId:snapshot.turnId,content:snapshot.content,items:snapshot.items??null,
    metadata:JSON.parse(serializeMessageMetadata(snapshot.metadata)??'null'),durationMs:snapshot.duration??null});
}
