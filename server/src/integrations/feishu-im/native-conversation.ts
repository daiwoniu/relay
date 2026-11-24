import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoreStoragePort } from '../../storage/contracts.js';
import type { RespondInteractionCommand } from '../../contracts/index.js';
import type { FeishuPending } from '../../storage/native-feishu-im.js';
import { StorageContractError } from '../../storage/command-boundary.js';
import type { StoredRuntimeGraph } from '../../ws/stored-runtime-graph.js';
import type { EngineRegistry } from '../../engine/registry.js';
import type { EngineModelCatalog } from '../../engine/models/types.js';
import { validateEnginePreferences } from '../../engine/models/preferences.js';
import { feishuModelIdSchema, type FeishuBotConfig, type FeishuEnginePreferences } from './inbound.js';
import { feishuEngineReplyLine } from './reply-execution.js';
import { feishuExecutionId, feishuExecutionResource } from './native-session-scope.js';

export class NativeFeishuConversation {
  constructor(private readonly options: {
    port: Pick<CoreStoragePort, 'runFeishuWork' | 'runFeishuAdmin' | 'execute'>;
    graph: Pick<StoredRuntimeGraph, 'scheduler' | 'runtimes' | 'responses'>;
    registry: Pick<EngineRegistry, 'list' | 'get'>;
    storeId: string; generation: number;
    catalog: (engine: FeishuEnginePreferences['engineId']) => Promise<EngineModelCatalog>;
    assertExclusiveWriter: () => Promise<void>;
  }) {}

  get supportedEngines() { return this.options.registry.list().filter(adapter => adapter.models && adapter.concurrency).map(adapter => adapter.id); }
  catalog(engine: FeishuEnginePreferences['engineId']) { return this.options.catalog(engine); }

  private async reviewContext(principal: Parameters<CoreStoragePort['runFeishuAdmin']>[0]['principal'],
    scope: { botId: string; tenantKey: string }, sequence: number) {
    const result = await this.options.port.runFeishuAdmin({ principal, request: { ...scope, action: 'reviewTurn', sequence } });
    const turn = result.reviewTurn;
    const runtime = turn ? this.options.graph.runtimes.get(turn.sessionId) : undefined;
    return turn && runtime && runtime.attemptId === turn.attemptId ? runtime : null;
  }

  async approvals(principal: Parameters<CoreStoragePort['runFeishuAdmin']>[0]['principal'],
    scope: { botId: string; tenantKey: string }, sequence: number, decision?: { id: string; action: 'accept' | 'decline'; operationId: string }) {
    const runtime = await this.reviewContext(principal, scope, sequence);
    const requests = [...runtime?.pendingInteractions ?? []].flatMap(([id, pending]) => {
      const { kind, availableActions, snapshot } = pending.interaction;
      if (!['command', 'file', 'permissions'].includes(kind)) return [];
      const detail = snapshot.command ?? snapshot.path ?? snapshot.reason;
      return [{ id, title: snapshot.title, detail: typeof detail === 'string' ? detail.slice(0, 1200)
        : Array.isArray(detail) ? detail.filter(value => typeof value === 'string').join(' ').slice(0, 1200) : null,
      accept: availableActions.includes('accept_once'), decline: availableActions.includes('decline') }];
    });
    if (!decision) return { requests };
    const request = requests.find(item => item.id === decision.id);
    if (!runtime || !request?.[decision.action]) throw new StorageContractError('CONFLICT');
    const command: RespondInteractionCommand = { type: 'respond_interaction', sessionId: runtime.sessionId,
      interactionId: decision.id, operationId: decision.operationId, action: decision.action };
    const result = await this.options.graph.responses.respond(principal, command);
    if (result.state !== 'submitted') throw new StorageContractError(result.state === 'access-denied' ? 'FORBIDDEN'
      : result.state === 'unknown' ? 'STORAGE_UNAVAILABLE' : 'CONFLICT');
    return { requests: [] };
  }

