import { useState } from 'react';
import type { Message } from '../../stores/chat';
import ProcessSteps from './ProcessSteps';

export default function HistoricalOperationRecord({ message, onLoadDetails, searchTarget = false,
  searchTargetScope, searchTargetItemId }: {
  message: Message;
  onLoadDetails?: (messageId: string) => Promise<void>;
  searchTarget?: boolean;
  searchTargetScope?: 'message' | 'process' | 'operation';
  searchTargetItemId?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = async () => {
    if (!onLoadDetails || loading) return;
    setLoading(true); setFailed(false);
    try { await onLoadDetails(message.id); } catch { setFailed(true); }
    finally { setLoading(false); }
  };
  return <details data-message-id={message.id} open={searchTarget || undefined}
    className={`rounded-lg border border-[var(--color-border-light)] px-3 py-2 text-xs text-[var(--color-text-secondary)] ${searchTarget ? 'search-target-message' : ''}`}>
    <summary className="cursor-pointer min-h-8 leading-8">历史操作记录 · {new Date(message.created_at).toLocaleString()}</summary>
    {message.items ? <ProcessSteps steps={message.items} sessionId={message.session_id}
      processTimeline={message.processTimeline} defaultCollapsed={false} settled
      searchTargetScope={searchTarget ? searchTargetScope : undefined}
      searchTargetItemId={searchTarget ? searchTargetItemId : undefined} />
      : <button type="button" disabled={!onLoadDetails || loading} onClick={() => void load()}
        className="min-h-11 underline disabled:opacity-50">
        {loading ? '正在加载…' : failed ? '加载失败，点击重试' : '查看原始授权记录'}
      </button>}
  </details>;
}
