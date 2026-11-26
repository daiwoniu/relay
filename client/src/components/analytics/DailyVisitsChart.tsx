import {formatDate} from '../../utils/date-display.ts';
import {useState} from 'react';
import {featureAction} from '../../analytics/features';
import type {AnalyticsSummary} from '../../analytics/tracker';
import {beijingDay,beijingMinute,dailySeries,number,trendLinePath,trendSeries} from './analytics-presentation';
import {SectionHeading,trackAnalyticsExpansion} from './AnalyticsSections';
import AnalyticsHelp,{analyticsHelp} from './AnalyticsHelp';

const networks=[['public','公网'],['internal','本机 / 内网'],['unknown','未识别网络']] as const;
const series=[['total','总访问'],...networks] as const;
type SeriesKey=typeof series[number][0];

export default function DailyVisitsChart({daily,trend,since,earliest,now,until=now}:{daily:AnalyticsSummary['daily'];trend?:AnalyticsSummary['trend'];since:number;earliest:number|null;now:number;until?:number}){
  const [metric,setMetric]=useState<'pv'|'uv'>('pv'),[selected,setSelected]=useState<string|null>(null);
  const [chartType,setChartType]=useState<'bar'|'line'>('bar');
  const [hiddenSeries,setHiddenSeries]=useState<SeriesKey[]>([]);
  const days=trend?trendSeries(trend,since,earliest,until):dailySeries(daily,since,earliest,until).map(day=>({...day,label:day.day,tick:formatDate(day.day,{short:true})}));
  const peak=Math.max(0,...days.map(day=>day[metric]));
  const step=Math.max(1,Math.ceil(peak/4)),ceiling=step*4,ticks=[ceiling,step*3,step*2,step,0];
  const active=days.find(day=>day.day===selected)??days[days.length-1],dense=days.length>10;
  const splitNetwork=metric==='pv'&&days.some(day=>day.network);
  const line=chartType==='line';
  const activeNetwork=active?.network;
  const plotSeries=line?(splitNetwork?series:series.slice(0,1)).map(([key,label])=>({key,label,
    values:days.map(day=>day.available?(key==='total'?day[metric]:day.network?.[key]??(day.pv===0?0:null)):null),
  })):[];
  const visibleSeries=splitNetwork?plotSeries.filter(({key})=>!hiddenSeries.includes(key)):plotSeries;
  const activeIndex=days.findIndex(day=>day.day===active?.day);
  const overlaps=new Map<number,string[]>();
  if(line&&splitNetwork&&activeIndex>=0){
    for(const {label,values} of visibleSeries){
      const value=values[activeIndex];
      if(value!==null&&value>0)overlaps.set(value,[...(overlaps.get(value)??[]),label]);
    }
  }
  const overlapLabels=[...overlaps.values()].filter(labels=>labels.length>1).map(labels=>labels.join('、'));
  const showTotal=!line||visibleSeries.some(({key})=>key==='total');
  const toggleSeries=(key:SeriesKey)=>{
    featureAction('analytics','filter','admin');
    setHiddenSeries(previous=>previous.includes(key)?previous.filter(value=>value!==key):[...previous,key]);
  };
  const columns={gridTemplateColumns:`repeat(${Math.max(1,days.length)},minmax(0,1fr))`};
  const trendDescription=trend?`${beijingMinute(since)} — ${beijingMinute(until)} · 北京时间 · ${trend.step<86_400_000?'按小时':trend.step===86_400_000?'按天':`每 ${trend.step/86_400_000} 天`}`:
    `${formatDate(days[0]?.day,{fallback:''})} — ${formatDate(days[days.length-1]?.day,{fallback:''})} · 北京时间 · 最多近30天`;
  return <section className="analytics-panel analytics-trend" data-metric={metric} data-chart-type={chartType}>
    <SectionHeading title="访问趋势" help={analyticsHelp.trend} description={trendDescription}>
      <div className="analytics-chart-options">
        <div className="analytics-segment" role="group" aria-label="趋势指标">{(['pv','uv'] as const).map(value=><button key={value} type="button" aria-pressed={metric===value} onClick={()=>{if(metric!==value)featureAction('analytics','metric','admin');setMetric(value);}}>{value==='pv'?'访问量 PV':'估算访客 UV'}</button>)}</div>
        <div className="analytics-segment" role="group" aria-label="图表类型">{(['bar','line'] as const).map(value=><button key={value} type="button" aria-pressed={chartType===value} onClick={()=>{
          if(chartType===value)return;
          featureAction('analytics','mode','admin');
          setChartType(value);
        }}>{value==='bar'?'柱状':'折线'}</button>)}</div>
      </div>
    </SectionHeading>
    {splitNetwork&&(line?<ul className="analytics-chart-legend analytics-line-legend" aria-label="显示或隐藏折线">
      {plotSeries.map(({key,label,values})=>{
        const visible=!hiddenSeries.includes(key),value=values[activeIndex];
        return <li key={key}><button type="button" aria-pressed={visible} aria-label={`${label}折线`}
          disabled={visible&&visibleSeries.length===1} onClick={()=>toggleSeries(key)}>
          <i data-series={key} aria-hidden="true"/><span className="analytics-legend-label">{label}</span>{value!=null&&<span>{number(value)}</span>}
        </button></li>;
      })}
    </ul>:<ul className="analytics-chart-legend" aria-label="网络类型">
      {networks.map(([key,label])=><li key={key}><i data-network={key} aria-hidden="true"/>{label}{activeNetwork&&<span> {number(activeNetwork[key])}</span>}</li>)}
    </ul>)}
    <div className="analytics-chart-detail" aria-live="polite"><span>{active?.label}{!trend&&active?.day===beijingDay(now)?' · 今日未结束':''}</span>{active?.available?<><strong>{number(active.pv)}<small>次访问</small></strong><strong>{number(active.uv)}<small>个估算访客</small></strong>{splitNetwork&&activeNetwork&&<span className="sr-only">{networks.map(([key,label])=>`${label} ${activeNetwork[key]} 次`).join('，')}</span>}{overlapLabels.length>0&&<span className="analytics-chart-overlap">{overlapLabels.map(labels=>`${labels}重合`).join('；')}</span>}</>:<span>{days.length?'无保留记录':'当前范围暂无数据'}</span>}</div>
    <div className="analytics-chart">
      <div className="analytics-chart-axis" aria-hidden="true">{ticks.map((tick,index)=><span key={tick} style={{top:`${index/(ticks.length-1)*100}%`}}>{number(tick)}</span>)}</div>
      <div className="analytics-chart-scroll"><div className="analytics-chart-body" style={{minWidth:days.length*(dense?24:36)}}>
        <div className="analytics-chart-plot">
          <div className="analytics-chart-grid" aria-hidden="true">{ticks.map(tick=><span key={tick}/>)}</div>
          {line&&<svg className="analytics-trend-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {visibleSeries.map(({key,values})=><path key={key} data-series={key} vectorEffect="non-scaling-stroke" d={trendLinePath(values,ceiling)}/>)}
          </svg>}
          <div className="analytics-chart-columns" style={columns}>{days.map((day,index)=><button type="button" key={day.day} className="analytics-chart-column" aria-pressed={active?.day===day.day} aria-label={`${day.label}：${day.available?`${day.pv}次访问，${day.uv}个估算访客`:'无保留记录'}`} onPointerEnter={event=>{if(event.pointerType==='mouse')setSelected(day.day);}} onFocus={()=>setSelected(day.day)} onClick={()=>{featureAction('analytics','select_day','admin');setSelected(day.day);}}>
            {line?visibleSeries.map(({key,values})=>{
              const value=values[index];
              const isolated=values[index-1]==null&&values[index+1]==null;
              return value!==null&&(key==='total'||index===activeIndex||isolated)?<span key={key} className="analytics-trend-point" data-series={key} style={{bottom:`${value/ceiling*100}%`}} aria-hidden="true"/>:null;
            }):
            <span className="analytics-chart-bar" data-available={day.available} data-stacked={splitNetwork&&Boolean(day.network)||undefined} style={{height:day.available?`${day[metric]/ceiling*100}%`:'2px'}} aria-hidden="true">
              {splitNetwork&&day.pv>0&&networks.map(([key])=>{
                const count=day.network?.[key];
                return count?<span key={key} data-network={key} style={{flexBasis:`${count/day.pv*100}%`}}/>:null;
              })}
            </span>}
            {showTotal&&!dense&&day.available&&day[metric]>0&&<span className="analytics-chart-value" style={{bottom:`${day[metric]/ceiling*100}%`}}>{number(day[metric])}</span>}
          </button>)}</div>
        </div>
        <div className="analytics-chart-dates" aria-hidden="true" style={columns}>{days.map((day,i)=><span key={day.day}>{!dense||i===0||i===days.length-1||i%5===0?day.tick:''}</span>)}</div>
      </div></div>
    </div>
    <p className="analytics-footnote">{peak===0?'所选范围暂无可展示的访问数据。':'悬停、点击或使用键盘查看时段数值。'} {line?`${splitNetwork?'点击图例可显示或隐藏单条折线。':''}折线在无保留记录处断开。`:'零访问不画柱，灰色标记表示无保留记录。'}{dense?'时段较多，可横向滚动。':''}</p>
    <details className="analytics-daily-data"><summary onClick={trackAnalyticsExpansion}>{trend&&trend.step!==86_400_000?'查看分时段数据表':'查看每日数据表'}</summary><div className="analytics-data-table"><table><thead><tr><th scope="col">{trend?'时段':'日期'}</th><th scope="col">访问量 PV</th><th scope="col">估算访客 UV</th></tr></thead><tbody>{days.map(day=><tr key={day.day}><th scope="row">{day.label}</th><td>{day.available?number(day.pv):'无保留记录'}</td><td>{day.available?number(day.uv):'无保留记录'}</td></tr>)}</tbody></table></div></details>
  </section>;
}
