import type { PendingApprovalResolution, RespondInteractionCommand } from '../contracts/index.js';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import {
  createInteractionId,
  defineNormalizedInteraction,
  type EngineInteractionRequest,
  type InteractionResponseCommand,
  type NormalizedInteraction,
  type NormalizedInteractionKind,
} from '../engine/interactions.js';
import type { RuntimeTurnItem } from '../engine/runtime.js';

const APPROVAL_INTERACTION_METHODS = new Set([
  'session/request_permission',
  'interaction/requestPermission',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

function presentationKind(kind: NormalizedInteractionKind): string {
  if (kind === 'command') return 'command_approval';
  if (kind === 'file') return 'file_approval';
  if (kind === 'permissions') return 'permissions_approval';
  if (kind === 'user_input') return 'user_input';
  if (kind === 'mcp_elicitation') return 'mcp_elicitation';
  return 'unsupported_request';
}

function toStandardCommand(
  method: string,
  command: RespondInteractionCommand,
): InteractionResponseCommand {
  return {
    action: command.action === 'accept'
      ? method === 'mcpServer/elicitation/request' ? 'submit' : 'accept_once'
      : command.action,
    ...(command.answers ? { answers: command.answers } : {}),
    ...(command.formData ? { formData: command.formData } : {}),
  };
}

function safeFallbackRequestId(requestId: string | number): string | number {
  try {
    createInteractionId(requestId);
    return requestId;
  } catch {
    const source = `${typeof requestId}:${String(requestId)}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
      hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
    }
    return `invalid-${(hash >>> 0).toString(16)}`;
  }
}

export function getPendingApprovalResolution(
  method: string,
  action: RespondInteractionCommand['action'],
): PendingApprovalResolution | null {
  if (method === 'item/tool/requestUserInput' || method === 'session/request_user_input') {
    return action === 'submit' ? 'submitted' : action === 'cancel' ? 'cancel' : null;
  }
  if (method === 'mcpServer/elicitation/request') {
    if (action === 'submit' || action === 'accept') return 'submitted';
    if (action === 'decline' || action === 'cancel') return action;
    return null;
  }
  if (!APPROVAL_INTERACTION_METHODS.has(method) || action === 'submit') return null;
  return action;
}

/**
 * 按引擎连接给交互 id 加作用域：引擎 requestId 会在新连接/新轮次从 0 重新计数，
 * 只用它拼 id 会让不同轮次的授权票据撞同一个主键，导致 pending 覆盖与 resolved 回执误伤。
 * 未提供连接标识时退化为标准 id，保持既有调用稳定。
 */
export function createScopedInteractionId(
  connectionId: string | null | undefined,
  requestId: string | number,
): string {
  const base = createInteractionId(requestId);
  if (typeof connectionId !== 'string' || !connectionId.trim()) return base;
  return `interaction:${connectionId.trim()}:${base.slice('interaction:'.length)}`;
}

export function createInteractionItem(
  normalized: NormalizedInteraction,
  method: string,
  connectionId?: string | null,
): RuntimeTurnItem {
  return {
    id: createScopedInteractionId(connectionId, normalized.requestId),
    type: 'interaction',
    status: 'in_progress',
    details: {
      interactionKind: presentationKind(normalized.kind),
      requestId: normalized.requestId,
      method,
      ...normalized.snapshot,
    },
  };
}

export function buildInteractionResponse(
  adapter: EngineInteractionAdapter,
  request: EngineInteractionRequest,
  command: RespondInteractionCommand,
): unknown {
  return adapter.buildResponse(
    request,
    toStandardCommand(request.method, command),
  );
}

export function normalizeInteractionOrFallback(
  adapter: EngineInteractionAdapter | undefined,
  request: EngineInteractionRequest,
): NormalizedInteraction {
  try {
    if (!adapter) throw new Error('当前引擎未提供交互分面');
    return adapter.normalize(request);
  } catch {
    return defineNormalizedInteraction({
      requestId: safeFallbackRequestId(request.requestId),
      kind: 'unknown',
      snapshot: { title: '需要处理客户端请求' },
      availableActions: [],
    });
  }
}

export function isTurnCancellingInteractionResponse(method: string, result: unknown): boolean {
  if (method === 'session/request_permission' || method === 'session/request_user_input') {
    return Boolean(result && typeof result === 'object'
      && (result as { outcome?: { outcome?: unknown } }).outcome?.outcome === 'cancelled');
  }
  if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
    return false;
  }
  return Boolean(result && typeof result === 'object' && (result as { decision?: unknown }).decision === 'cancel');
}

export function shouldFinalizeAsUserCancelled(
  interactionCancelRequested: boolean,
  errorCode: string | undefined,
): boolean {
  return interactionCancelRequested
    && (errorCode === 'CODEX_TURN_INTERRUPTED' || errorCode === 'CODEBUDDY_TURN_INTERRUPTED');
}
