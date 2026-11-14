import { createDefaultEngineSystem } from './create-system.js';
export { createDefaultEngineSystem } from './create-system.js';
import { engineStatusService } from '../system/engine-status.js';

export const defaultEngineSystem = createDefaultEngineSystem({
  codex: { inspectLocalHealth: () => engineStatusService.inspectCodexLocalHealth() },
  codebuddy: {
    getAvailability: () => engineStatusService.getCodeBuddyAvailability(),
    inspectLocalHealth: () => engineStatusService.inspectCodeBuddyLocalHealth(),
  },
  opencode: {
    getAvailability: () => engineStatusService.getOpenCodeAvailability(),
    inspectLocalHealth: () => engineStatusService.inspectOpenCodeLocalHealth(),
  },
  zcode: {
    getAvailability: () => engineStatusService.getZcodeAvailability(),
    inspectLocalHealth: () => engineStatusService.inspectZcodeLocalHealth(),
  },
});

engineStatusService.subscribeAvailabilityChanges((engineId) => {
  defaultEngineSystem.modelCatalog.invalidate(engineId);
});
