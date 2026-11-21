import { JsonRpcCore, JsonRpcRemoteError } from '../engine/json-rpc/core.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import { WebSocketJsonRpcTransport } from '../engine/transports/websocket.js';
import { resolveCodexEndpoint } from './endpoint.js';

const DEFAULT_TIMEOUT_MS = 15_000;

function isUnknownRpcMethodError(error: unknown, method: string): boolean {
  if (!(error instanceof JsonRpcRemoteError)) return false;
  if (error.rpcCode === -32601) return true;
  const escapedMethod = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:unknown variant|method not found).*${escapedMethod}`, 'i').test(error.message);
}

function waitForOpen(transport: WebSocketJsonRpcTransport): Promise<void> {
  return new Promise((resolve, reject) => {
    const offOpen = transport.onOpen(() => { offError(); resolve(); });
    const offError = transport.onError((error) => { offOpen(); reject(error); });
  });
}

function mapModel(entry: any, configuredReasoningEffort?: string, configuredServiceTier?: string): EngineModelCatalog['models'][number] | null {
  if (!entry || typeof entry !== 'object' || entry.hidden === true) return null;
  const id = typeof entry.id === 'string' && entry.id.trim()
    ? entry.id.trim()
    : typeof entry.model === 'string' ? entry.model.trim() : '';
  if (!id) return null;
  const efforts = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts.flatMap((option: any) => {
      const optionId = typeof option?.reasoningEffort === 'string' ? option.reasoningEffort.trim() : '';
      if (!optionId) return [];
      return [{
        id: optionId,
        label: optionId,
        ...(typeof option.description === 'string' && option.description.trim()
          ? { description: option.description.trim() }
          : {}),
      }];
    })
    : [];
  const modalities = Array.isArray(entry.inputModalities)
    ? entry.inputModalities.filter((value: unknown): value is 'text' | 'image' => value === 'text' || value === 'image')
    : ['text', 'image'] as Array<'text' | 'image'>;
  const entryDefaultReasoningEffort = typeof entry.defaultReasoningEffort === 'string'
    ? entry.defaultReasoningEffort.trim()
    : '';
  const configuredDefaultReasoningEffort = configuredReasoningEffort
    && efforts.some((option: { id: string }) => option.id === configuredReasoningEffort)
    ? configuredReasoningEffort
    : '';
  const defaultReasoningEffort = configuredDefaultReasoningEffort || entryDefaultReasoningEffort;
  const serviceTiers = Array.isArray(entry.serviceTiers)
    ? entry.serviceTiers.flatMap((tier: any) => typeof tier?.id === 'string' && tier.id.trim()
      ? [{ id: tier.id.trim(), label: typeof tier.name === 'string' && tier.name.trim() ? tier.name.trim() : tier.id.trim() }]
      : [])
    : [];
  const configuredDefaultServiceTier = configuredServiceTier === 'default' ? 'default'
    : serviceTiers.find((tier: { id: string }) => tier.id === configuredServiceTier)?.id
      ?? ((configuredServiceTier === 'fast' || configuredServiceTier === 'priority')
        ? serviceTiers.find((tier: { id: string }) => tier.id === 'priority' || tier.id === 'fast')?.id
        : undefined);
  const defaultServiceTier = configuredDefaultServiceTier
    || (typeof entry.defaultServiceTier === 'string' ? entry.defaultServiceTier.trim() : '');
  return {
    id,
    displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : id,
    ...(typeof entry.description === 'string' && entry.description.trim() ? { description: entry.description.trim() } : {}),
    isDefault: entry.isDefault === true,
    inputModalities: modalities,
    ...(Number.isInteger(entry.contextWindow) && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}),
    ...(serviceTiers.length ? { serviceTiers } : {}),
    ...(defaultServiceTier ? { defaultServiceTier } : {}),
    reasoning: {
      supported: efforts.length > 0,
      scope: 'session',
      ...(defaultReasoningEffort ? { defaultOptionId: defaultReasoningEffort } : {}),
      options: efforts,
    },
  };
}

function configuredModelId(config: unknown): string | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const record = config as Record<string, any>;
  const candidates = [record.model, record.modelInfo?.name, record.modelInfo?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function applyConfiguredDefault(
  models: EngineModelCatalog['models'],
  configuredId?: string,
): EngineModelCatalog['models'] {
  if (!configuredId || !models.some((model) => model.id === configuredId)) return models;
  return models.map((model) => (
    model.isDefault === (model.id === configuredId)
      ? model
      : { ...model, isDefault: model.id === configuredId }
  ));
}

export async function listCodexModels(options: {
  wsUrl?: string;
  timeoutMs?: number;
  now?: () => number;
} = {}): Promise<EngineModelCatalog> {
  const transport = new WebSocketJsonRpcTransport(options.wsUrl ?? resolveCodexEndpoint().wsUrl);
  const rpc = new JsonRpcCore(transport, { defaultTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  try {
    await waitForOpen(transport);
    await rpc.request('initialize', {
      clientInfo: { name: 'relay', title: 'Relay Model Catalog', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized', {});
    let configuredReasoningEffort: string | undefined;
    let configuredServiceTier: string | undefined;
    let configuredId: string | undefined;
    let configurationRead = false;
    let configResult: any;
    try {
      configResult = await rpc.request('config/read', { includeLayers: false });
    } catch (error) {
      if (isUnknownRpcMethodError(error, 'config/read')) {
        try {
          configResult = await rpc.request('config/get', {});
        } catch {
          // Both configuration methods are unavailable; the caller must not freeze unknown defaults.
        }
      }
    }
    if (configResult !== undefined) {
      configurationRead = true;
      const effectiveConfig = configResult?.config || configResult;
      configuredId = configuredModelId(effectiveConfig);
      if (typeof effectiveConfig?.model_reasoning_effort === 'string' && effectiveConfig.model_reasoning_effort.trim()) {
        configuredReasoningEffort = effectiveConfig.model_reasoning_effort.trim();
      }
      if (typeof effectiveConfig?.service_tier === 'string' && effectiveConfig.service_tier.trim()) {
        configuredServiceTier = effectiveConfig.service_tier.trim();
      }
    }
    const models: EngineModelCatalog['models'] = [];
    let cursor: string | null = null;
    do {
      const result: any = await rpc.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of Array.isArray(result?.data) ? result.data : []) {
        const model = mapModel(entry, configuredReasoningEffort, configuredServiceTier);
        if (model) models.push(model);
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    } while (cursor);
    const configuredDefaults = {
      ...(configuredId ? { modelId: configuredId } : {}),
      ...(configuredReasoningEffort ? { reasoningEffort: configuredReasoningEffort } : {}),
      ...(configuredServiceTier ? { serviceTier: configuredServiceTier } : {}),
    };
    return {
      engineId: 'codex', fetchedAt: (options.now ?? Date.now)(), stale: false, configurationRead,
      models: applyConfiguredDefault(models, configuredId),
      ...(Object.keys(configuredDefaults).length ? { configuredDefaults } : {}),
    };
  } finally {
    rpc.close();
  }
}
