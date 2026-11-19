import type {
  CreateShareRequest,
  CreateShareResponseDto,
  OkDto,
  PublicShareResponseDto,
  SharePreviewResponseDto,
  ShareListResponseDto,
} from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export function createShare(request: CreateShareRequest): Promise<CreateShareResponseDto> {
  return requestJson('/api/shares', { analytics:{feature:'share',action:'create',surface:'message_menu'},method: 'POST', ...jsonBody(request) });
}

export function previewShare(request: CreateShareRequest): Promise<SharePreviewResponseDto> {
  return requestJson('/api/shares/preview', { method: 'POST', ...jsonBody(request) });
}

export function listShares(limit = 50, offset = 0): Promise<ShareListResponseDto> {
  return requestJson(`/api/shares?limit=${limit}&offset=${offset}`);
}

export function revokeShare(id: string): Promise<OkDto> {
  return requestJson(`/api/shares/${encodeURIComponent(id)}/revoke`, { analytics:{feature:'share',action:'revoke',surface:'user_menu'},method: 'POST' });
}

export function deleteShare(id: string): Promise<OkDto> {
  return requestJson(`/api/shares/${encodeURIComponent(id)}`, { analytics:{feature:'share',action:'delete',surface:'user_menu'},method: 'DELETE' });
}

export function getPublicShare(token: string, signal?: AbortSignal): Promise<PublicShareResponseDto> {
  return requestJson(`/api/public/shares/${encodeURIComponent(token)}`, {
    signal,
    notifyUnauthorized: false,
  });
}

export function getShareUrl(publicToken: string): string {
  const base = typeof window === 'undefined' ? '' : window.location.origin;
  return `${base}/share/${publicToken}`;
}
