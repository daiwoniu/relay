import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ToolId } from './tools-state';
import { expandedRowEnd } from './tools-layout';

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
  const after = expandedRowEnd(active ? ids.indexOf(active) : -1, ids.length, columns);
  return <div ref={ref} data-tools-grid className="grid items-start gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))' }}>
    {ids.flatMap((id, index) => index === after ? [card(id), <div key="inline-panel" className="col-span-full min-w-0">{panel}</div>] : [card(id)])}
  </div>;
}
