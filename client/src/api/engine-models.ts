import type { EngineId, EngineModelCatalogDto } from '../generated/relay-contracts';
import { requestJson } from './client.ts';

export function getEngineModels(
  engineId: EngineId,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<EngineModelCatalogDto> {
  const suffix = options.refresh ? '?refresh=1' : '';
  return requestJson(`/api/system/engines/${encodeURIComponent(engineId)}/models${suffix}`, {
    cache: 'no-store', signal: options.signal,
  });
}
