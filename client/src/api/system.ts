import type { CodexVersionDto, EngineId, EngineStatusResponseDto, SystemResourceStatusDto } from '../generated/relay-contracts';
import { requestJson } from './client';
import { confirmEngineMaintenance, getEngineMaintenanceOperation, reserveEngineMaintenance } from './engine-maintenance';
import { pollEngineMaintenanceOperation } from '../recovery/engine-maintenance-operation';

export function getCodexVersion(): Promise<CodexVersionDto> {
  return requestJson('/api/system/codex-version');
}

export function checkCodexVersion(): Promise<CodexVersionDto> {
  return requestJson('/api/system/codex-version/check', { method: 'POST' });
}

export function getEngineStatuses(): Promise<EngineStatusResponseDto> {
  return requestJson('/api/system/engines');
}

export function getSystemResourceStatus(signal?: AbortSignal): Promise<SystemResourceStatusDto> {
  return requestJson('/api/system/resources', { signal, cache: 'no-store' });
}

export async function recheckEngineReadiness(engineId: EngineId): Promise<EngineStatusResponseDto> {
  const operation = await reserveEngineMaintenance(engineId, 'recheck');
  await confirmEngineMaintenance(operation.operationId, engineId, 'recheck');
  const terminal = await pollEngineMaintenanceOperation({
    probe: (signal) => getEngineMaintenanceOperation(operation.operationId, signal),
  });
  if (!terminal) throw new Error('检测超时，请稍后重试');
  if (terminal.status !== 'completed') throw new Error(terminal.message);
  return getEngineStatuses();
}

export async function recheckCodeBuddyReadiness(): Promise<EngineStatusResponseDto> {
  return recheckEngineReadiness('codebuddy');
}
