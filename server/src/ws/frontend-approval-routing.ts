import type { EngineInteractionAdapter } from '../engine/facets.js';
import type { EngineInteractionRequest, NormalizedInteraction } from '../engine/interactions.js';
import { completeRuntimeInteraction, type RuntimeTurnItem, type SessionRuntime } from '../engine/runtime.js';
import { attemptAutoAccept, decideApprovalRoute, type ApprovalRoutingDecision } from '../services/approval-decision.js';
import type { EffectiveApprovalTrust } from '../services/approval-trust.js';
import { insertOperationReference } from '../process-timeline.js';
import { upsertTurnItem } from './frontend-protocol.js';
import { createInteractionItem, createScopedInteractionId, normalizeInteractionOrFallback } from './frontend-interactions.js';

const DEFAULT_MANUAL_TRUST: EffectiveApprovalTrust = {
  trusted: false, source: 'manual', effectiveScope: null, expiresAt: null,
  sessionOverridesProject: false, diagnostic: 'scope_unavailable',
};

export type IncomingApprovalRoute =
  | { outcome: 'duplicate' | 'connection_lost' }
  | { outcome: 'manual'; item: RuntimeTurnItem; standalone: boolean }
  | { outcome: 'accepted'; item: RuntimeTurnItem; standalone: boolean; decision: Extract<ApprovalRoutingDecision, { route: 'auto_accept' }> };

export function routeIncomingApproval(input: {
  runtime: SessionRuntime;
  adapter: EngineInteractionAdapter | undefined;
  request: EngineInteractionRequest;
  resolveTrust(ownerUserId: string, sessionId: string): EffectiveApprovalTrust;
  /** 信任按会话 owner_user_id 记账；请求发起人缺失时用它兜底。 */
  resolveSessionOwnerUserId(sessionId: string): string | null;
  clock?: () => number;
}): IncomingApprovalRoute {
  const interaction = normalizeInteractionOrFallback(input.adapter, input.request);
  const interactionScope = input.runtime.engineConnectionId ?? 'no-connection';
  const interactionId = createScopedInteractionId(interactionScope, interaction.requestId);
  if (input.runtime.pendingInteractions.has(interactionId) || input.runtime.settledInteractionIds.has(interactionId)) {
    return { outcome: 'duplicate' };
  }
  const standalone = !input.runtime.isRunning && !input.runtime.attemptId;
  if (standalone) {
    input.runtime.isRunning = true;
    input.runtime.turnStartTime = Date.now();
  }
  const item = createInteractionItem(interaction, input.request.method, interactionScope);
  input.runtime.turnItems = upsertTurnItem(input.runtime.turnItems, item);
  input.runtime.processTimeline = insertOperationReference(input.runtime.processTimeline, item.id);
  let trust = DEFAULT_MANUAL_TRUST;
  try {
    // 信任按请求发起人记账；迟到的授权在终态清理后 requestedByUserId 已被置空，
    // 此时按会话所有人兜底，保证会话信任对迟到授权依然生效。
    const trustOwnerUserId = input.runtime.requestedByUserId ?? input.resolveSessionOwnerUserId(input.runtime.sessionId);
    trust = trustOwnerUserId
      ? input.resolveTrust(trustOwnerUserId, input.runtime.sessionId)
      : DEFAULT_MANUAL_TRUST;
  } catch {
    trust = { ...DEFAULT_MANUAL_TRUST, diagnostic: 'read_failed' };
  }
  const decision = decideApprovalRoute(interaction, trust);
  const connection = input.runtime.engineConnection;
  if (decision.route === 'auto_accept' && input.adapter && connection) {
    const attempt = attemptAutoAccept({
      decision, adapter: input.adapter, request: input.request,
      respond: (requestId, result) => connection.respondToInteraction(requestId, result),
    });
    if (attempt.outcome === 'accepted') {
      const completed = completeRuntimeInteraction(input.runtime, interactionId, {
        resolvedAction: 'accept', source: decision.source, expiresAt: decision.expiresAt,
        decidedAt: (input.clock ?? Date.now)(),
      });
      if (!completed) return { outcome: 'connection_lost' };
      return { outcome: 'accepted', item: completed, standalone, decision };
    }
    if (input.runtime.engineConnection !== connection) return { outcome: 'connection_lost' };
  }
  input.runtime.pendingInteractions.set(item.id, { request: input.request, interaction, standalone, createdAt: Date.now(), connectionId: input.runtime.engineConnectionId });
  return { outcome: 'manual', item, standalone };
}
