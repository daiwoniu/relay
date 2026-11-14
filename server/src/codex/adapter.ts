import {
  createCodexConnection,
  type CodexConnectionOptions,
  type CodexHandshakeStageEvent,
} from './client.js';
import type { RelayWSMessage } from './protocol.js';
import type {
  EngineAdapter,
  EngineConnection,
  EngineConnectionOptions,
  EngineEvent,
  EngineTurnOptions,
} from '../engine/adapter.js';
import { ENGINE_CATALOG } from '../engine/catalog.js';
import { createEngineEventEmitter, type EngineEventSource } from '../engine/events.js';
import { classifyCodexError } from './diagnostics.js';
import { createUncheckedEngineHealth, type EngineLocalHealth } from '../engine/health.js';
import { validateEngineConcurrencyResource, type EngineConcurrencyContext } from '../engine/concurrency/types.js';
import { listCodexModels } from './model-catalog.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { EnginePerformanceMilestone } from '../engine/performance-observability.js';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import {
  defineNormalizedInteraction,
  type EngineInteractionRequest,
  type InteractionAction,
  type InteractionResponseCommand,
  type NormalizedInteractionKind,
} from '../engine/interactions.js';

const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

const CODEX_DECISION_ACTIONS: Record<string, InteractionAction> = {
  accept: 'accept_once',
  acceptForSession: 'accept_for_session',
  decline: 'decline',
  cancel: 'cancel',
};

function codexInteractionKind(method: string): NormalizedInteractionKind {
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') return 'command';
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') return 'file';
  if (method === 'item/permissions/requestApproval') return 'permissions';
  if (method === 'item/tool/requestUserInput' || method === 'session/request_user_input') return 'user_input';
  if (method === 'mcpServer/elicitation/request') return 'mcp_elicitation';
  return 'unknown';
}

function codexInteractionTitle(kind: NormalizedInteractionKind): string {
  if (kind === 'command') return '需要授权执行命令';
  if (kind === 'file') return '需要授权修改文件';
  if (kind === 'permissions') return '需要授予额外权限';
  if (kind === 'user_input') return '引擎需要你的回答';
  if (kind === 'mcp_elicitation') return '工具需要补充信息';
  return '需要处理客户端请求';
}

function codexAvailableActions(request: EngineInteractionRequest, kind: NormalizedInteractionKind): InteractionAction[] {
  if (kind === 'user_input') return ['submit', 'cancel'];
  if (kind === 'mcp_elicitation') return ['submit', 'decline', 'cancel'];
  if (!CODEX_APPROVAL_METHODS.has(request.method)) return [];
  const decisions = Array.isArray(request.params.availableDecisions)
    ? request.params.availableDecisions.filter((entry): entry is string => typeof entry === 'string')
    : null;
  if (!decisions || decisions.length === 0) return ['accept_once', 'accept_for_session', 'decline', 'cancel'];
  return [...new Set(decisions.flatMap((decision) => (
    CODEX_DECISION_ACTIONS[decision] ? [CODEX_DECISION_ACTIONS[decision]] : []
  )))];
}

function withoutNullValues(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry != null));
}

function codexDecisionForAction(action: InteractionAction): string {
  if (action === 'accept_once') return 'accept';
  if (action === 'accept_for_session') return 'acceptForSession';
  if (action === 'decline') return 'decline';
  if (action === 'cancel') return 'cancel';
  throw new Error('该授权决定当前不可用');
}

