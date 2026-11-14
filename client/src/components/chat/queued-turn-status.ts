import type { TurnQueueSnapshotDto } from '../../generated/relay-contracts.ts';

export function resolveQueuedTurnUiState(
  queue: TurnQueueSnapshotDto | null,
  sessionStatusQueued: boolean,
  options: { probeInProgress?: boolean; now?: number } = {},
): { isQueued: boolean; isWaiting: boolean } {
  if (!queue) return { isQueued: sessionStatusQueued, isWaiting: false };
  if (queue.state !== 'queued') return { isQueued: false, isWaiting: false };
  const availableSlots = Math.max(0, queue.maxActiveTurns - queue.activeTurns);
  const waitingForCapacity = queue.position !== null && queue.position > availableSlots;
  const waitingForCooldown = queue.cooldownUntil !== null
    && queue.cooldownUntil > (options.now ?? Date.now());
  return {
    isQueued: true,
    isWaiting: waitingForCapacity || waitingForCooldown || Boolean(options.probeInProgress),
  };
}
