import type { NormalizedInteraction } from '../engine/interactions.js';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import type { EngineInteractionRequest } from '../engine/interactions.js';
import type { EffectiveApprovalTrust } from './approval-trust.js';

export type ApprovalRoutingDecision =
  | { route: 'manual'; reason: string }
  | {
      route: 'auto_accept';
      source: 'session_trust' | 'project_trust';
      expiresAt: number | null;
    };

const AUTO_APPROVABLE_KINDS = new Set<NormalizedInteraction['kind']>([
  'command',
  'file',
  'permissions',
]);

export function decideApprovalRoute(
  interaction: NormalizedInteraction,
  trust: EffectiveApprovalTrust,
): ApprovalRoutingDecision {
  if (!trust.trusted || trust.diagnostic !== null) {
    return { route: 'manual', reason: trust.diagnostic || 'trust_not_effective' };
  }
  if (trust.source !== 'session_trust' && trust.source !== 'project_trust') {
    return { route: 'manual', reason: 'trust_source_not_eligible' };
  }
  if (!AUTO_APPROVABLE_KINDS.has(interaction.kind)) {
    return { route: 'manual', reason: 'interaction_kind_not_eligible' };
  }
  if (!interaction.autoApprovable || !interaction.availableActions.includes('accept_once')) {
    return { route: 'manual', reason: 'accept_once_unavailable' };
  }
  return {
    route: 'auto_accept',
    source: trust.source,
    expiresAt: trust.expiresAt,
  };
}

export function attemptAutoAccept(input: {
  decision: Extract<ApprovalRoutingDecision, { route: 'auto_accept' }>;
  adapter: EngineInteractionAdapter;
  request: EngineInteractionRequest;
  respond(requestId: string | number, result: unknown): void;
}):
  | { outcome: 'accepted'; decision: Extract<ApprovalRoutingDecision, { route: 'auto_accept' }> }
  | { outcome: 'manual'; reason: 'build_response_failed' | 'respond_failed' } {
  let result: unknown;
  try {
    result = input.adapter.buildResponse(input.request, { action: 'accept_once' });
  } catch {
    return { outcome: 'manual', reason: 'build_response_failed' };
  }
  try {
    input.respond(input.request.requestId, result);
  } catch {
    return { outcome: 'manual', reason: 'respond_failed' };
  }
  return { outcome: 'accepted', decision: input.decision };
}
