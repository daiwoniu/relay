import type { EngineId, EngineStatusDto } from '../../generated/relay-contracts';

export function resolveDefaultEngine(
  preferred: EngineId,
  statuses: EngineStatusDto[],
): { engine: EngineId | null; fallback: boolean } {
  if (statuses.some((status) => status.id === preferred && status.available)) {
    return { engine: preferred, fallback: false };
  }
  const engine = statuses.find((status) => status.available)?.id ?? null;
  return { engine, fallback: engine !== null && engine !== preferred };
}
