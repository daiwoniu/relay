import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ToolId } from './tools-state';
import { expandedRowEnd } from './tools-layout';
import './tools-grid.css';

export function ToolsExpansionBridge() {
  return <span aria-hidden="true" className="tools-expansion-bridge">
    {['left', 'right'].map((side) => <svg key={side} className={`tools-expansion-corner tools-expansion-corner-${side}`} width="13" height="13" viewBox="0 0 13 13" fill="none" shapeRendering="geometricPrecision" focusable="false">
      <path d="M0 12.5A12.5 12.5 0 0 0 12.5 0H13V13H0Z" fill="var(--color-surface)" />
      <path d="M0 12.5A12.5 12.5 0 0 0 12.5 0" stroke="var(--tools-expansion-border)" strokeWidth="1" />
    </svg>)}
  </span>;
}

export default function ToolsGrid({ ids, active, card, panel }: {
  ids: ToolId[]; active: ToolId | null; card: (id: ToolId) => ReactNode; panel: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const measure = () => setColumns(getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter((track) => parseFloat(track) > 0).length || 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(grid);
    return () => observer.disconnect();
  }, []);
  const activeIndex = active ? ids.indexOf(active) : -1;
  const after = expandedRowEnd(activeIndex, ids.length, columns);
  const activeColumn = activeIndex % columns;
  return <div ref={ref} data-tools-grid data-expanded-first-column={activeIndex >= 0 && activeColumn === 0 || undefined} data-expanded-last-column={activeIndex >= 0 && activeColumn === columns - 1 || undefined} className="tools-grid grid items-stretch" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))' }}>
    {ids.flatMap((id, index) => index === after ? [card(id), <div key="inline-panel" className={`tools-expansion-panel col-span-full min-w-0 rounded-3xl border bg-[var(--color-surface)] ${activeColumn === 0 ? 'rounded-tl-none' : ''} ${activeColumn === columns - 1 ? 'rounded-tr-none' : ''}`}>{panel}</div>] : [card(id)])}
  </div>;
}
