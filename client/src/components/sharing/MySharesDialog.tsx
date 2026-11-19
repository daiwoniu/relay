import { formatDateTime } from '../../utils/date-display.ts';
import { useFeatureView,localAction } from '../../analytics/features';
import { formatMessageCounts } from '../../utils/message-counts';
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
  useFeatureView('share',open,'user_menu');
  const [items, setItems] = useState<ShareListItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
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
    catch (cause) { if (sequence === requestSequence.current) setError(cause instanceof Error ? cause.message : '加载分享失败'); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }, []);

  useEffect(() => { if (open) { setNow(Date.now()); void load(page); } return () => { requestSequence.current += 1; }; }, [load, open, page]);
  useEffect(() => { if (!open) return; const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, [open]);
  useEffect(() => { if (!copiedId) return; const timer = setTimeout(() => setCopiedId(null), 2000); return () => clearTimeout(timer); }, [copiedId]);
  const copyLink = async (item: ShareListItemDto) => {
    const report=localAction('share','copy_link','user_menu');
    const sequence = requestSequence.current;
    try { await copyToClipboard(getShareUrl(item.publicToken));report(true); if (sequence === requestSequence.current) { setCopiedId(item.id); setError(''); } }
    catch {report(false); if (sequence === requestSequence.current) setError('复制失败，请打开分享页面后手动复制地址'); }
  };

  const mutate = async (itemId: string, action: () => Promise<unknown>) => {
    const sequence = requestSequence.current;
    setMutatingId(itemId);
    try { await action(); if (sequence === requestSequence.current) await load(page); }
    catch (cause) { if (sequence === requestSequence.current) setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setMutatingId(null); }
  };

  const pagination = getSharePagination(total, page);

  return (
    <PanelShell analyticsFeature="share" open={open} onClose={onClose} mobile={mobile} title="我的分享" description="管理已创建的只读分享快照" titleId="my-shares-title" size="content" bodyClassName="p-4 sm:p-5" footer={total > SHARE_PAGE_SIZE ? <ListPagination
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
          const presentation = presentShareManagementItem(item, now);
          const scopePresentation = getShareScopePresentation(item.scope);
          const url = getShareUrl(item.publicToken);
          const statusTone = presentation.statusLabel === '已过期'
            ? 'border-[var(--color-status-danger)]/55 bg-[var(--color-status-danger)]/10 text-[var(--color-status-danger)]'
            : item.status === 'revoked'
              ? 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]'
              : presentation.statusLabel === '即将过期'
                ? 'border-[var(--color-status-warning)]/55 bg-[var(--color-status-warning)]/10 text-[var(--color-status-warning)]'
                : 'border-[var(--color-status-success)]/55 bg-[var(--color-status-success)]/10 text-[var(--color-status-success)]';
          return <div key={item.id} className="rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-border)]">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><div className="truncate text-sm font-medium text-[var(--color-text)]">{item.title}</div><span role="status" className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTone}`}>{presentation.statusLabel}</span></div><div className="mt-1 text-xs text-[var(--color-text-secondary)]">{presentation.sourceLabel} · {engineLabel(item.sourceEngine)}</div><div className="mt-1 text-xs text-[var(--color-text-secondary)]">{formatMessageCounts(item.messageCount, item.assistantMessageCount)}</div><div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">创建：{formatDateTime(item.createdAt, { seconds: true })} · 到期：{item.expiresAt === null ? '永久' : formatDateTime(item.expiresAt, { seconds: true })}</div></div><span className="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">{scopePresentation.label}</span></div>
            <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">{item.includeProcess ? '包含处理过程（如有）' : '仅消息正文'}{presentation.canDelete ? ' · 在线链接已失效，已下载的离线副本不受影响' : ''}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              <button type="button" disabled={presentation.canDelete} onClick={() => {const report=localAction('share','open_external','user_menu');try{window.open(url, '_blank', 'noopener,noreferrer');report(true);}catch{report(false);}}} className="min-h-9 rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-40">查看</button>
              <button type="button" disabled={presentation.canDelete} onClick={() => void copyLink(item)} className="min-h-9 rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-40">{copiedId === item.id ? '已复制' : '复制链接'}</button>
              {presentation.canRevoke && <button type="button" disabled={mutatingId !== null} onClick={() => void mutate(item.id, () => revokeShare(item.id))} className="rounded-md border border-[var(--color-status-warning)]/40 px-2 py-1 text-[var(--color-status-warning)] disabled:opacity-40">取消分享</button>}
              {presentation.canDelete && <button type="button" disabled={mutatingId !== null} onClick={() => void mutate(item.id, () => deleteShare(item.id))} className="rounded-md border border-[var(--color-status-danger)]/40 px-2 py-1 text-[var(--color-status-danger)] disabled:opacity-40">删除记录</button>}
            </div>
          </div>;
        })}
      </div>
    </PanelShell>
  );
}
