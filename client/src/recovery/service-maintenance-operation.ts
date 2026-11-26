import { ApiError } from '../api/client.ts';
import type { ServiceRecoveryAction } from '../api/service-recovery.ts';
import type { MaintenanceOutputSnapshotDto } from '../generated/relay-contracts.ts';
import type { ServiceMaintenanceAction } from './service-maintenance-policy.ts';

export function toRecoveryRequestAction(action: ServiceMaintenanceAction): ServiceRecoveryAction | null {
  if (action === 'restart_backend') return 'restart_backend';
  if (action === 'restart_frontend') return 'restart_frontend';
  if (action === 'restart_relay') return 'restart_relay';
  if (action === 'repair_environment') return 'repair_environment';
  return null;
}

export function canIgnoreRecoveryConfirmationError(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 0
    || error.status === 502
    || error.status === 503
    || error.status === 504
    // A restart can interrupt the response body after successful headers arrive.
    // Its outcome must be established by observing a new instance, not by retrying.
    || (error.status >= 200 && error.status < 300 && error.data === null)
    || (error.status === 409 && error.data?.code === 'RECOVERY_CONFIRMATION_EXPIRED')
  );
}

export function hasCompletedFrontendRestart(
  status: MaintenanceOutputSnapshotDto['status'] | null,
  frontendChanged: boolean,
  frontendBuildRequired: boolean,
): boolean {
  // Older launchers may not expose operation output. Require a new instance
  // and a fresh build before inferring success without an operation result.
  return status === null ? frontendChanged && !frontendBuildRequired : status === 'completed';
}
