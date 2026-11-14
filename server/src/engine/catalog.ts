import type { EngineCapabilities } from './adapter.js';
import { ENGINE_DEFINITIONS } from './definition.js';
import type { EngineId } from './types.js';

export interface EngineDescriptor {
  id: EngineId;
  label: string;
  capabilities: EngineCapabilities;
}

export const ENGINE_CATALOG = Object.fromEntries(
  Object.values(ENGINE_DEFINITIONS).map(({ id, label, capabilities }) => [id, { id, label, capabilities }]),
) as Record<EngineId, EngineDescriptor>;
