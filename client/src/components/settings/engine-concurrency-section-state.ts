import type { EngineConcurrencyDto, EngineId } from '../../generated/relay-contracts.ts';

export function filterEngineConcurrencyItems(
  itemsByResourceKey: Record<string, EngineConcurrencyDto>,
  engineId: EngineId,
): EngineConcurrencyDto[] {
  return Object.values(itemsByResourceKey)
    .filter((item) => item.engineId === engineId)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getNextCooldownRefreshDelay(
  items: readonly EngineConcurrencyDto[],
  displayedNow: number,
  actualNow = displayedNow,
): number | null {
  const nextDeadline = items.reduce<number | null>((nearest, item) => {
    if (item.cooldownUntil === null || item.cooldownUntil <= displayedNow) return nearest;
    return nearest === null ? item.cooldownUntil : Math.min(nearest, item.cooldownUntil);
  }, null);
  return nextDeadline === null ? null : Math.max(1, nextDeadline - actualNow + 1);
}

export function validateMaxActiveTurns(rawValue: string): { value: number | null; error: string | null } {
  if (rawValue.trim() === '') return { value: null, error: '请输入 1–32 的整数' };
  const value = Number(rawValue);
  return Number.isInteger(value) && value >= 1 && value <= 32
    ? { value, error: null }
    : { value: null, error: '请输入 1–32 的整数' };
}

export async function persistEngineConcurrencySetting(
  resourceKey: string,
  rawValue: string,
  update: (resourceKey: string, maxActiveTurns: number) => Promise<EngineConcurrencyDto>,
): Promise<{ item: EngineConcurrencyDto | null; error: string | null }> {
  const validation = validateMaxActiveTurns(rawValue);
  if (validation.error || validation.value === null) return { item: null, error: validation.error };
  try {
    return { item: await update(resourceKey, validation.value), error: null };
  } catch (reason) {
    return { item: null, error: reason instanceof Error ? reason.message : '保存失败' };
  }
}
