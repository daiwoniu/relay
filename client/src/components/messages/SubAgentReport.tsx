import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getSubAgentReport } from '../../api/sessions';

interface Props {
  sessionId: string;
  messageId: string;
  itemId: string;
  renderContent?: (content: string) => ReactNode;
  renderTrigger?: (control: SubAgentReportControl) => ReactNode;
  autoLoad?: boolean;
}

export interface SubAgentReportControl {
  expanded: boolean;
  loading: boolean;
  onToggle: () => void;
}

export default function SubAgentReport(props: Props) {
  return <ReportBody key={JSON.stringify([props.sessionId, props.messageId, props.itemId])} {...props} />;
}

function ReportBody({ sessionId, messageId, itemId, renderContent, renderTrigger, autoLoad = false }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(autoLoad);
  const [open, setOpen] = useState(autoLoad);
  const request = useRef<AbortController | null>(null);
  const read = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setOpen(true); setLoading(true); setError('');
    try {
      const result = await getSubAgentReport(sessionId, messageId, itemId, controller.signal);
      if (!controller.signal.aborted) setContent(result.content);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '子任务回报加载失败');
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  };
  const toggle = () => {
    if (open) {
      setOpen(false); request.current?.abort(); request.current = null; setLoading(false);
    } else {
      setOpen(true); if (!content) void read();
    }
  };
  useEffect(() => {
    if (autoLoad) void read();
    return () => { request.current?.abort(); request.current = null; };
  }, [autoLoad]);
  return <>
    {renderTrigger?.({ expanded: open, loading, onToggle: toggle })}
    {open && <div className="process-step__details text-xs text-[var(--color-text-secondary)]">
      {loading && <p role="status">正在读取子任务回报…</p>}
      {error && <div role="status"><p>{error}</p><button type="button" className="min-h-8 underline" onClick={() => void read()}>重试读取回报</button></div>}
      {content && <><div className="mb-1 text-[var(--color-text-tertiary)]">子任务回报</div>
        {renderContent ? renderContent(content) : <div className="whitespace-pre-wrap break-words">{content}</div>}</>}
    </div>}
  </>;
}
