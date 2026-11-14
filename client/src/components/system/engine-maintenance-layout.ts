import type { EngineId, EngineMaintenanceStatusDto } from '../../generated/relay-contracts.ts';
import { formatEngineMaintenanceVersion, getEngineMaintenancePresentation } from './engine-maintenance-presentation.ts';

export interface EngineMaintenanceSummary {
  label: string;
  statusLabel: string;
  statusTone: ReturnType<typeof getEngineMaintenancePresentation>['statusTone'];
  versionLabel: string;
  activityLabel: string;
  statusMessage: string | null;
}

export function getEngineSummary(engine: EngineMaintenanceStatusDto): EngineMaintenanceSummary {
  const presentation = getEngineMaintenancePresentation(engine);
  const versionLabel = engine.updateAvailable && engine.latestVersion
    ? `${formatEngineMaintenanceVersion(engine.installedVersion)} → ${formatEngineMaintenanceVersion(engine.latestVersion)}`
    : `当前 ${formatEngineMaintenanceVersion(engine.installedVersion)}`;
  const activity = [
    engine.activeTaskCount > 0 ? `${engine.activeTaskCount} 个任务` : null,
    engine.activeInstanceCount > 0 ? `${engine.activeInstanceCount} 个实例` : null,
  ].filter((value): value is string => Boolean(value));
  return {
    label: engine.label,
    statusLabel: presentation.statusLabel,
    statusTone: presentation.statusTone,
    versionLabel,
    activityLabel: activity.length > 0 ? activity.join(' · ') : '无活动任务或实例',
    statusMessage: engine.statusMessage ?? null,
  };
}

export function selectEngineId(
  requested: EngineId | null,
  engines: readonly EngineMaintenanceStatusDto[],
): EngineId | null {
  if (requested && engines.some((engine) => engine.engineId === requested)) return requested;
  return engines[0]?.engineId ?? null;
}
