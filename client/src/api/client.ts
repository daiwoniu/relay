import type { ApiErrorDto } from '../generated/relay-contracts';
import { generateUUID } from '../utils/uuid.ts';

export const AUTH_REQUIRED_EVENT = 'relay:auth-required';

export class ApiError extends Error {
  readonly status: number;
  readonly data: ApiErrorDto | null;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, data: ApiErrorDto | null, message?: string, retryAfterSeconds: number | null = null) {
    super(message || data?.error || `请求失败（${status || '网络错误'}）`);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface RequestOptions extends RequestInit {
  notifyUnauthorized?: boolean;
  timeoutMs?: number;
}

interface RequestLifecycle {
  signal?: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

function createRequestLifecycle(signal?: AbortSignal | null, timeoutMs?: number): RequestLifecycle {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal: signal ?? undefined, timedOut: () => false, cleanup: () => undefined };
  }

  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function parseApiErrorDto(value: unknown): ApiErrorDto | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload.error !== 'string' || !payload.error.trim()) return null;
  return {
    error: payload.error.trim(),
    ...(typeof payload.code === 'string' ? { code: payload.code } : {}),
    ...(typeof payload.canForceAccess === 'boolean' ? { canForceAccess: payload.canForceAccess } : {}),
    ...(payload.projectInTrash && typeof payload.projectInTrash === 'object' && (() => {
      const project = payload.projectInTrash as Record<string, unknown>;
      return typeof project.id === 'string' && typeof project.name === 'string'
        && typeof project.sessionCount === 'number' && Number.isInteger(project.sessionCount) && project.sessionCount >= 0;
    })() ? { projectInTrash: {
      id: String((payload.projectInTrash as Record<string, unknown>).id),
      name: String((payload.projectInTrash as Record<string, unknown>).name),
      sessionCount: Number((payload.projectInTrash as Record<string, unknown>).sessionCount),
    } } : {}),
  };
}

function notifyAuthRequired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
}

export async function parseApiResponse<T>(
  response: Response,
  options: { notifyUnauthorized?: boolean } = {},
): Promise<T> {
  const data = await readJson(response);
  if (response.status === 401 && options.notifyUnauthorized !== false) notifyAuthRequired();
  if (!response.ok) {
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfterSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
      ? Math.max(1, Number.parseInt(retryAfterHeader, 10))
      : null;
    throw new ApiError(response.status, parseApiErrorDto(data), undefined, retryAfterSeconds);
  }
  if (data === null) throw new ApiError(response.status, null, '服务端返回了无效数据');
  return data as T;
}

export async function requestJson<T>(input: RequestInfo | URL, options: RequestOptions = {}): Promise<T> {
  const { notifyUnauthorized, timeoutMs, signal, ...requestOptions } = options;
  const method = (requestOptions.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const headers = new Headers(requestOptions.headers ?? (input instanceof Request ? input.headers : undefined));
    // Native mutation routes require an operation identity; preserve an explicit key for retries.
    if (!headers.has('x-relay-operation-id')) headers.set('x-relay-operation-id', generateUUID());
    requestOptions.headers = headers;
  }
  const lifecycle = createRequestLifecycle(signal, timeoutMs);
  try {
    const response = await fetch(input, {
      credentials: 'same-origin',
      ...requestOptions,
      signal: lifecycle.signal,
    });
    return await parseApiResponse<T>(response, { notifyUnauthorized });
  } catch (error) {
    if (lifecycle.timedOut()) throw new ApiError(0, null, '请求超时，请重试');
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError(0, null, error instanceof Error ? error.message : '无法连接 Relay');
  } finally {
    lifecycle.cleanup();
  }
}

export async function requestBlob(input: RequestInfo | URL, options: RequestOptions = {}): Promise<Blob> {
  const { notifyUnauthorized, timeoutMs, signal, ...requestOptions } = options;
  const lifecycle = createRequestLifecycle(signal, timeoutMs);
  try {
    const response = await fetch(input, {
      credentials: 'same-origin',
      ...requestOptions,
      signal: lifecycle.signal,
    });
    if (response.status === 401 && notifyUnauthorized !== false) notifyAuthRequired();
    if (!response.ok) {
      const data = await readJson(response);
      throw new ApiError(response.status, parseApiErrorDto(data));
    }
    return await response.blob();
  } catch (error) {
    if (lifecycle.timedOut()) throw new ApiError(0, null, '请求超时，请重试');
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError(0, null, error instanceof Error ? error.message : '无法连接 Relay');
  } finally {
    lifecycle.cleanup();
  }
}

export function jsonBody(value: unknown): Pick<RequestInit, 'headers' | 'body'> {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}
