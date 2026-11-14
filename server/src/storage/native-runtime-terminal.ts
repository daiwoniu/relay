import { createHash } from 'node:crypto';
import type { CoreCommandInputs,StoragePrincipal } from './contracts.js';
import { StorageContractError } from './command-boundary.js';
import type { nativeQueries } from './native-queries.js';
import { getEngineTerminalDecisionInDatabase,listEngineTurnFactsInDatabase } from '../db/engine-turn-facts.js';
import { arbitrateTerminalDecision } from '../engine/terminal-arbitrator.js';
import { isSafeEngineDiagnosticCode } from '../engine/diagnostics.js';

/** Worker-only decision from authoritative facts, inside the caller's terminal transaction. */
export function terminalFromFact(db:ReturnType<typeof nativeQueries>,runtime:Extract<StoragePrincipal,{kind:'runtime'}>,
  input:CoreCommandInputs['turn.finishFromFact']):CoreCommandInputs['turn.projectTerminal']{
  const deny=():never=>{throw new StorageContractError('CONFLICT');};
  const session=db.get(`SELECT s.engine,s.engine_session_id,s.active_turn_id FROM sessions s JOIN projects p ON p.id=s.project_id
    JOIN engine_resource_leases l ON l.session_id=s.id AND l.attempt_id=s.active_attempt_id AND l.engine_id=s.engine
    WHERE s.id=? AND s.active_attempt_id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND l.state IN ('claimed','running')`,[input.sessionId,runtime.attemptId]);
  if(!session)deny();
  const count=db.get('SELECT count(*) AS n FROM (SELECT 1 FROM engine_turn_facts WHERE session_id=? AND attempt_id=? LIMIT 4097)',[input.sessionId,runtime.attemptId]);
  if(Number(count?.n)>4096)throw new StorageContractError('STORAGE_UNAVAILABLE');
  const facts=listEngineTurnFactsInDatabase(db,input.sessionId,runtime.attemptId).filter(fact=>fact.engineId===session!.engine&&fact.source!=='history');
  const fact=facts.find(candidate=>candidate.id===input.factId);
  const adopted=fact?.source==='recovery'&&!!db.get(`SELECT 1 FROM _relay_storage_operations WHERE scope_session_id=? AND command_name='turn.appendFact'
    AND json_extract(principal_json,'$.connectionId')=? AND json_extract(principal_json,'$.runtimeVersion')=? AND json_extract(result_json,'$.fact.id')=? LIMIT 1`,[runtime.sessionId,runtime.connectionId,runtime.runtimeVersion,fact.id]);
  if(!fact||fact.connectionId!==runtime.connectionId&&!adopted
    ||fact.externalSessionId!==undefined&&fact.externalSessionId!==session!.engine_session_id
    ||fact.externalTurnId!==undefined&&fact.externalTurnId!==input.message.turnId
    ||session!.active_turn_id!==null&&session!.active_turn_id!==input.message.turnId)deny();
  const existing=getEngineTerminalDecisionInDatabase(db,input.sessionId,session!.engine,runtime.attemptId);
  const decision=arbitrateTerminalDecision(existing,facts);
  if(decision.kind==='none'||decision.kind==='conflict')return deny();
  const selected=decision.kind==='unchanged'?decision.decision:decision;
  if(selected.factId!==fact!.id&&fact!.source!=='recovery')deny();
  const proof=facts.find(candidate=>candidate.id===selected.factId);if(!proof)deny();
  if(proof!.externalSessionId!==undefined&&proof!.externalSessionId!==session!.engine_session_id
    ||proof!.externalTurnId!==undefined&&proof!.externalTurnId!==input.message.turnId)deny();
  if(selected.reasonCode&&!isSafeEngineDiagnosticCode(selected.reasonCode))throw new StorageContractError('STORAGE_UNAVAILABLE');
  if(selected.outcome==='completed'){
    const payload=proof!.payload,content=input.message.content.trim();
    if(!content||!('contentDigest' in payload)||payload.contentDigest!==createHash('sha256').update(content).digest('hex')||payload.contentLength!==content.length)deny();
  }
  return{message:input.message,decision:decision.kind==='unchanged'?decision.decision:{
    id:'decision:'+createHash('sha256').update(JSON.stringify([input.sessionId,runtime.attemptId,session!.engine])).digest('hex'),
    sessionId:input.sessionId,attemptId:runtime.attemptId,engineId:session!.engine,
    ...(proof!.externalTurnId?{externalTurnId:proof!.externalTurnId}:{}),outcome:selected.outcome,reasonCode:selected.reasonCode||'ENGINE_TURN_FAILED',
    factId:proof!.id,decidedAt:Date.now(),projectedAt:null,
  }};
}
