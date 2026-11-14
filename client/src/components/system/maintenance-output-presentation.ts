import type { MaintenanceOutputSnapshotDto } from '../../generated/relay-contracts.ts';

export function getMaintenanceOutputRows(snapshot: MaintenanceOutputSnapshotDto | null): [string | null, string | null] {
  const lines = snapshot?.lines.slice(-2) ?? [];
  if (lines.length === 0) return ['等待命令输出…', null];
  if (lines.length === 1) return [null, lines[0]];
  return [lines[0], lines[1]];
}
