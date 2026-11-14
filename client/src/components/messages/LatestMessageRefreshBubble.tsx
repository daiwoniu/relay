import type { LatestMessageRefreshStatus } from '../chat/latest-message-refresh';

interface Props {
  status: Exclude<LatestMessageRefreshStatus, 'idle'>;
  onRetry?: () => void;
}

export default function LatestMessageRefreshBubble({ status, onRetry }: Props) {
  const loading = status === 'loading';
  return (
    <div className="message-inline-feedback message-inline-feedback--refresh flex justify-start" role="status" aria-live="polite">
      <div className={`message-bubble assistant-message assistant-message--${loading ? 'processing' : 'warning'} w-full`}>
        <div className="assistant-message__status">
          <div className="inline-flex flex-wrap items-center gap-1.5">
            <span className={`assistant-message__status-icon ${loading ? 'animate-spin' : ''}`} aria-hidden="true">
              {loading ? '◌' : '!'}
            </span>
            <span className="font-medium">
              {loading ? '正在加载最新消息…' : '暂时无法加载最新消息'}
            </span>
          </div>
        </div>
        {!loading && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="message-inline-feedback__action mt-2"
          >
            重新加载
          </button>
        )}
      </div>
    </div>
  );
}
