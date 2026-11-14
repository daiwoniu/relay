import { ApiError } from '../api/client.ts';
import type { ServiceRecoveryAction } from '../api/service-recovery.ts';
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
    || (error.status === 409 && error.data?.code === 'RECOVERY_CONFIRMATION_EXPIRED')
  );
}
