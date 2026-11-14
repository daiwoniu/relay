import { createEngineModelsRouter } from './engine-models-core.js';
export * from './engine-models-core.js';
import { defaultEngineSystem } from '../engine/default-system.js';
import { engineStatusService } from '../system/engine-status.js';
export default createEngineModelsRouter({
  getAvailability: async (engineId) => {
    const snapshot = await engineStatusService.getSnapshot();
    const engine = snapshot.engines.find((candidate) => candidate.id === engineId);
    return { available: engine?.available ?? false, message: engine?.message };
  },
  getCatalog: (engineId, options) => defaultEngineSystem.modelCatalog.get(engineId, options),
});
