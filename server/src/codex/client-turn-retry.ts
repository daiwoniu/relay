const TURN_START_OVERLOAD_BACKOFF_MS = [500, 1_000, 2_000] as const;
const TURN_START_RATE_LIMIT_MAX_RETRY_AFTER_MS = 30_000;

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number | null,
    readonly rpcData: unknown,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

function findNumericField(value: unknown, names: Set<string>, depth = 0): number | null {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) && typeof child === 'number' && Number.isFinite(child) && child >= 0) return child;
  }
  for (const child of Object.values(value)) {
    const found = findNumericField(child, names, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function extractRetryAfterMs(value: unknown): number | null {
  const milliseconds = findNumericField(value, new Set(['retryAfterMs', 'retry_after_ms']));
  if (milliseconds !== null) return milliseconds;
  const seconds = findNumericField(value, new Set(['retryAfter', 'retry_after']));
  return seconds === null ? null : seconds * 1_000;
}

export function getFinalTurnStartCapacityFailure(error: unknown): { code: 'CODEX_USAGE_LIMIT_EXCEEDED' | 'CODEX_SERVER_OVERLOADED'; retryAfterMs?: number } | null {
  if (!(error instanceof CodexRpcError)) return null;
  const httpStatus = findNumericField(error.rpcData, new Set(['httpStatusCode', 'http_status_code', 'statusCode']));
  if (httpStatus === 429 || error.rpcCode === 429) {
    const retryAfterMs = extractRetryAfterMs(error.rpcData);
    return { code: 'CODEX_USAGE_LIMIT_EXCEEDED', ...(retryAfterMs !== null ? { retryAfterMs: Math.min(Math.trunc(retryAfterMs), 3_600_000) } : {}) };
  }
  return error.rpcCode === -32001 ? { code: 'CODEX_SERVER_OVERLOADED' } : null;
}

export function jitterDelay(delayMs: number, random: () => number): number {
  const boundedRandom = Math.min(1, Math.max(0, random()));
  return Math.max(0, Math.round(delayMs * (0.8 + boundedRandom * 0.4)));
}

export function getTurnStartRetryDelay(
  error: unknown,
  retryCount: number,
  random: () => number,
): { delayMs: number; reason: 'server_overloaded' | 'rate_limited'; httpStatus: number | null } | null {
  if (!(error instanceof CodexRpcError)) return null;
  const httpStatus = findNumericField(error.rpcData, new Set(['httpStatusCode', 'http_status_code', 'statusCode']));
  if (httpStatus === 429 || error.rpcCode === 429) {
    if (retryCount >= 2) return null;
    const retryAfterMs = extractRetryAfterMs(error.rpcData);
    if (retryAfterMs !== null && retryAfterMs > TURN_START_RATE_LIMIT_MAX_RETRY_AFTER_MS) return null;
    return {
      delayMs: retryAfterMs ?? jitterDelay(TURN_START_OVERLOAD_BACKOFF_MS[retryCount], random),
      reason: 'rate_limited',
      httpStatus,
    };
  }
  if (error.rpcCode !== -32001 || retryCount >= TURN_START_OVERLOAD_BACKOFF_MS.length) return null;
  return {
    delayMs: jitterDelay(TURN_START_OVERLOAD_BACKOFF_MS[retryCount], random),
    reason: 'server_overloaded',
    httpStatus,
  };
}
