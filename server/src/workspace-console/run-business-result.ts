import type { WorkspaceRunProjection } from './run-projection.js';

/** Explicit allowlist; never send commands, endpoints or arbitrary nested payloads. */
export function projectRunBusinessResult(raw: Record<string, unknown>, source: 'progress' | 'summary' | 'status'): WorkspaceRunProjection['businessResult'] {
  const string = (key: string) => typeof raw[key] === 'string' && raw[key] ? (raw[key] as string).slice(0, 240) : null;
  const number = (key: string) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0 ? raw[key] as number : null;
  const boolean = (key: string) => typeof raw[key] === 'boolean' ? raw[key] as boolean : null;
  const result = { source, status: string('status'), complete: boolean('complete'), businessWrite: boolean('business_write'),
    stopReason: string('stop_reason'), object: string('table'), rowsPerSecond: number('rows_per_second'), rowLimit: number('row_cap_this_run'),
    limitPercent: number('row_cap_percent'), etaSeconds: number('eta_to_row_cap_seconds'), verified: boolean('verified'), preflightPassed: boolean('preflight_passed'), businessWrites: number('business_writes'), formalSpWrites: number('formal_sp_writes'), phase: string('phase') };
  // A runner status alone is not a business result.
  return (source !== 'status' && result.status !== null) || Object.entries(result).some(([key, value]) => !['source', 'status'].includes(key) && value !== null) ? result : null;
}
