import { cloneElement, createContext, useContext, useEffect, useId, useState, type ReactElement } from 'react';
import type { LocalToolId } from './tools-state';
import { captureToolAction } from '../../analytics/tracker';
export const ToolAnalyticsContext=createContext<LocalToolId|null>(null);
import { copyToClipboard } from '../../utils/clipboard';
import FailureNotice from '../ui/FailureNotice';
import HelpBadge from '../workspace-console/WorkspaceHelpBadge';
import { formatHelpText } from '../workspace-console/workspace-help-text.ts';

export const toolInput = 'w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-base text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]';
export const toolButton = 'min-h-11 rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]';

export function ToolField({ label, hint, children, className = 'grid min-w-0 gap-1 text-sm' }: {
  label: string; hint: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; className?: string;
}) {
  const id = useId();
  const hintId = `${id}-help`;
  const describedBy = [children.props['aria-describedby'], hintId].filter(Boolean).join(' ');
  return <div className={className}>
    <div className="flex min-w-0 items-center gap-1"><label htmlFor={id}>{label}</label><HelpBadge label={label} content={hint} triggerClassName="tool-hint-trigger" /></div>
    {cloneElement(children, { id, 'aria-describedby': describedBy })}
    <span id={hintId} hidden>{formatHelpText(hint)}</span>
  </div>;
}
export function ToolError({ message }: { message: string }) {
  return message ? <p role="alert" className="mt-3 text-sm text-[var(--color-status-error)]"><FailureNotice error={message} /></p> : null;
}
export function CopyButton({ text }: { text: string }) {
  const toolId=useContext(ToolAnalyticsContext);
  const [notice, setNotice] = useState('复制结果');
  useEffect(() => setNotice('复制结果'), [text]);
  return <button type="button" disabled={!text} className={toolButton} onClick={() => {
    const report=toolId?captureToolAction(toolId,'copy'):null;
    void copyToClipboard(text).then(() => {setNotice('已复制');report?.();}).catch(() => {setNotice('复制失败，请手动选择');report?.('error');});
  }}><span role="status">{notice}</span></button>;
}
