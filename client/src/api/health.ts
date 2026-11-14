import { requestJson } from './client';

interface HealthResponse {
  status: string;
  name: string;
}

export function checkHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health', { signal, notifyUnauthorized: false });
}
