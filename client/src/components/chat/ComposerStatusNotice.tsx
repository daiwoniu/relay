import Tooltip from '../ui/Tooltip';
import { useEffect, useState } from 'react';
import type { ComposerStatusNoticeValue } from './composer-status-notice';
import DetailsDialog from '../layout/DetailsDialog';
import FailureNotice from '../ui/FailureNotice';

const TONE_CLASS = {
  info: 'border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] text-[var(--color-text-secondary)]',
  processing: 'border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] text-[var(--color-text-secondary)]',
  warning: 'border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] text-[var(--color-text)]',
  danger: 'border-[var(--color-status-danger)]/30 bg-[var(--color-danger-hover)] text-[var(--color-danger-text)]',
} as const;

export default function ComposerStatusNotice({ scopeKey, notice, notices }: { scopeKey: string; notice: ComposerStatusNoticeValue | null; notices: ComposerStatusNoticeValue[] }) {
  const [dismissed, setDismissed] = useState(false);
  const [openedNotices, setOpenedNotices] = useState<ComposerStatusNoticeValue[] | null>(null);

  useEffect(() => setDismissed(false), [notice?.id, scopeKey]);

  const openDetails = () => setOpenedNotices([...notices]);

  return (
    <>
      {notice && !dismissed && <div role={notice.tone === 'danger' ? 'alert' : 'status'} className={`mb-2 flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${TONE_CLASS[notice.tone]}`}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden="true" />
        <Tooltip overflowOnly content={notice.message} asChild><button type="button" onClick={openDetails} aria-label={`查看完整提示：${notice.message}`} className="min-w-0 flex-1 truncate rounded-sm text-left leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">{notice.message}</button></Tooltip>
        {notices.length > 1 && <button type="button" onClick={openDetails} className="shrink-0 rounded-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]" aria-label={`查看全部 ${notices.length} 条提示`}>另有 {notices.length - 1} 条</button>}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="关闭当前提示"
          className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-70 transition-opacity hover:bg-[var(--color-surface-hover)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>}
      <DetailsDialog open={openedNotices !== null} onClose={() => setOpenedNotices(null)} title={openedNotices && openedNotices.length > 1 ? `提示详情（${openedNotices.length} 条）` : '提示详情'}>
        <div className="space-y-4">
          {(openedNotices ?? []).map((item) => (
            <section key={item.id} className="space-y-2 rounded-lg border border-[var(--color-border)] p-3">
              {item.tone === 'danger' ? <FailureNotice error={item.message} description={item.reason} suggestion={item.nextStep} /> : <>
                <p className="whitespace-pre-wrap break-words text-sm font-medium leading-6 text-[var(--color-text)]">{item.message}</p>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-text-secondary)]"><span className="font-medium text-[var(--color-text)]">原因：</span>{item.reason}</p>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-text-secondary)]"><span className="font-medium text-[var(--color-text)]">下一步：</span>{item.nextStep}</p>
              </>}
            </section>
          ))}
        </div>
      </DetailsDialog>
    </>
  );
}
