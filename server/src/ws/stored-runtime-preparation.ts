import { createSessionRuntimeState, prepareClaimedSessionRuntime } from '../engine/runtime.js';
import type { QueueClaim, StoredClaimedTurn } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { EngineId } from '../engine/types.js';
import type { buildStoredTurnModelSnapshot } from '../engine/models/stored-turn-snapshot.js';
type CatalogLoader = (engine:EngineId,preferences:{modelId:string|null;reasoningEffort:string|null;serviceTier?:string|null})=>Promise<ReturnType<typeof buildStoredTurnModelSnapshot>>;

/** Prepare from the Native claim snapshot; never read the legacy database or publish a runtime before awaiting models. */
export function createStoredRuntimePreparation(loadCatalog: CatalogLoader) {
  return async (claim: QueueClaim, payload: StoredClaimedTurn, signal: AbortSignal) => {
    const assertActive = () => { if (signal.aborted) throw new StorageContractError('NOT_SUBMITTED'); };
    assertActive();
    const { modelId, reasoningEffort, serviceTier, projectId } = payload.session;
    const preferences = { modelId, reasoningEffort, serviceTier };
    const catalog = await loadCatalog(claim.engineId, preferences);
    assertActive();
    const runtime = createSessionRuntimeState({ sessionId: claim.sessionId, projectId, engine: claim.engineId });
    prepareClaimedSessionRuntime(runtime, {
      projectId, attemptId: claim.attemptId, resourceKey: claim.resourceKey, leaseToken: claim.leaseToken,
      requestedByUserId: claim.requestedByUserId, claimedAt: payload.claimedAt,
      preferences, ...catalog,
    });
    return runtime;
  };
}
