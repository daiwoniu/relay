export type EngineDiagnosticPhase =
  | 'availability'
  | 'connect'
  | 'protocol'
  | 'session'
  | 'send'
  | 'stream'
  | 'interaction'
  | 'cancel'
  | 'recovery'
  | 'close'
  | 'provider';

export interface EngineDiagnosticContext {
  phase: EngineDiagnosticPhase;
}

export interface EngineDiagnostic {
  code?: string;
  phase: EngineDiagnosticPhase;
  retryable: boolean;
  userMessage: string;
  originalMessage?: string;
  technicalSummary?: string;
  retryAfterMs?: number;
  providerClass?: 'auth' | 'rate_limit' | 'overloaded' | 'unavailable' | 'unknown';
}

export interface EngineCapacityObservation {
  type: 'request_retry' | 'completion_retry';
}

export function getTerminalCapacityFailure(diagnostic: EngineDiagnostic): { retryAfterMs: number | null } | null {
  if (diagnostic.providerClass !== 'rate_limit' && diagnostic.providerClass !== 'overloaded') return null;
  return { retryAfterMs: diagnostic.retryAfterMs ?? null };
}

const MAX_TECHNICAL_SUMMARY_LENGTH = 500;
export const MAX_ENGINE_ERROR_MESSAGE_LENGTH = 16_384;
const ENGINE_ERROR_TRUNCATION_MARKER = '\n[原始异常过长，已安全截断]';
const STABLE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,199}$/;
const SENSITIVE_FIELD_NAME = /(?:authorization|set[_-]?cookie|cookie|credential|password|passphrase|secret|session[_-]?token|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i;
const SENSITIVE_TEXT_FIELD = '(?:authorization|set[_-]?cookie|cookie|credential|password|passphrase|secret|session[_-]?token|token|api[_-]?key|access[_-]?key|private[_-]?key)';

function sanitizeText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(/(authorization["']?\s*[:=]\s*)(?:["'](?:Bearer|Basic)\s+[^"']*["']|(?:Bearer|Basic)\s+[^\r\n,;]+)/gi, '$1[REDACTED]')
    .replace(/(cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(new RegExp(`(["']?${SENSITIVE_TEXT_FIELD}["']?\\s*[:=]\\s*)(?:["'][^"']*["']|(?:Bearer\\s+)?[^\\s,;&]+)`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`(${SENSITIVE_TEXT_FIELD})\\s*[:=]\\s*[^\\s,;&]+`, 'gi'), '$1=[REDACTED]')
    .replace(new RegExp(`([?&]${SENSITIVE_TEXT_FIELD}=)[^&#\\s]+`, 'gi'), '$1[REDACTED]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\\\\[^\\\s]+\\[^\s,;]+/g, '[PATH]')
    .replace(/[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/g, '[PATH]')
    .replace(/\/(?:Users|home|var|etc|opt|tmp)\/[^\s]*/g, '[PATH]');
}

export function sanitizeEngineErrorMessage(value: string): string {
  const withoutTerminalControls = value
    .replace(/\x1B\][^\r\n]*(?:\x07|\x1B\\)?/g, '')
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  const trimmed = withoutTerminalControls.trim();
  if (trimmed.length <= MAX_ENGINE_ERROR_MESSAGE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_ENGINE_ERROR_MESSAGE_LENGTH - ENGINE_ERROR_TRUNCATION_MARKER.length)}${ENGINE_ERROR_TRUNCATION_MARKER}`;
}

/** Local preparation exceptions may contain host paths and credentials; preserve useful text only. */
export function sanitizeLocalErrorMessage(value: string): string {
  return sanitizeEngineErrorMessage(sanitizeText(sanitizeEngineErrorMessage(value)));
}

function sanitizeStructuredValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Error) return `${value.name}: ${sanitizeEngineErrorMessage(value.message)}`;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeStructuredValue(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_FIELD_NAME.test(key) ? '[REDACTED]' : sanitizeStructuredValue(entry, seen),
  ]));
}

function stringifyError(error: unknown): string {
  if (typeof error === 'string') return sanitizeText(error);
  try {
    const sanitized = sanitizeStructuredValue(error, new WeakSet());
    const serialized = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
    return typeof serialized === 'string' ? serialized : sanitizeText(String(error));
  } catch {
    return sanitizeText(String(error));
  }
}

export function sanitizeTechnicalSummary(error: unknown): string | undefined {
  const raw = stringifyError(error).trim();
  if (!raw) return undefined;
  const sanitized = sanitizeText(raw);
  return sanitized.length > MAX_TECHNICAL_SUMMARY_LENGTH
    ? `${sanitized.slice(0, MAX_TECHNICAL_SUMMARY_LENGTH - 1)}…`
    : sanitized;
}

export function isSafeEngineDiagnosticCode(value: unknown): value is string {
  return typeof value === 'string' && STABLE_DIAGNOSTIC_CODE.test(value);
}
