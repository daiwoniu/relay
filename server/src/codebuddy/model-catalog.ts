import { JsonRpcCore } from '../engine/json-rpc/core.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { ManagedCodeBuddyTransport, CodeBuddyProcessManager } from './process-manager.js';
import { CODEBUDDY_CLIENT_CAPABILITIES } from './capabilities.js';
import { AcpInitializeResultSchema, AcpSessionResultSchema } from './acp-schema.js';

type SessionResult = ReturnType<typeof AcpSessionResultSchema.parse>;

function reasoningOptions(result: SessionResult) {
  const option = result.configOptions?.find((entry) => entry.category === 'thought_level' || entry.id === 'thought_level');
  return {
    defaultOptionId: typeof option?.currentValue === 'string' ? option.currentValue : undefined,
    options: (option?.options ?? []).map((entry) => ({
      id: entry.value,
      label: entry.name || entry.value,
      ...(entry.description ? { description: entry.description } : {}),
    })),
  };
}

export function parseCodeBuddyModelCatalog(
  input: unknown,
  options: { now?: () => number } = {},
): EngineModelCatalog {
  const result = AcpSessionResultSchema.parse(input);
  const reasoning = reasoningOptions(result);
  const availableModels = result.models?.availableModels ?? [];
  return {
    engineId: 'codebuddy',
    fetchedAt: (options.now ?? Date.now)(),
    stale: false,
    models: availableModels.map((model) => {
      const supportsReasoning = model._meta?.supportsReasoning !== false && reasoning.options.length > 0;
      return {
        id: model.modelId,
        displayName: model.name || model.modelId,
        ...(model.description ? { description: model.description } : {}),
        isDefault: model.modelId === result.models?.currentModelId,
        inputModalities: model._meta?.supportsImages ? ['text', 'image'] : ['text'],
        ...(Number.isInteger(model._meta?.maxInputTokens) && model._meta!.maxInputTokens! > 0
          ? { contextWindow: model._meta!.maxInputTokens }
          : {}),
        ...(model._meta?.credits ? { costLabel: model._meta.credits } : {}),
        reasoning: {
          supported: supportsReasoning,
          scope: 'session',
          ...(supportsReasoning && reasoning.defaultOptionId ? { defaultOptionId: reasoning.defaultOptionId } : {}),
          options: supportsReasoning ? reasoning.options : [],
        },
      } satisfies EngineModelCatalog['models'][number];
    }),
  };
}

function waitForOpen(transport: ManagedCodeBuddyTransport): Promise<void> {
  if (transport.state === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const offOpen = transport.onOpen(() => { cleanup(); resolve(); });
    const offError = transport.onError((error) => { cleanup(); reject(error); });
    const offClose = transport.onClose(() => { cleanup(); reject(new Error('CodeBuddy 模型发现进程已关闭')); });
    const cleanup = () => { offOpen(); offError(); offClose(); };
  });
}

let discoveryInFlight: Promise<EngineModelCatalog> | null = null;

export function discoverCodeBuddyModels(
  manager: CodeBuddyProcessManager,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<EngineModelCatalog> {
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = (async () => {
    const transport = manager.createModelDiscoveryTransport(cwd);
    const rpc = new JsonRpcCore(transport, { defaultTimeoutMs: options.timeoutMs ?? 30_000 });
    let observedConfigOptions: unknown[] | undefined;
    rpc.onNotification((message) => {
      const update = (message.params as any)?.update;
      if (message.method === 'session/update' && update?.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
        observedConfigOptions = update.configOptions;
      }
    });
    try {
      await waitForOpen(transport);
      AcpInitializeResultSchema.parse(await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: CODEBUDDY_CLIENT_CAPABILITIES,
        clientInfo: { name: 'relay-model-catalog', version: '1.0.0' },
      }));
      const result: any = await rpc.request('session/new', { cwd, mcpServers: [] });
      if (!result.configOptions && observedConfigOptions) result.configOptions = observedConfigOptions;
      return parseCodeBuddyModelCatalog(result);
    } finally {
      rpc.close();
      await transport.closeAndWait(true).catch(() => undefined);
    }
  })().finally(() => { discoveryInFlight = null; });
  return discoveryInFlight;
}
