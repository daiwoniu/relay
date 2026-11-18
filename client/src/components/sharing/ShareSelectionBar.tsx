import { formatMessageCounts } from '../../utils/message-counts';

export default function ShareSelectionBar({ count, assistantCount, onCancel, onNext }: { count: number; assistantCount: number; onCancel: () => void; onNext: () => void }) {
  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] px-4 py-3 shadow-[var(--color-overlay-shadow)]">
        <span className="text-sm text-[var(--color-text)]">已选：{formatMessageCounts(count, assistantCount)}</span>
        <div className="ml-auto flex shrink-0 gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">取消</button>
          <button type="button" disabled={count === 0} onClick={onNext} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm text-[var(--theme-on-primary)] disabled:opacity-50">下一步</button>
        </div>
      </div>
    </div>
  );
}
