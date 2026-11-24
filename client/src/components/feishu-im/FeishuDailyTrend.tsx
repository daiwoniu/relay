import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import WorkspaceHelpBadge from '../workspace-console/WorkspaceHelpBadge';

export interface FeishuTrendPoint { value: number; unknown?: number }
export interface FeishuTrendSeries { id: string; label: string; points: FeishuTrendPoint[] }

const height = 168;
const width = 600;
const side = 42;
const top = 40;
const bottom = 148;
const dayMs = 86_400_000;
const format = (value: number) => value.toLocaleString('zh-CN');
const formatAxis = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

export function feishuTrendDays(firstDay: string, lastDay: string): string[] {
  const start = Date.parse(`${firstDay}T00:00:00Z`);
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const length = Math.floor((end - start) / dayMs) + 1;
  return Array.from({ length }, (_, index) => new Date(start + index * dayMs).toISOString().slice(0, 10));
}

export default function FeishuDailyTrend({ title, unit, dates, series, help, controls, emptyMessage }: {
  title: string; unit: '次' | 'tokens'; dates: string[]; series: FeishuTrendSeries[];
  help?: string; controls?: ReactNode; emptyMessage?: string;
}) {
  const [focusedDay, setFocusedDay] = useState<string | null>(null);
  const match = dates.indexOf(focusedDay ?? '');
  const activeIndex = match < 0 ? dates.length - 1 : match;
  const active = dates[activeIndex];
  const plotWidth = width - side * 2;
  const peak = series.reduce((max, line) => line.points.reduce((value, point) => Math.max(value, point.value), max), 1);
  const maximum = Math.ceil(peak / 2) * 2;
  const labelEvery = dates.length <= 7 ? 1 : Math.ceil((dates.length - 1) / 4);
  const showValues = series.length === 1 && dates.length <= 7;
  const x = (index: number) => dates.length === 1 ? width / 2 : side + index / (dates.length - 1) * plotWidth;
  const y = (value: number) => bottom - value / maximum * (bottom - top);
  const lines = series.map((line, index) => ({ ...line,
    color: index === 0 ? 'var(--color-primary)' : `hsl(${(index * 137.508 + 20) % 360} 70% 46%)`,
    total: line.points.reduce((sum, point) => sum + point.value, 0),
    unknown: line.points.reduce((sum, point) => sum + (point.unknown ?? 0), 0),
    path: line.points.map((point, day) => {
      if (day === 0) return `M ${x(day)} ${y(point.value)}`;
      const middle = (x(day - 1) + x(day)) / 2;
      return `C ${middle} ${y(line.points[day - 1]!.value)} ${middle} ${y(point.value)} ${x(day)} ${y(point.value)}`;
    }).join(' '),
  }));
  function selectDay(index: number) {
    setFocusedDay(dates[Math.min(dates.length - 1, Math.max(0, index))] ?? null);
  }
  function selectPointer(event: PointerEvent<SVGSVGElement>) {
    if (dates.length < 2) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    selectDay(Math.round(((event.clientX - bounds.left) / bounds.width * width - side) / plotWidth * (dates.length - 1)));
  }
  function selectKey(event: KeyboardEvent<SVGSVGElement>) {
    const index = event.key === 'ArrowLeft' ? activeIndex - 1 : event.key === 'ArrowRight' ? activeIndex + 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? dates.length - 1 : null;
    if (index === null) return;
    event.preventDefault();
    selectDay(index);
  }
  return <section className="feishu-card feishu-trend feishu-trend-wide">
    <div className="feishu-section-heading feishu-trend-heading">
      <h2>{title}{help && <WorkspaceHelpBadge label={title} content={help} triggerClassName="feishu-help" />}</h2>
      {controls}
    </div>
    {active && lines.length ? <>
      <div className="feishu-trend-legend">{lines.map(line => <span key={line.id}>
        <i style={{ background: line.color }} aria-hidden="true" />{line.label} <strong>{format(line.total)} {unit}</strong>
        {!!line.unknown && <small>{format(line.unknown)} 次用量未知</small>}
      </span>)}</div>
      <div className="feishu-trend-grid">
        <div className="feishu-trend-scale" aria-hidden="true"><span>{formatAxis.format(maximum)}</span><span>{formatAxis.format(maximum / 2)}</span><span>0</span></div>
          <div className="feishu-trend-plot">
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" tabIndex={0}
              aria-label={`${title}，${active}。用左右方向键切换日期。`}
              onPointerMove={event => { if (event.pointerType !== 'touch') selectPointer(event); }} onPointerDown={selectPointer} onKeyDown={selectKey}>
              {[top, (top + bottom) / 2, bottom].map(row => <line key={row} className="feishu-trend-guide"
                x1={side} x2={width - side} y1={row} y2={row} vectorEffect="non-scaling-stroke" />)}
              <line className="feishu-trend-cursor" x1={x(activeIndex)} x2={x(activeIndex)} y1={top} y2={bottom} vectorEffect="non-scaling-stroke" />
              {lines.map(line => <path key={line.id} className="feishu-trend-line" d={line.path} style={{ stroke: line.color }} vectorEffect="non-scaling-stroke" />)}
            </svg>
            {dates.map((day, index) => {
              const marked = showValues || index === activeIndex ? lines : [];
              const showDate = index === dates.length - 1 || (index % labelEvery === 0 && index < dates.length - labelEvery / 2);
              return <div key={day} className="feishu-trend-day" style={{ left: `${x(index) / width * 100}%` }} aria-hidden="true">
                {marked.map(line => {
                  const point = line.points[index]!;
                  const pointY = y(point.value);
                  return <span key={line.id} style={{ color: line.color }}>
                    <i className="feishu-trend-dot" style={{ top: pointY }} />
                    {showValues && <b className="feishu-trend-value" style={{ top: pointY - 5 }}>{format(point.value)}</b>}
                  </span>;
                })}
                {showDate && <time dateTime={day}>{day.slice(5)}</time>}
              </div>;
            })}
          </div>
      </div>
      <div className="feishu-trend-reading"><time dateTime={active}>{active}</time>{lines.map(line => {
        const point = line.points[activeIndex]!;
        return <span key={line.id}><i style={{ background: line.color }} aria-hidden="true" />{line.label} <strong>{format(point.value)} {unit}</strong>
          {!!point.unknown && ` · ${format(point.unknown)} 次用量未知`}</span>;
      })}</div>
    </> : <p>{emptyMessage ?? '暂无记录'}</p>}
  </section>;
}
