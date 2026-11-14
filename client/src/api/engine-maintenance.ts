import type { EngineId, EngineMaintenanceAction, EngineMaintenanceOperationDto, EngineMaintenanceResponseDto, EngineMaintenanceStatusDto } from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export const getEngineMaintenance = (signal?: AbortSignal) => requestJson<EngineMaintenanceResponseDto>('/api/system/engine-maintenance', { signal });
export const checkEngineMaintenanceLatest = (engineId: EngineId, signal?: AbortSignal) => requestJson<EngineMaintenanceStatusDto>(`/api/system/engine-maintenance/${engineId}/check`, { method: 'POST', signal });
export const reserveEngineMaintenance = (engineId: EngineId, action: EngineMaintenanceAction, confirmInterrupt = false, signal?: AbortSignal) => requestJson<EngineMaintenanceOperationDto>('/api/system/engine-maintenance/reserve', { method: 'POST', signal, ...jsonBody({ engineId, action, ...(confirmInterrupt ? { confirmInterrupt: true } : {}) }) });
export const confirmEngineMaintenance = (operationId: string, engineId: EngineId, action: EngineMaintenanceAction, signal?: AbortSignal) => requestJson<{ status: 'committed' }>('/api/system/engine-maintenance/confirm', { method: 'POST', signal, keepalive: true, ...jsonBody({ operationId, engineId, action }) });
export const getEngineMaintenanceOperation = (operationId: string, signal?: AbortSignal) => requestJson<EngineMaintenanceOperationDto>(`/api/system/engine-maintenance/operations/${encodeURIComponent(operationId)}`, { signal });
export const abortEngineMaintenanceOperation = (operationId: string, signal?: AbortSignal) => requestJson<{ status: 'aborting' }>(`/api/system/engine-maintenance/operations/${encodeURIComponent(operationId)}/abort`, { method: 'POST', signal });
