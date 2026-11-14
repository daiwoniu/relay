import { Hono } from 'hono';
import { EngineIdSchema, EngineModelCatalogDtoSchema, presentApiError } from '../contracts/index.js';
import type { EngineId } from '../engine/types.js';
import type { EngineModelCatalog } from '../engine/models/types.js';



type CatalogErrorCode =
  | 'ENGINE_MODEL_CATALOG_UNSUPPORTED'
  | 'ENGINE_MODEL_CATALOG_UNAVAILABLE'
  | 'ENGINE_MODEL_CATALOG_INVALID';

export interface EngineModelsRouterDependencies {
  getAvailability(engineId: EngineId): { available: boolean; message?: string } | Promise<{ available: boolean; message?: string }>;
  getCatalog(engineId: EngineId, options: { refresh: boolean }): Promise<EngineModelCatalog>;
}

function catalogErrorResponse(error: unknown): { status: 500 | 501 | 502; code: CatalogErrorCode; message: string } {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ENGINE_MODEL_CATALOG_UNSUPPORTED') return { status: 501, code, message: '该引擎不支持模型目录' };
  if (code === 'ENGINE_MODEL_CATALOG_INVALID') return { status: 502, code, message: '引擎返回的模型目录无效' };
  return { status: 502, code: 'ENGINE_MODEL_CATALOG_UNAVAILABLE', message: '模型目录暂时不可用' };
}

export function createEngineModelsRouter(dependencies: EngineModelsRouterDependencies) {
  const router = new Hono();
  router.get('/engines/:engineId/models', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const engineId = EngineIdSchema.safeParse(c.req.param('engineId'));
    if (!engineId.success) return c.json(presentApiError('未知的 AI 引擎', { code: 'ENGINE_NOT_REGISTERED' }), 404);
    const availability = await dependencies.getAvailability(engineId.data);
    if (!availability.available) {
      return c.json(presentApiError(availability.message || 'AI 引擎当前不可用', { code: 'ENGINE_UNAVAILABLE' }), 503);
    }
    try {
      const catalog = await dependencies.getCatalog(engineId.data, { refresh: c.req.query('refresh') === '1' });
      return c.json(EngineModelCatalogDtoSchema.parse(catalog));
    } catch (error) {
      const mapped = catalogErrorResponse(error);
      return c.json(presentApiError(mapped.message, { code: mapped.code }), mapped.status);
    }
  });
  return router;
}

