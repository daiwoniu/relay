import type {
  EngineTerminalDecision,
  EngineTerminalOutcome,
  EngineTurnFact,
} from './turn-facts.js';

type Candidate = { outcome: EngineTerminalOutcome; reasonCode: string; factId: string };

export type TerminalArbitrationResult =
  | { kind: 'none'; outcome?: undefined; reasonCode?: undefined }
  | ({ kind: 'decide' } & Candidate)
  | { kind: 'unchanged'; decision: EngineTerminalDecision; outcome?: undefined; reasonCode?: undefined }
  | { kind: 'conflict'; existing: EngineTerminalDecision; candidate: Candidate; outcome?: undefined; reasonCode?: undefined };

function hasContent(payload: EngineTurnFact['payload']): boolean {
  return 'hasContent' in payload && payload.hasContent;
}

function errorCode(payload: EngineTurnFact['payload']): string {
  return 'errorCode' in payload && typeof payload.errorCode === 'string' && payload.errorCode.trim()
    ? payload.errorCode.trim()
    : '';
}

function candidateForFact(fact: EngineTurnFact): Candidate | null {
  switch (fact.factType) {
    case 'final_answer_completed':
    case 'recovery_completed':
      return hasContent(fact.payload)
        ? { outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', factId: fact.id }
        : { outcome: 'failed', reasonCode: 'FINAL_ANSWER_MISSING', factId: fact.id };
    case 'engine_error':
      return { outcome: 'failed', reasonCode: errorCode(fact.payload), factId: fact.id };
    case 'connection_closed':
      return { outcome: 'failed', reasonCode: errorCode(fact.payload), factId: fact.id };
    case 'recovery_failed':
      return { outcome: 'failed', reasonCode: errorCode(fact.payload), factId: fact.id };
    case 'interrupt_confirmed':
      return {
        outcome: 'userInitiated' in fact.payload && fact.payload.userInitiated ? 'stopped' : 'interrupted',
        reasonCode: 'userInitiated' in fact.payload && fact.payload.userInitiated ? 'USER_STOPPED' : 'ENGINE_INTERRUPTED',
        factId: fact.id,
      };
    case 'recovery_interrupted':
      return { outcome: 'interrupted', reasonCode: errorCode(fact.payload), factId: fact.id };
    default:
      return null;
  }
}

function isTurnInterruptedError(candidate: Candidate): boolean {
  return candidate.outcome === 'failed' && candidate.reasonCode.endsWith('_TURN_INTERRUPTED');
}

function selectCandidate(facts: readonly EngineTurnFact[]): Candidate | null {
  const candidates = facts
    .map((fact) => ({ fact, candidate: candidateForFact(fact) }))
    .filter((entry): entry is { fact: EngineTurnFact; candidate: Candidate } => entry.candidate !== null);
  const first = candidates[0];
  if (!first) return null;
  if (first.fact.factType !== 'engine_error' || !isTurnInterruptedError(first.candidate)) return first.candidate;
  const confirmedStop = candidates.find(({ fact }) => fact.factType === 'interrupt_confirmed'
    && 'userInitiated' in fact.payload
    && fact.payload.userInitiated);
  return confirmedStop?.candidate ?? first.candidate;
}

export function arbitrateTerminalDecision(
  existing: EngineTerminalDecision | null,
  facts: readonly EngineTurnFact[],
): TerminalArbitrationResult {
  const uniqueFacts = [...new Map(facts.map((fact) => [fact.idempotencyKey, fact])).values()]
    .sort((left, right) => left.observedAt - right.observedAt || left.sequence - right.sequence || left.id.localeCompare(right.id));
  const candidate = selectCandidate(uniqueFacts);
  if (!candidate) return existing ? { kind: 'unchanged', decision: existing } : { kind: 'none' };
  if (!existing) return { kind: 'decide', ...candidate };
  if (existing.outcome === candidate.outcome && existing.reasonCode === candidate.reasonCode) {
    return { kind: 'unchanged', decision: existing };
  }
  return { kind: 'conflict', existing, candidate };
}
