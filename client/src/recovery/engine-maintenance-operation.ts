import { ApiError } from '../api/client.ts';
import type { EngineMaintenanceOperationDto } from '../generated/relay-contracts.ts';

type RememberedMaintenanceOperation = Pick<EngineMaintenanceOperationDto, 'operationId' | 'engineId' | 'action'>;
type MaintenanceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function maintenanceStorageKey(userId: string, engineId: EngineMaintenanceOperationDto['engineId']): string {
  return `relay:engine-maintenance:${userId}:${engineId}`;
}

export function rememberEngineMaintenanceOperation(storage: MaintenanceStorage | undefined, userId: string, operation: RememberedMaintenanceOperation): void {
  if (!storage) return;
  try {
    storage.setItem(maintenanceStorageKey(userId, operation.engineId), JSON.stringify({
      operationId: operation.operationId, engineId: operation.engineId, action: operation.action,
    }));
  } catch {}
}

export function readRememberedEngineMaintenanceOperation(storage: MaintenanceStorage | undefined, userId: string, engineId: EngineMaintenanceOperationDto['engineId']): RememberedMaintenanceOperation | null {
  if (!storage) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(maintenanceStorageKey(userId, engineId)) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const operation = value as Record<string, unknown>;
    if (typeof operation.operationId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(operation.operationId)
      || operation.engineId !== engineId || typeof operation.action !== 'string'
      || !['install', 'restart', 'upgrade', 'upgrade_and_restart', 'recheck'].includes(operation.action)) return null;
    return operation as RememberedMaintenanceOperation;
  } catch { return null; }
}

export function forgetEngineMaintenanceOperation(storage: MaintenanceStorage | undefined, userId: string, engineId: EngineMaintenanceOperationDto['engineId']): void {
  if (!storage) return;
  try { storage.removeItem(maintenanceStorageKey(userId, engineId)); } catch {}
}

export async function recoverRememberedEngineMaintenanceOperation(options: {
  storage: MaintenanceStorage | undefined;
  userId: string;
  engineId: EngineMaintenanceOperationDto['engineId'];
  probe(operationId: string, signal?: AbortSignal): Promise<EngineMaintenanceOperationDto>;
  signal?: AbortSignal;
}): Promise<EngineMaintenanceOperationDto | null> {
  const remembered = readRememberedEngineMaintenanceOperation(options.storage, options.userId, options.engineId);
  if (!remembered) return null;
  try {
    const operation = await options.probe(remembered.operationId, options.signal);
    if (operation.engineId === remembered.engineId && operation.action === remembered.action) return operation;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 404) throw error;
  }
  forgetEngineMaintenanceOperation(options.storage, options.userId, options.engineId);
  return null;
}

export async function pollEngineMaintenanceOperation(options: {
  probe(signal?: AbortSignal): Promise<EngineMaintenanceOperationDto>;
  signal?: AbortSignal;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  onOperation?: (operation: EngineMaintenanceOperationDto) => void;
  onDisconnected?: () => void;
}): Promise<EngineMaintenanceOperationDto | null> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)));
  const intervalMs = options.intervalMs ?? 750;
  const deadline = now() + (options.timeoutMs ?? 180_000);
  while (now() < deadline) {
    options.signal?.throwIfAborted();
    try {
      const operation = await options.probe(options.signal);
      options.onOperation?.(operation);
      if (operation.status === 'completed' || operation.status === 'failed') return operation;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
      options.onDisconnected?.();
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(intervalMs, remaining));
  }
  return null;
}
