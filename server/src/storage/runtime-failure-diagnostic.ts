import { createHash } from 'node:crypto';
import type { RuntimeFailureDiagnostic } from './runtime-storage.js';

/** Controlled correlation only. Never serialize exception text or the diagnostic object wholesale. */
export function formatRuntimeFailure(detail:RuntimeFailureDiagnostic){
  const tag=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,12);
  const word=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z_]{1,80}$/.test(value)?value:'UNCLASSIFIED';
  const size=(value:number)=>Number.isSafeInteger(value)&&value>=0?value:0;
  return JSON.stringify({session:tag(detail.sessionId),attempt:tag(detail.attemptId),connection:tag(detail.connectionId),
    stage:word(detail.stage),code:word(detail.code),...(detail.eventType?{eventType:word(detail.eventType)}:{}),pending:size(detail.pending),bytes:size(detail.bytes)});
}
