import { useEffect, useRef } from 'react';
import { startProgressiveTextPreview } from './progressive-code-preview';

interface ProgressiveCodePreviewProps {
  content: string;
}

export default function ProgressiveCodePreview({ content }: ProgressiveCodePreviewProps) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const code = codeRef.current;
    if (!code) return undefined;

    code.replaceChildren();
    return startProgressiveTextPreview(
      content,
      (chunk) => code.append(document.createTextNode(chunk)),
      {
        request: (callback) => window.requestAnimationFrame(callback),
        cancel: (id) => window.cancelAnimationFrame(id),
      },
    );
  }, [content]);

  return <pre><code ref={codeRef} /></pre>;
}
