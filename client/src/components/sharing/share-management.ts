import type { ShareListItemDto } from '../../generated/relay-contracts';
import { getShareStatusLabel } from './share-expiry.ts';

export const SHARE_PAGE_SIZE = 20;

export function getSharePagination(total: number, requestedPage: number, pageSize = SHARE_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const offset = page * pageSize;
  return {
    page,
    pageCount,
    offset,
    start: total === 0 ? 0 : offset + 1,
    end: Math.min(total, offset + pageSize),
    hasPrevious: page > 0,
    hasNext: page + 1 < pageCount,
  };
}

export function presentShareManagementItem(item: ShareListItemDto, now = Date.now()) {
  const status = item.status === 'active' && item.expiresAt !== null && item.expiresAt <= now ? 'expired' : item.status;
  return {
    statusLabel: getShareStatusLabel(status, item.expiresAt, now),
    sourceLabel: item.sourceState === 'unavailable' ? '来源不可访问' : item.sourceState === 'deleted' || item.sourceSessionId === null ? '来源已删除' : item.sourceSessionTitle || '来源不可访问或标题未记录',
    canRevoke: status === 'active',
    canDelete: status === 'expired' || status === 'revoked',
  };
}
