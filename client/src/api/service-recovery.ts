import { jsonBody, requestJson } from './client';
import type { MaintenanceOutputSnapshotDto } from '../generated/relay-contracts.ts';

export type ServiceRecoveryAction = 'auto' | 'restart_backend' | 'restart_frontend' | 'restart_relay' | 'repair_environment';
export type ServiceRecoveryTarget = 'backend' | 'frontend' | 'relay' | 'setup';
export type SetupOperation = { operationId: string; status: 'accepted' | 'running' | 'completed' | 'failed'; phase: 'reserved' | 'checking' | 'server_dependencies' | 'client_dependencies' | 'verifying' | 'completed' | 'failed'; reason: 'setup_failed' | 'status_unavailable' | null; startedAt: number | null; completedAt: number | null };

export interface RecoveryCapabilities {
  serverProtocolVersion: number;
  backendStartedAt: number | null;
  managedByLauncher: boolean;
  launcherControlVersion: number | null;
  requiredLauncherControlVersion: number;
  launcherCompatible: boolean;
  canRestartRelay: boolean;
  canRestartBackend: boolean;
  canRestartFrontend: boolean;
  canRepairEnvironment: boolean;
  activeTaskCount: number;
  operationInProgress: boolean;
  backendRetryAfterMs: number;
  frontendRetryAfterMs: number;
  frontendMode: 'production' | 'development' | 'unknown';
  activeBuildId: string | null;
  activeBuildLabel: string | null;
  frontendBuildRequired: boolean;
  frontendBuildReason: string | null;
  setup: {
    required: boolean;
    blockedByConflicts: boolean;
    server: { needed: boolean; reason: string };
    client: { needed: boolean; reason: string };
  };
  setupOperation: SetupOperation | null;
}

export interface FrontendStatus {
  startedAt: number;
  mode: 'production' | 'development';
  buildId: string | null;
  buildLabel: string | null;
}

export type RecoveryResponse =
  | { status: 'accepted'; operationId: string; target: ServiceRecoveryTarget; serverProtocolVersion: number }
  | { status: 'reload_required'; serverProtocolVersion: number }
  | { status: 'retry_connection'; serverProtocolVersion: number };

export async function getRecoveryCapabilities(signal?: AbortSignal): Promise<RecoveryCapabilities> {
  const value = await requestJson<Partial<RecoveryCapabilities>>('/api/system/recovery-capabilities', { signal });
  return {
    serverProtocolVersion: Number(value.serverProtocolVersion || 0),
    backendStartedAt: value.backendStartedAt ?? null,
    managedByLauncher: value.managedByLauncher === true,
    launcherControlVersion: Number.isSafeInteger(value.launcherControlVersion) ? Number(value.launcherControlVersion) : null,
    requiredLauncherControlVersion: Number(value.requiredLauncherControlVersion || 5),
    launcherCompatible: value.launcherCompatible === true,
    canRestartRelay: value.canRestartRelay === true,
    canRestartBackend: value.canRestartBackend === true,
    canRestartFrontend: value.canRestartFrontend === true,
    canRepairEnvironment: value.canRepairEnvironment === true,
    activeTaskCount: Number(value.activeTaskCount || 0),
    operationInProgress: value.operationInProgress === true,
    backendRetryAfterMs: Number(value.backendRetryAfterMs || 0),
    frontendRetryAfterMs: Number(value.frontendRetryAfterMs || 0),
    frontendMode: value.frontendMode === 'production' || value.frontendMode === 'development' ? value.frontendMode : 'unknown',
    activeBuildId: typeof value.activeBuildId === 'string' ? value.activeBuildId : null,
    activeBuildLabel: typeof value.activeBuildLabel === 'string' ? value.activeBuildLabel : null,
    frontendBuildRequired: value.frontendBuildRequired === true,
    frontendBuildReason: typeof value.frontendBuildReason === 'string' ? value.frontendBuildReason : null,
    setup: value.setup ?? {
      required: false,
      blockedByConflicts: false,
      server: { needed: false, reason: '旧后端未提供初始化检测' },
      client: { needed: false, reason: '旧后端未提供初始化检测' },
    },
    setupOperation: value.setupOperation ?? null,
  };
}

export function getFrontendStatus(signal?: AbortSignal): Promise<FrontendStatus> {
  return requestJson('/__relay/frontend-status', { signal, notifyUnauthorized: false });
}

export function getServiceRecoveryOperationOutput(operationId: string, signal?: AbortSignal): Promise<MaintenanceOutputSnapshotDto | null> {
  return requestJson(`/api/system/recovery-operations/${encodeURIComponent(operationId)}/output`, { signal });
}

export function requestServiceRecovery(
  action: ServiceRecoveryAction,
  clientProtocolVersion: number,
  signal?: AbortSignal,
  confirmActiveTasks = false,
): Promise<RecoveryResponse> {
  return requestJson('/api/system/recover', {
    method: 'POST',
    signal,
    ...jsonBody({
      action,
      clientProtocolVersion,
      ...(confirmActiveTasks ? { confirmActiveTasks: true } : {}),
    }),
  });
}

export function confirmServiceRecovery(
  operationId: string,
  target: ServiceRecoveryTarget,
  signal?: AbortSignal,
): Promise<{ status: 'committed' }> {
  return requestJson('/api/system/recover/confirm', {
    method: 'POST',
    signal,
    keepalive: true,
    ...jsonBody({ operationId, target }),
  });
}