export const codexInteractionAdapter: EngineInteractionAdapter = {
  normalize(request) {
    const kind = codexInteractionKind(request.method);
    const snapshot = kind === 'unknown'
      ? { title: codexInteractionTitle(kind) }
      : { ...request.params, title: codexInteractionTitle(kind) };
    return defineNormalizedInteraction({
      requestId: request.requestId,
      kind,
      snapshot,
      availableActions: codexAvailableActions(request, kind),
    });
  },
  buildResponse(request, command) {
    const { action } = command;
    if (CODEX_APPROVAL_METHODS.has(request.method)
      && !codexAvailableActions(request, codexInteractionKind(request.method)).includes(action)) {
      throw new Error('该授权决定当前不可用');
    }
    if (request.method === 'item/commandExecution/requestApproval') {
      const decision = codexDecisionForAction(action);
      const available = Array.isArray(request.params.availableDecisions)
        ? request.params.availableDecisions.filter((entry): entry is string => typeof entry === 'string')
        : null;
      if (available && available.length > 0 && !available.includes(decision)) {
        throw new Error('该授权决定当前不可用');
      }
      return { decision };
    }
    if (request.method === 'item/fileChange/requestApproval') {
      return { decision: codexDecisionForAction(action) };
    }
    if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
      if (action === 'accept_once') return { decision: 'approved' };
      if (action === 'accept_for_session') return { decision: 'approved_for_session' };
      if (action === 'decline' || action === 'cancel') return { decision: 'denied' };
      throw new Error('该授权决定当前不可用');
    }
    if (request.method === 'item/permissions/requestApproval') {
      if (!['accept_once', 'accept_for_session', 'decline', 'cancel'].includes(action)) {
        throw new Error('该授权决定当前不可用');
      }
      return {
        permissions: action === 'accept_once' || action === 'accept_for_session'
          ? withoutNullValues(request.params.permissions)
          : {},
        scope: action === 'accept_for_session' ? 'session' : 'turn',
      };
    }
    if (request.method === 'item/tool/requestUserInput' || request.method === 'session/request_user_input') {
      if (action === 'cancel' && request.method === 'session/request_user_input') return { outcome: { outcome: 'cancelled' } };
      if (action !== 'submit') throw new Error('该输入决定当前不可用');
      if (request.method === 'session/request_user_input') return { answers: command.answers || {} };
      return { answers: Object.fromEntries(Object.entries(command.answers || {}).map(([id, values]) => [id, { answers: values }])) };
    }
    if (request.method === 'mcpServer/elicitation/request') {
      const elicitationAction = action === 'submit' ? 'accept' : action === 'decline' ? 'decline' : action === 'cancel' ? 'cancel' : null;
      if (!elicitationAction) throw new Error('该输入决定当前不可用');
      return { action: elicitationAction, content: elicitationAction === 'accept' ? command.formData || {} : null, _meta: null };
    }
    throw new Error(`暂不支持处理引擎请求：${request.method}`);
  },
};

export function codexHandshakeMilestone(event: CodexHandshakeStageEvent): EnginePerformanceMilestone | null {
  if (event.outcome !== 'completed') return null;
  if (event.stage === 'connection') return 'transport_opened';
  if (event.stage === 'initialize') return 'protocol_initialized';
  if (event.stage === 'config/read' || event.stage === 'config/get') return 'configuration_ready';
  return null;
}

export function toEngineEvent(message: RelayWSMessage): EngineEvent | null {
  switch (message.type) {
    case 'capacity_observation': return { ...message };
    case 'request_forwarded': return { type: 'request_forwarded' };
    case 'delta': return { ...message };
    case 'item_start': return { ...message };
    case 'item_complete': return { ...message };
    case 'turn_start': return { ...message };
    case 'turn_complete': return { ...message };
    case 'message_complete': return { ...message };
    case 'error': return { type: 'error', diagnostic: classifyCodexError(message, { phase: 'provider' }) };
    case 'model_info': return { ...message };
    case 'token_usage': return { ...message };
    case 'recovery_snapshot': return { ...message };
    case 'server_request': return { ...message };
    case 'server_request_resolved': return { ...message };
    case 'system_notice': return { ...message };
    default: return null;
  }
}

