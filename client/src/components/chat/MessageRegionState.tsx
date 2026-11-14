import type { ChatContentState } from './chat-initialization-state';
import FailureNotice from '../ui/FailureNotice';

export default function MessageRegionState({
  state,
  error,
  onRetry,
}: {
  state: Exclude<ChatContentState, 'ready' | 'empty'>;
  error?: string | null;
  onRetry: () => void;
}) {
  if (state === 'message_error') {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div role="alert" className="max-w-sm rounded-xl border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] p-4 text-center text-sm text-[var(--color-text)]">
          <p><FailureNotice error={error || '消息加载失败'} /></p>
          <button type="button" onClick={onRetry} className="mt-3 rounded-md bg-[var(--color-text)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)]">重新加载消息</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center justify-center px-6" role="status">
      <div className="w-full max-w-xl space-y-4" aria-label={state === 'restoring_location' ? '正在恢复会话位置' : '正在加载消息'}>
        <div className="h-16 animate-pulse rounded-xl bg-[var(--color-bg-secondary)]" />
        <div className="ml-auto h-12 w-3/5 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />
        <div className="h-24 animate-pulse rounded-xl bg-[var(--color-bg-secondary)]" />
      </div>
    </div>
  );
}
