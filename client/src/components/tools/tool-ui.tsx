import { cloneElement, createContext, useContext, useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import type { ToolId } from './tools-state';
import { captureToolAction } from '../../analytics/tracker';
export const ToolAnalyticsContext=createContext<ToolId|null>(null);
import { copyToClipboard } from '../../utils/clipboard';
import FailureNotice from '../ui/FailureNotice';
import HelpBadge from '../workspace-console/WorkspaceHelpBadge';
import { formatHelpText } from '../workspace-console/workspace-help-text.ts';

export const toolInput = 'tool-input w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-base text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]';
export const toolButton = 'tool-button min-h-11 rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]';
export const toolPrimary = toolButton + ' tool-primary';

export function ToolModes<T extends string>({ label, options, value, onChange }: {
  label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void;
}) {
  return <div className="tool-modes" role="group" aria-label={label}>
    {options.map(([id, title]) => <button key={id} type="button" className={toolButton} aria-pressed={value === id}
      onClick={() => { if (value !== id) onChange(id); }}>{title}</button>)}
  </div>;
}

export function ToolResult({ text, title, children }: { text: string; title: ReactNode; children?: ReactNode }) {
  return <section className="tool-result" aria-label="计算结果">
    <div className="tool-result-header"><strong role="status">{title}</strong><CopyButton text={text} /></div>
    {children}
  </section>;
}

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
  return message ? <p role="alert" className="mt-2 text-sm text-[var(--color-status-danger)]"><FailureNotice error={message} /></p> : null;
}
export function CopyButton({ text, label = '复制结果' }: { text: string; label?: string }) {
  const toolId=useContext(ToolAnalyticsContext);
  const [notice, setNotice] = useState(label);
  useEffect(() => setNotice(label), [text, label]);
  return <button type="button" disabled={!text} className={toolButton} onClick={() => {
    const report=toolId?captureToolAction(toolId,'copy'):null;
    void copyToClipboard(text).then(() => {setNotice('已复制');report?.();}).catch(() => {setNotice('复制失败，请手动选择');report?.('error');});
  }}><span role="status">{notice}</span></button>;
}
