import { useEffect, useState } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import FailureNotice from '../ui/FailureNotice';

export const toolInput = 'w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-base text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]';
export const toolButton = 'min-h-11 rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]';
export function ToolError({ message }: { message: string }) {
  return message ? <p role="alert" className="mt-3 text-sm text-[var(--color-status-error)]"><FailureNotice error={message} /></p> : null;
}
export function CopyButton({ text }: { text: string }) {
  const [notice, setNotice] = useState('复制结果');
  useEffect(() => setNotice('复制结果'), [text]);
  return <button type="button" disabled={!text} className={toolButton} onClick={() => {
    void copyToClipboard(text).then(() => setNotice('已复制')).catch(() => setNotice('复制失败，请手动选择'));
  }}><span role="status">{notice}</span></button>;
}
