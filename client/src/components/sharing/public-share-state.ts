import { ApiError } from '../../api/client.ts';
import type { PublicShareResponseDto } from '../../generated/relay-contracts';

export type PublicShareViewState =
  | { type: 'loading' }
  | { type: 'active'; data: Extract<PublicShareResponseDto, { state: 'active' }> }
  | { type: 'expired' | 'revoked' | 'not_found' | 'unreadable' | 'rate_limited' | 'error' };

export function resolvePublicShareViewState(result: PublicShareResponseDto): PublicShareViewState {
  return result.state === 'active' ? { type: 'active', data: result } : { type: result.state };
}

export function resolvePublicShareError(error: unknown): PublicShareViewState {
  if (error instanceof ApiError && error.status === 429) return { type: 'rate_limited' };
  if (error instanceof ApiError && error.status === 404) return { type: 'not_found' };
  return { type: 'error' };
}

export function getPublicShareStateMessage(type: Exclude<PublicShareViewState['type'], 'loading' | 'active'>): string {
  return {
    expired: '这个分享已经过期',
    revoked: '这个分享已被创建者取消',
    not_found: '没有找到这个分享',
    unreadable: '分享内容暂时无法读取',
    rate_limited: '访问过于频繁，请稍后再试',
    error: '暂时无法加载分享',
  }[type];
}
