import path from 'node:path';
import { cleanupOldFrontendReleases, getFrontendBuildPaths, isCompleteFrontendRelease, readFrontendBuildState, writeFrontendBuildState } from './frontend-build.mjs';

export async function switchPreparedFrontendRelease({ root, expectedBuildId = null, rollbackBuildId = null, startGateway, waitForHealthy, stopGateway }) {
  const paths = getFrontendBuildPaths(root);
  const original = readFrontendBuildState(paths.state);
  if (!original.preparedBuildId) throw new Error('没有准备好的前端 release');
  if (expectedBuildId && original.preparedBuildId !== expectedBuildId) throw new Error('前端预构建身份不一致');
  const nextRelease = path.join(paths.releases, original.preparedBuildId);
  if (!isCompleteFrontendRelease(nextRelease,{requireVersion:true})) throw new Error('准备好的前端 release 不完整');
  const defaultRollbackBuildId = original.preparedBuildId === original.activeBuildId
    ? original.previousBuildId
    : original.activeBuildId;
  const selectedRollbackBuildId = rollbackBuildId
    && rollbackBuildId !== original.preparedBuildId
    && isCompleteFrontendRelease(path.join(paths.releases, rollbackBuildId))
    ? rollbackBuildId
    : defaultRollbackBuildId;
  const switched = {
    ...original,
    activeBuildId: original.preparedBuildId,
    previousBuildId: selectedRollbackBuildId,
    preparedBuildId: null,
  };
  writeFrontendBuildState(paths.state, switched);
  let nextGateway = null;
  try {
    nextGateway = await startGateway(switched.activeBuildId, nextRelease);
    await waitForHealthy(nextGateway, switched.activeBuildId);
    cleanupOldFrontendReleases(root);
    return { status: 'completed', buildId: switched.activeBuildId, gateway: nextGateway };
  } catch (error) {
    if (nextGateway) await stopGateway(nextGateway).catch(() => undefined);
    if (!selectedRollbackBuildId) {
      writeFrontendBuildState(paths.state, original);
      throw error;
    }
    const previousRelease = path.join(paths.releases, selectedRollbackBuildId);
    if (!isCompleteFrontendRelease(previousRelease)) throw error;
    const rollbackState = selectedRollbackBuildId === original.activeBuildId
      ? original
      : {
          ...original,
          activeBuildId: selectedRollbackBuildId,
          previousBuildId: original.activeBuildId,
          preparedBuildId: null,
        };
    writeFrontendBuildState(paths.state, rollbackState);
    const restoredGateway = await startGateway(selectedRollbackBuildId, previousRelease);
    await waitForHealthy(restoredGateway, selectedRollbackBuildId);
    return { status: 'rolled_back', buildId: selectedRollbackBuildId, gateway: restoredGateway, error };
  }
}
