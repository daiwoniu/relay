import { useEffect, useState, type ReactNode } from 'react';

export default function DeferredMarkdownContent({
  content,
  defer,
  renderMarkdown,
}: {
  content: string;
  defer: boolean;
  renderMarkdown: (content: string) => ReactNode;
}) {
  const [ready, setReady] = useState(!defer);

  useEffect(() => {
    if (!defer) {
      setReady(true);
      return;
    }
    setReady(false);
    let idleId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const frame = requestAnimationFrame(() => {
      if ('requestIdleCallback' in window) {
        idleId = window.requestIdleCallback(() => setReady(true), { timeout: 500 });
      } else {
        timer = globalThis.setTimeout(() => setReady(true), 0);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (idleId !== null) window.cancelIdleCallback(idleId);
      if (timer !== null) globalThis.clearTimeout(timer);
    };
  }, [content, defer]);

  if (!defer || ready) return <>{renderMarkdown(content)}</>;
  return <div className="whitespace-pre-wrap break-words">{content}</div>;
}
