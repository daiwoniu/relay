import { JsonRpcCore } from '../engine/json-rpc/core.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { ManagedOpenCodeTransport, OpenCodeProcessManager } from './process-manager.js';
import { OPENCODE_CLIENT_CAPABILITIES } from './capabilities.js';
import { AcpInitializeResultSchema, AcpSessionResultSchema } from './acp-schema.js';

type SessionResult = ReturnType<typeof AcpSessionResultSchema.parse>;

function compactOpenCodeModelName(name: string, id: string): string {
  const value = name.trim();
  const withoutProvider = value.replace(/^(?:OpenCode Zen|OpenCode|XS Gateway \(CP\))\s*\/\s*/i, '');
  return withoutProvider || id.split('/').pop() || id;
}

export function parseOpenCodeModelCatalog(
  input: unknown,
  options: { now?: () => number } = {},
): EngineModelCatalog {
  const result = AcpSessionResultSchema.parse(input);
  const modelOption = result.configOptions?.find((entry) => entry.id === 'model' || entry.category === 'model');
  const currentValue = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined;
  return {
    engineId: 'opencode',
    fetchedAt: (options.now ?? Date.now)(),
    stale: false,
    models: (modelOption?.options ?? []).map((entry) => ({
      id: entry.value,
      displayName: compactOpenCodeModelName(entry.name || entry.value, entry.value),
      ...(entry.description ? { description: entry.description } : {}),
      isDefault: entry.value === currentValue,
      inputModalities: ['text'],
      reasoning: {
        supported: false,
        scope: 'session',
        options: [],
      },
    })),
  };
}

function waitForOpen(transport: ManagedOpenCodeTransport): Promise<void> {
  if (transport.state === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const offOpen = transport.onOpen(() => { cleanup(); resolve(); });
    const offError = transport.onError((error) => { cleanup(); reject(error); });
    const offClose = transport.onClose(() => { cleanup(); reject(new Error('OpenCode 模型发现进程已关闭')); });
    const cleanup = () => { offOpen(); offError(); offClose(); };
  });
}

let discoveryInFlight: Promise<EngineModelCatalog> | null = null;

export function discoverOpenCodeModels(
  manager: OpenCodeProcessManager,
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
        clientCapabilities: OPENCODE_CLIENT_CAPABILITIES,
        clientInfo: { name: 'relay-model-catalog', version: '1.0.0' },
      }));
      const result: any = await rpc.request('session/new', { cwd, mcpServers: [] });
      if (!result.configOptions && observedConfigOptions) result.configOptions = observedConfigOptions;
      return parseOpenCodeModelCatalog(result);
    } finally {
      rpc.close();
      await transport.closeAndWait(true).catch(() => undefined);
    }
  })().finally(() => { discoveryInFlight = null; });
  return discoveryInFlight;
}
