import type { EngineConcurrencyDto } from '../../generated/relay-contracts.ts';

export function getEngineConcurrencyPresentation(item: EngineConcurrencyDto, now = Date.now()) {
  const coolingDown = item.cooldownUntil !== null && item.cooldownUntil > now;
  return {
    queueLabel: item.queuedTurns > 0 ? `${item.queuedTurns} 个排队` : '无排队',
    availabilityLabel: coolingDown ? '冷却中' : item.probeInProgress ? '正在探测恢复' : '可调度',
    tone: coolingDown ? 'warning' : 'normal',
  };
}

export function isConcurrencyControlDisabled(role: 'admin' | 'member' | undefined, resourceKey: string, savingResourceKeys: readonly string[]) {
  return role !== 'admin' || savingResourceKeys.includes(resourceKey);
}
