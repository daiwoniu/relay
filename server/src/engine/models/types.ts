import type { EngineModelCatalogDto } from '../../contracts/index.js';

export type EngineModelCatalog = EngineModelCatalogDto;

export interface EngineModelAdapter {
  listModels(): Promise<EngineModelCatalog>;
}
