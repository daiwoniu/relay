import FailureNotice from '../ui/FailureNotice';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShareListItemDto } from '../../generated/relay-contracts';
import { deleteShare, getShareUrl, listShares, revokeShare } from '../../api/shares';
import { copyToClipboard } from '../../utils/clipboard';
import PanelShell from '../ui/PanelShell';
import { getSharePagination, presentShareManagementItem, SHARE_PAGE_SIZE } from './share-management';
import { getShareScopePresentation } from './share-scope';
import { engineLabel } from '../../engine/catalog';
import { ListPagination, ListState } from '../ui/ListControls';

export default function MySharesDialog({ open, onClose, mobile = false }: { open: boolean; onClose: () => void; mobile?: boolean }) {
  const [items, setItems] = useState<ShareListItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const hasLoaded = useRef(false);

  const load = useCallback(async (pageIndex: number) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError('');
    try {
      const response = await listShares(SHARE_PAGE_SIZE, pageIndex * SHARE_PAGE_SIZE);
      if (sequence !== requestSequence.current) return;
      const pagination = getSharePagination(response.total, pageIndex);
      setTotal(response.total);
      if (pagination.page !== pageIndex) {
        setPage(pagination.page);
        return;
      }
      hasLoaded.current = true;
      setItems(response.items);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载分享失败'); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }, []);

  useEffect(() => { if (open) void load(page); }, [load, open, page]);

  const mutate = async (itemId: string, action: () => Promise<unknown>) => {
    setMutatingId(itemId);
    try { await action(); await load(page); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setMutatingId(null); }
  };

  const pagination = getSharePagination(total, page);

  return (
    <PanelShell open={open} onClose={onClose} mobile={mobile} title="我的分享" description="管理已创建的只读分享快照" titleId="my-shares-title" size="content" bodyClassName="p-4 sm:p-5" footer={total > SHARE_PAGE_SIZE ? <ListPagination
        start={pagination.start}
        end={pagination.end}
        total={total}
        hasPrevious={pagination.hasPrevious}
        hasNext={pagination.hasNext}
        loading={loading}
        onPrevious={() => setPage((value) => Math.max(0, value - 1))}
        onNext={() => setPage((value) => value + 1)}
      /> : undefined}>
      {error && items.length > 0 && <div role="alert" className="mb-3 rounded-xl border border-[var(--color-status-danger)]/30 bg-[var(--color-danger-hover)] px-3 py-2 text-sm text-[var(--color-status-danger)]"><FailureNotice error={error} /></div>}
      <div className="min-h-28 space-y-2">
        {loading && !hasLoaded.current ? <ListState kind="loading" title="正在加载分享…" compact />
          : error && items.length === 0 ? <ListState kind="error" title="分享加载失败" detail={error} onRetry={() => void load(page)} compact />
            : items.length === 0 ? <ListState kind="empty" title="还没有创建分享" detail="创建的只读分享会显示在这里" compact /> : items.map((item) => {
          const presentation = presentShareManagementItem(item);
          const scopePresentation = getShareScopePresentation(item.scope);
          const url = getShareUrl(item.publicToken);
          const statusTone = item.status === 'expired'
            ? 'border-[var(--color-status-danger)]/55 bg-[var(--color-status-danger)]/10 text-[var(--color-status-danger)]'
            : item.status === 'revoked'
              ? 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]'
              : presentation.statusLabel === '即将过期'
                ? 'border-[var(--color-status-warning)]/55 bg-[var(--color-status-warning)]/10 text-[var(--color-status-warning)]'
                : 'border-[var(--color-status-success)]/55 bg-[var(--color-status-success)]/10 text-[var(--color-status-success)]';
          return <div key={item.id} className="rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-border)]">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><div className="truncate text-sm font-medium text-[var(--color-text)]">{item.title}</div><span role="status" className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTone}`}>{presentation.statusLabel}</span></div><div className="mt-1 text-xs text-[var(--color-text-secondary)]">{presentation.sourceLabel} · {engineLabel(item.sourceEngine)} · {item.messageCount} 条</div><div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">创建：{new Date(item.createdAt).toLocaleString()} · 到期：{item.expiresAt === null ? '永久' : new Date(item.expiresAt).toLocaleString()}</div></div><span className="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">{scopePresentation.label}</span></div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              <button type="button" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} className="rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)]">查看</button>
              <button type="button" onClick={() => void copyToClipboard(url)} className="rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)]">复制链接</button>
              {presentation.canRevoke && <button type="button" disabled={mutatingId !== null} onClick={() => void mutate(item.id, () => revokeShare(item.id))} className="rounded-md border border-[var(--color-status-warning)]/40 px-2 py-1 text-[var(--color-status-warning)] disabled:opacity-40">取消分享</button>}
              {presentation.canDelete && <button type="button" disabled={mutatingId !== null} onClick={() => void mutate(item.id, () => deleteShare(item.id))} className="rounded-md border border-[var(--color-status-danger)]/40 px-2 py-1 text-[var(--color-status-danger)] disabled:opacity-40">删除记录</button>}
            </div>
          </div>;
        })}
      </div>
    </PanelShell>
  );
}