export function codexEventSource(event: EngineEvent): EngineEventSource {
  if (event.type === 'capacity_observation') return 'local';
  if (event.type === 'recovery_snapshot') return 'recovery';
  if (event.type === 'request_forwarded') return 'local';
  if (event.type === 'error') {
    if (event.diagnostic.phase === 'recovery') return 'recovery';
    if (event.diagnostic.phase === 'connect' || event.diagnostic.phase === 'protocol' || event.diagnostic.phase === 'close') {
      return 'process_exit';
    }
  }
  return 'realtime';
}

export interface CodexAdapterOptions {
  getAvailability?: () => { available: boolean; code: string; message?: string };
  inspectLocalHealth?: () => Promise<EngineLocalHealth>;
  listModels?: () => Promise<EngineModelCatalog>;
}

export class CodexAdapter implements EngineAdapter {
  readonly id = 'codex' as const;
  readonly descriptor = ENGINE_CATALOG.codex;
  readonly availability;
  readonly diagnostics = {
    classify: classifyCodexError,
  };
  readonly health;
  readonly concurrency = {
    resolveResource: (_context: EngineConcurrencyContext) => validateEngineConcurrencyResource({
      resourceKey: 'codex:default',
      providerKey: null,
      label: this.descriptor.label,
      defaultMaxActiveTurns: 2,
    }),
  };
  readonly runtime = { connect: (options: EngineConnectionOptions) => this.connect(options) };
  readonly recovery = { restartMode: 'resume' as const };
  readonly models;
  readonly interactions = codexInteractionAdapter;

  constructor(options: CodexAdapterOptions = {}) {
    const getAvailability: NonNullable<CodexAdapterOptions['getAvailability']> = options.getAvailability
      ?? (() => ({ available: true, code: 'AVAILABLE' }));
    this.availability = { getCurrent: getAvailability };
    this.models = { listModels: options.listModels ?? (() => listCodexModels()) };
    this.health = {
      inspectLocal: options.inspectLocalHealth ?? (async () => {
        const availability = getAvailability();
        return createUncheckedEngineHealth({
          engineId: this.id,
          available: availability.available,
          code: availability.code,
          message: availability.message || (availability.available ? 'Codex 可用' : 'Codex 不可用'),
        });
      }),
    };
  }

  private connect(options: EngineConnectionOptions): EngineConnection {
    let externalSessionId = options.externalSessionId;
    const emit = createEngineEventEmitter({ engineId: this.id, emit: options.onEvent });
    const codexOptions: CodexConnectionOptions = {
      cwd: options.cwd,
      threadId: options.externalSessionId,
      onThreadReady: async (id) => { externalSessionId = id; await options.onSessionReady(id); },
      onInputAccepted: options.onInputAccepted,
      onConnectionClosed: options.onClosed,
      onHandshakeStage: (event) => {
        const milestone = codexHandshakeMilestone(event);
        if (milestone) options.onPerformanceMilestone?.(milestone);
      },
      ...(options.recoverTurnId !== undefined ? { recoverTurnId: options.recoverTurnId } : {}),
      ...(options.recoverStartedAt !== undefined ? { recoverStartedAt: options.recoverStartedAt } : {}),
      ...(options.initialTurnOptions ? { initialTurnOptions: options.initialTurnOptions } : {}),
    };
    const connection = createCodexConnection(
      (message) => {
        if (message.type === 'request_forwarded') options.onPerformanceMilestone?.('provider_request_sent');
        const event = toEngineEvent(message);
        if (!event) return;
        const externalTurnId = 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : undefined;
        emit(event, {
          source: codexEventSource(event),
          ...(externalSessionId ? { externalSessionId } : {}),
          ...(externalTurnId ? { externalTurnId } : {}),
        });
      },
      codexOptions,
    );
    return {
      send: (content: string, turnOptions?: EngineTurnOptions) => connection.send(content, turnOptions),
      steer: (input) => connection.steer(input),
      cancel: connection.interrupt,
      respondToInteraction: connection.respondToServerRequest,
      close: connection.close,
    };
  }
}
