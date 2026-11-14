import { EngineModelCatalogDtoSchema } from '../../contracts/index.js';
import type { EngineId } from '../types.js';
import type { EngineRegistry } from '../registry.js';
import type { EngineModelCatalog } from './types.js';

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const REFRESH_RETRY_MS = 30_000;

export type EngineModelCatalogErrorCode =
  | 'ENGINE_MODEL_CATALOG_UNSUPPORTED'
  | 'ENGINE_MODEL_CATALOG_UNAVAILABLE'
  | 'ENGINE_MODEL_CATALOG_INVALID';

export class EngineModelCatalogError extends Error {
  constructor(readonly code: EngineModelCatalogErrorCode, message: string) {
    super(message);
    this.name = 'EngineModelCatalogError';
  }
}

interface CatalogCacheEntry {
  catalog?: EngineModelCatalog;
  expiresAt: number;
  inFlight?: Promise<EngineModelCatalog>;
  retryAt?: number;
}

function validateCatalog(engineId: EngineId, input: unknown): EngineModelCatalog {
  const parsed = EngineModelCatalogDtoSchema.safeParse(input);
  if (!parsed.success || parsed.data.engineId !== engineId) {
    throw new EngineModelCatalogError('ENGINE_MODEL_CATALOG_INVALID', `引擎 ${engineId} 返回的模型目录无效`);
  }
  const modelIds = new Set<string>();
  for (const model of parsed.data.models) {
    if (modelIds.has(model.id)) {
      throw new EngineModelCatalogError('ENGINE_MODEL_CATALOG_INVALID', `模型目录无效：模型 ID 重复（${model.id}）`);
    }
    modelIds.add(model.id);
    const optionIds = new Set<string>();
    for (const option of model.reasoning.options) {
      if (optionIds.has(option.id)) {
        throw new EngineModelCatalogError('ENGINE_MODEL_CATALOG_INVALID', `模型目录无效：推理选项 ID 重复（${model.id}/${option.id}）`);
      }
      optionIds.add(option.id);
    }
    if (model.reasoning.defaultOptionId && !optionIds.has(model.reasoning.defaultOptionId)) {
      throw new EngineModelCatalogError('ENGINE_MODEL_CATALOG_INVALID', `模型目录无效：默认推理选项不存在（${model.id}）`);
    }
  }
  return parsed.data;
}

export class EngineModelCatalogService {
  private readonly cache = new Map<EngineId, CatalogCacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly registry: EngineRegistry,
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async get(engineId: EngineId, options: { refresh?: boolean; preferCached?: boolean } = {}): Promise<EngineModelCatalog> {
    const entry = this.cache.get(engineId) ?? { expiresAt: 0 };
    this.cache.set(engineId, entry);
    // Admission can validate a known model without holding message persistence behind provider discovery.
    // Dispatch and explicit refresh retain the awaited path below, including any in-flight refresh.
    if (options.preferCached && !options.refresh && entry.catalog) {
      const expired = entry.expiresAt <= this.now();
      if (expired && !entry.inFlight && (entry.retryAt ?? 0) <= this.now()) {
        void this.get(engineId, { refresh: true }).catch(() => {});
      }
      return expired ? { ...entry.catalog, stale: true } : entry.catalog;
    }
    if (entry.inFlight) return entry.inFlight;
    if (!options.refresh && entry.catalog && entry.expiresAt > this.now()) return entry.catalog;

    const adapter = this.registry.get(engineId);
    if (!adapter.models) {
      throw new EngineModelCatalogError('ENGINE_MODEL_CATALOG_UNSUPPORTED', `引擎 ${engineId} 不支持模型目录`);
    }

    // Install the shared promise before invoking adapters, including ones that throw synchronously.
    entry.inFlight = Promise.resolve().then(async () => {
      try {
        const catalog = validateCatalog(engineId, await adapter.models!.listModels());
        entry.catalog = { ...catalog, stale: false };
        entry.expiresAt = this.now() + this.ttlMs;
        entry.retryAt = 0;
        return entry.catalog;
      } catch (error) {
        if (entry.catalog) {
          entry.catalog = { ...entry.catalog, stale: true };
          entry.expiresAt = 0;
          entry.retryAt = this.now() + REFRESH_RETRY_MS;
          return entry.catalog;
        }
        if (error instanceof EngineModelCatalogError) throw error;
        throw new EngineModelCatalogError('ENGINE_MODEL_CATALOG_UNAVAILABLE', `引擎 ${engineId} 的模型目录暂时不可用`);
      } finally {
        entry.inFlight = undefined;
      }
    });
    return entry.inFlight;
  }

  invalidate(engineId: EngineId): void {
    this.cache.delete(engineId);
  }

  prime(engineId: EngineId, input: unknown): EngineModelCatalog {
    const catalog = { ...validateCatalog(engineId, input), stale: false };
    this.cache.set(engineId, { catalog, expiresAt: this.now() + this.ttlMs });
    return catalog;
  }
}
