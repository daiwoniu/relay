import type { MaintenanceOutputSnapshotDto } from '../generated/relay-contracts.ts';

export interface MaintenanceOutputState {
  snapshot: MaintenanceOutputSnapshotDto | null;
  disconnected: boolean;
}

export const emptyMaintenanceOutputState = (): MaintenanceOutputState => ({ snapshot: null, disconnected: false });

export function receiveMaintenanceOutput(
  current: MaintenanceOutputState,
  snapshot: MaintenanceOutputSnapshotDto | null,
): MaintenanceOutputState {
  return {
    snapshot: snapshot && (!current.snapshot || snapshot.operationId !== current.snapshot.operationId || snapshot.sequence > current.snapshot.sequence)
      ? snapshot
      : current.snapshot,
    disconnected: false,
  };
}

export function disconnectMaintenanceOutput(current: MaintenanceOutputState): MaintenanceOutputState {
  return current.disconnected ? current : { ...current, disconnected: true };
}
