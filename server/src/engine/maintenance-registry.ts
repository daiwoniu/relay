import type { EngineId, EngineMaintenanceResponseDto, EngineMaintenanceStatusDto } from '../contracts/index.js';
import { EngineMaintenanceError, type EngineMaintenanceAdapter } from './maintenance.js';

export class EngineMaintenanceRegistry {
  private readonly adapters = new Map<EngineId, EngineMaintenanceAdapter>();

  constructor(adapters: readonly EngineMaintenanceAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) {
        throw new EngineMaintenanceError('ENGINE_MAINTENANCE_DUPLICATE', `引擎维护适配器重复：${adapter.id}`);
      }
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(engineId: EngineId): EngineMaintenanceAdapter {
    const adapter = this.adapters.get(engineId);
    if (!adapter) throw new EngineMaintenanceError('ENGINE_MAINTENANCE_NOT_FOUND', `未注册引擎维护适配器：${engineId}`);
    return adapter;
  }

  async getSnapshot(): Promise<EngineMaintenanceResponseDto> {
    const engines = await Promise.all([...this.adapters.values()].map(async (adapter) => {
      try {
        return await adapter.getStatus();
      } catch {
        return unavailableStatus(adapter.id);
      }
    }));
    return { engines };
  }

  async checkLatest(engineId: EngineId): Promise<EngineMaintenanceStatusDto> {
    const adapter = this.get(engineId);
    try {
      return await adapter.checkLatest();
    } catch {
      try {
        const current = await adapter.getStatus();
        return {
          ...current,
          latestCheckStatus: 'error',
          statusMessage: '最新版本检查失败，请稍后重试',
          actions: current.actions.map((action) => ({ ...action, enabled: false, reason: '最新版本检查失败，请稍后重试' })),
        };
      } catch {
        return unavailableStatus(engineId);
      }
    }
  }
}

function unavailableStatus(engineId: EngineId): EngineMaintenanceStatusDto {
  const labels: Record<EngineId, string> = {
    codex: 'Codex',
    codebuddy: 'CodeBuddy',
    opencode: 'OpenCode',
    zcode: 'ZCode',
  };
  return {
    engineId,
    label: labels[engineId],
    installedVersion: null,
    installedAt: null,
    runningVersion: null,
    latestVersion: null,
    releaseOverview: null,
    releasePublishedAt: null,
    updateAvailable: null,
    latestCheckStatus: 'error',
    latestCheckedAt: null,
    installSource: 'unknown',
    activeTaskCount: 0,
    activeInstanceCount: 0,
    instanceVersions: [],
    readiness: 'unknown',
    readinessCheckedAt: null,
    availabilityStage: 'readiness_failed',
    statusMessage: '引擎状态暂时无法读取，请稍后重试',
    loginCommand: null,
    recommendedAction: null,
    actions: [],
  };
}
