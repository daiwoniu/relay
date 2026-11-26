import { useState, type CSSProperties } from 'react';
import { featureAction } from '../../analytics/features';
import { feishuIdentityLabel } from './feishu-status';
import { formatCompactTokens } from '../../../../server/src/integrations/feishu-im/reply-display.ts';

export type TimeWindow = { from: number; to: number };
export type OverviewMetric = 'received' | 'anomalies' | 'tokens';
export type OverviewDimension = 'robot' | 'group' | 'p2p' | 'model';
type Attention = 'reply_failed' | 'reply_unknown' | 'reply_anomaly';
export type Drilldown = TimeWindow & {
  botId?: string; chatId?: string; chatType?: 'group' | 'p2p'; attention?: Attention;
};
type Counts = Record<'received' | 'group' | 'p2p' | 'failed' | 'unknown' | 'tokens' | 'missing', number>;
type Rank = { botId?: string; chatId?: string | null; label: string | null; value: number; missing: number };
export type Overview = TimeWindow & { timeZone: string; total: Counts; points: (TimeWindow & Counts & { usageReports?: number })[]; ranking: Rank[] };
type Bot = { id: string; name: string; workspace: string };

const number = new Intl.NumberFormat('zh-CN');
const metrics: Record<OverviewMetric, string> = { received: '收到请求', anomalies: '回复异常', tokens: '已记录 Tokens' };
const dimensions: Record<OverviewDimension, string> = { robot: '机器人', group: '群聊', p2p: '私聊', model: '模型' };
const series = {
  received: [{ key: 'group', label: '群聊' }, { key: 'p2p', label: '私聊' }],
  anomalies: [{ key: 'failed', label: '回复失败' }, { key: 'unknown', label: '回复待确认' }],
  tokens: [{ key: 'tokens', label: '已记录 Tokens' }],
} as const;

const trendTitles: Record<OverviewMetric, string> = {
  received: '请求量趋势',
  anomalies: '回复异常趋势',
  tokens: '模型用量趋势',
};

type Point = Overview['points'][number];
type Reading = { point: Point; series: keyof Counts; label: string; target?: Drilldown };

function tokenGap(point: Point) {
  return point.missing > 0 && (point.usageReports === 0 || point.usageReports === undefined && point.tokens === 0);
}

