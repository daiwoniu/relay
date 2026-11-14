import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildDirectoryAwarePathCandidates } from '../../utils/path-display';

interface MiddleEllipsisPathProps {
  path: string;
  className?: string;
}

export default function MiddleEllipsisPath({ path, className = '' }: MiddleEllipsisPathProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const candidates = useMemo(() => buildDirectoryAwarePathCandidates(path), [path]);
  const [displayPath, setDisplayPath] = useState(path);

  const updateDisplayPath = useCallback(() => {
    const container = containerRef.current;
    if (!container || typeof document === 'undefined') return;
    const availableWidth = Math.max(0, container.clientWidth - 4);
    const style = window.getComputedStyle(container);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context || availableWidth === 0) return;
    context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const letterSpacing = Number.parseFloat(style.letterSpacing) || 0;
    const fits = (candidate: string) => context.measureText(candidate).width + Math.max(0, candidate.length - 1) * letterSpacing <= availableWidth;
    setDisplayPath(candidates.find(fits) ?? candidates[candidates.length - 1] ?? path);
  }, [candidates, path]);

  useLayoutEffect(() => {
    setDisplayPath(path);
    updateDisplayPath();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateDisplayPath);
    observer.observe(container);
    return () => observer.disconnect();
  }, [path, updateDisplayPath]);

  return (
    <span ref={containerRef} className={`block min-w-0 max-w-full overflow-hidden whitespace-nowrap ${className}`} aria-label={path}>
      {displayPath}
    </span>
  );
}