  async reply(bot: FeishuBotConfig, pending: FeishuPending, preferences: FeishuEnginePreferences, signal: AbortSignal,
    details?: { taskId?: string; taskTitle?: string; senderDisplayName?: string }) {
    const { port, graph, registry, storeId, generation, assertExclusiveWriter } = this.options;
    const { inbound, sequence } = pending;
    const scope = { botId: inbound.botId, tenantKey: inbound.tenantKey, sequence, workspacePath: bot.workspacePath };
    const { engineId, ...model } = preferences;
    const useMappedPreferences = !!inbound.relayTurn || (inbound.chatType === 'group' && !!(inbound.parentId || inbound.rootId));
    let replyCatalog: EngineModelCatalog | undefined;
    const canStart = async (engine: FeishuEnginePreferences['engineId'], settings?: Omit<FeishuEnginePreferences, 'engineId'>) => {
      if (!registry.get(engine).availability.getCurrent().available) return false;
      try {
        if (settings) {
          replyCatalog = await this.catalog(engine);
          validateEnginePreferences(replyCatalog, settings);
        }
      }
      catch { return false; }
      return true;
    };
    signal.throwIfAborted();
    if (!useMappedPreferences && !await canStart(engineId, model)) return null;
    signal.throwIfAborted();
    await assertExclusiveWriter();
    const mapped = await port.runFeishuWork({ ...scope, action: 'prepareRelayTurn', configurationId: bot.id, engineId, preferences: model,
      ...details, ...(pending.question === undefined ? {} : { clarifiedContent: pending.question }) });
    if (mapped?.kind !== 'relayTurnPrepared') return null;
    const { turn, content } = mapped;
    const resourceKey = feishuExecutionResource(turn.engineId);
    const read = () => port.runFeishuWork({ ...scope, action: 'readRelayTurn' });
    let state = await read();
    if (state?.kind === 'relayTurnResult' && state.state === 'notAdmitted') {
      if (useMappedPreferences && !await canStart(turn.engineId, turn.preferences)) return null;
      signal.throwIfAborted();
      await assertExclusiveWriter();
      const result = await port.execute({ protocolVersion: 1, storeId, workerGeneration: generation, requestId: randomUUID(),
        operationId: `feishu-turn:${turn.messageId}`, principal: { kind: 'system', purpose: 'scheduler' },
        command: { name: 'turn.enqueue', input: { sessionId: turn.sessionId, messageId: turn.messageId,
          attemptId: feishuExecutionId([turn.messageId, 'attempt']), engineId: turn.engineId, resourceKey, content, metadata: null,
          expectedPreferencesRevision: mapped.preferencesRevision,
          origin: { kind: 'feishu', botId: scope.botId, tenantKey: scope.tenantKey, sequence },
        } } });
      state = await read();
      if (state?.kind === 'relayTurnResult' && state.state === 'notAdmitted') {
        if (result.state === 'rejected' && ['FORBIDDEN', 'INVALID_ARGUMENT', 'NOT_FOUND'].includes(result.code)) return null;
        throw new StorageContractError('NOT_SUBMITTED');
      }
    }
    while (state?.kind === 'relayTurnResult' && state.state === 'pending') {
      signal.throwIfAborted();
      void graph.scheduler.drain(resourceKey).catch(() => undefined);
      await delay(1500, undefined, { signal });
      state = await read();
    }
    if (state?.kind !== 'relayTurnResult' || state.state !== 'completed') return null;
    const catalog = replyCatalog?.engineId === turn.engineId ? replyCatalog : await this.catalog(turn.engineId).catch(() => undefined);
    return { body: state.body, usage: state.usage,
        model: (state.modelInfo?.effective.id && feishuModelIdSchema.safeParse(state.modelInfo.effective.id).success
          ? state.modelInfo.effective.id : turn.preferences?.modelId) ?? turn.engineId,
        executionLine: feishuEngineReplyLine(turn.engineId, turn.preferences, state.contextCompactionCount, state.modelInfo, catalog),
        taskId: turn.taskId, taskTitle: turn.taskTitle };
  }
}