function TrendChart({ trend, points, dates, dateRange, onOpen }: {
  trend: OverviewMetric; points: Point[]; dates: Intl.DateTimeFormat;
  dateRange: (point: TimeWindow) => string; onOpen: (target: Drilldown) => void;
}) {
  const [preview, setPreview] = useState<Reading | null>(null);
  const [selected, setSelected] = useState<Reading | null>(null);
  const reading = preview ?? selected;
  const matchesSelection = reading && selected && reading.point.from === selected.point.from && reading.series === selected.series;
  const tokens = trend === 'tokens';
  const lines = series[trend];
  const peak = Math.max(0, ...points.map(point => lines.reduce((sum, line) => sum + point[line.key], 0)));
  const maximum = Math.max(peak, 1);
  const unit = tokens ? 'Tokens' : '次';
  const hasSeries = peak > 0 || tokens && points.some(point => point.missing || point.usageReports);
  const pointHeight = (point: Point) => 94 - (point.tokens / maximum) * 88;
  const path = tokens ? points.map((point, index) => {
    if (tokenGap(point)) return '';
    const command = index === 0 || tokenGap(points[index - 1]) ? 'M' : 'L';
    return `${command}${index + 0.5},${pointHeight(point)}`;
  }).join(' ') : '';

  function readingButton(item: Reading, className: string, style: CSSProperties, variant?: string) {
    const active = selected?.point.from === item.point.from && selected.series === item.series;
    return <button key={item.series} type="button" className={className} data-series={item.series} data-coverage={variant}
      style={style} aria-label={item.label} aria-pressed={active}
      onPointerEnter={() => setPreview(item)} onPointerLeave={() => setPreview(null)}
      onFocus={() => setPreview(item)} onBlur={() => setPreview(null)}
      onClick={() => setSelected(active ? null : item)} />;
  }

  function tokenButton(point: Point) {
    const gap = tokenGap(point);
    const missing = point.missing ? ` · ${number.format(point.missing)} 次用量缺失` : '';
    const label = `${dateRange(point)} · ${gap ? '用量未记录' : `${number.format(point.tokens)} Tokens`}${missing}`;
    return readingButton({ point, series: 'tokens', label }, 'feishu-token-point',
      { top: `${gap ? 100 : pointHeight(point)}%` }, gap ? 'missing' : point.missing ? 'partial' : undefined);
  }

  return <section className="feishu-card" data-trend={trend}>
    <h3>{trendTitles[trend]}</h3>
    <ul className="feishu-chart-legend" aria-label="图例">
      {lines.map(line => <li key={line.key}><i data-series={line.key} />{line.label}</li>)}
      {tokens && <li><i className="feishu-usage-marker" />用量缺失</li>}
    </ul>
    {hasSeries ? <>
      <div className="feishu-chart-scroll">
      <div className="feishu-chart-axis" aria-hidden="true">
        <span title={tokens && peak ? number.format(peak) : undefined}>{peak ? (tokens ? formatCompactTokens(peak) : number.format(peak)) : ''}</span>
        <span>{unit}</span><span>0</span>
      </div>
        <div className="feishu-chart" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(1.45rem, 1fr))` }}>
          {tokens && <svg className="feishu-token-line" viewBox={`0 0 ${points.length} 100`} preserveAspectRatio="none" aria-hidden="true">
            <path d={path} vectorEffect="non-scaling-stroke" />
          </svg>}
          {points.map((point, index) => <div key={point.from} className="feishu-chart-point">
            <div className="feishu-chart-stack">{tokens ? tokenButton(point) : lines.map(line => {
              const value = point[line.key];
              if (!value) return null;
              const chatType = line.key === 'group' || line.key === 'p2p' ? line.key : undefined;
              const attention = line.key === 'failed' ? 'reply_failed' : line.key === 'unknown' ? 'reply_unknown' : undefined;
              const label = `${dateRange(point)} · ${line.label} ${number.format(value)} 次`;
              return readingButton({ point, series: line.key, label,
                target: { from: point.from, to: point.to, chatType, attention } }, 'feishu-chart-segment', { height: `${value / maximum * 100}%` });
            })}</div>
            <small aria-hidden="true">{index % Math.ceil(points.length / 8) === 0 ? dates.format(point.from) : '\u00a0'}</small>
          </div>)}
        </div>
      </div>
      <div className="feishu-chart-reading">
        <span aria-live="polite">{reading?.label ?? '选择柱形或数据点查看数值'}</span>
        {matchesSelection && selected.target && <button type="button" onClick={() => onOpen(selected.target!)}>查看对应消息</button>}
      </div>
    </> : <div className="feishu-chart-empty"><p>{trend === 'received' ? '当前时段暂无请求'
      : trend === 'anomalies' ? '当前时段暂无回复异常' : '当前时段暂无已记录的 Tokens'}</p></div>}
  </section>;
}

export default function FeishuOverview({ overview, bots, allBots, days, dimension, metric, rankingLoading, rankingUnavailable, chatType, onDimension, onMetric, onOpen }: {
  overview: Overview; bots: Bot[]; allBots: boolean; days: number; dimension: OverviewDimension; metric: OverviewMetric;
  rankingLoading: boolean;
  rankingUnavailable: boolean;
  chatType: '' | 'group' | 'p2p';
  onDimension: (value: OverviewDimension) => void; onMetric: (value: OverviewMetric) => void;
  onOpen: (target: Drilldown) => void;
}) {
  const { from, to, timeZone, total, points, ranking } = overview;
  const visibleRanks = ranking.slice(0, 10);
  const rankMax = Math.max(1, ...visibleRanks.map(row => row.value));
  const dates = new Intl.DateTimeFormat('zh-CN', days === 1
    ? { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { timeZone, month: 'numeric', day: 'numeric' });
  const fullTime = new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dateRange = (point: TimeWindow) => `${fullTime.format(point.from)} – ${fullTime.format(point.to)}`;

  return <>
    <div className="feishu-counts feishu-overview-counts" aria-label="使用概览">
      <button type="button" onClick={() => onOpen({ from, to })}>收到请求 <strong>{number.format(total.received)}</strong></button>
      <button type="button" onClick={() => onOpen({ from, to, attention: 'reply_failed' })}>回复失败 <strong>{number.format(total.failed)}</strong></button>
      <button type="button" onClick={() => onOpen({ from, to, attention: 'reply_unknown' })}>回复待确认 <strong>{number.format(total.unknown)}</strong></button>
      <div>已记录 Tokens <strong title={`${number.format(total.tokens)} Tokens`}>{formatCompactTokens(total.tokens)}</strong><small>{number.format(total.missing)} 次模型用量缺失</small></div>
    </div>
    <div className="feishu-overview">
      <header className="feishu-overview-heading">
        <div><h2>使用趋势</h2><p>{dateRange({ from, to })} · {timeZone} · 按{days === 1 ? '小时' : days === 90 ? '周' : '日'}</p></div>
        <p>按请求接收时间归档，回复异常取当前状态</p>
      </header>
      <div className="feishu-trend-grid">
        {(['received', 'anomalies', 'tokens'] as const).map(trend => <TrendChart key={`${trend}:${from}:${to}`} trend={trend}
          points={points} dates={dates} dateRange={dateRange} onOpen={onOpen} />)}
      </div>
      <details className="feishu-card feishu-chart-values" onToggle={event => {
        if (event.currentTarget.open) featureAction('feishu_admin', 'details', 'admin');
      }}>
        <summary>查看数据明细</summary>
        <div><table><thead><tr>{['时段', '请求总量', '群聊', '私聊', '回复失败', '回复待确认', '已记录 Tokens', '用量缺失'].map(label =>
          <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{points.map(point => <tr key={point.from}>
            <th scope="row">{dateRange(point)}</th>
            {(['received', 'group', 'p2p', 'failed', 'unknown', 'tokens', 'missing'] as const).map(key =>
              <td key={key}>{key === 'tokens' && tokenGap(point) ? '未记录' : number.format(point[key])}</td>)}
          </tr>)}</tbody>
        </table></div>
      </details>
      <section className="feishu-card">
        <header className="feishu-overview-heading">
          <h2>使用对比</h2>
          <div className="feishu-toolbar">
            <select aria-label="对比维度" value={dimension} onChange={event => onDimension(event.target.value as OverviewDimension)}>
              {Object.entries(dimensions).map(([id, label]) => <option key={id} value={id}
                disabled={Boolean(chatType && (id === 'group' || id === 'p2p') && chatType !== id)}>{label}</option>)}
            </select>
            <select aria-label="对比指标" value={metric} onChange={event => onMetric(event.target.value as OverviewMetric)} disabled={dimension === 'model'}>
              {Object.entries(metrics).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
        </header>
        {rankingLoading ? <p role="status">正在读取对比数据…</p> : rankingUnavailable ? <p role="status">暂时无法读取当前对比。</p>
          : visibleRanks.length ? <ol className="feishu-overview-ranking">{visibleRanks.map(row => {
          const bot = bots.find(item => item.id === row.botId);
          const chatType = dimension === 'group' || dimension === 'p2p' ? dimension : undefined;
          const title = dimension === 'model' ? row.label ?? '未识别模型'
            : chatType && row.chatId ? feishuIdentityLabel(row.chatId, row.label, dimensions[chatType])
              : bot ? `${bot.name} · ${bot.workspace}` : '机器人';
          const content = <><span><strong>{title}</strong>{allBots && chatType && bot && <small>{bot.name} · {bot.workspace}</small>}
            {metric === 'tokens' && row.missing > 0 && <small>{number.format(row.missing)} 次模型用量缺失</small>}</span>
            <span className="feishu-ranking-value">
              <span className="feishu-stat-bar" aria-hidden="true" style={{ width: `calc((100% - var(--feishu-ranking-number)) * ${row.value / rankMax})` }} />
              {metric === 'tokens'
                ? <strong title={`${number.format(row.value)} Tokens`}>{formatCompactTokens(row.value)} Tokens</strong>
                : <strong>{number.format(row.value)} 次</strong>}
            </span></>;
          return <li key={JSON.stringify([row.botId, row.chatId, row.label])}>
            {metric === 'tokens' || !bot ? <div className="feishu-ranking-row">{content}</div>
              : <button type="button" className="feishu-ranking-row" onClick={() => onOpen({
                from, to, botId: bot.id, chatId: row.chatId ?? undefined, chatType,
                attention: metric === 'anomalies' ? 'reply_anomaly' : undefined,
              })}>{content}</button>}
          </li>;
        })}</ol> : <p>当前范围暂无对比数据。</p>}
        {!rankingLoading && ranking.length > visibleRanks.length && <p className="feishu-stat-note">显示前 10 项</p>}
      </section>
    </div>
  </>;
}
