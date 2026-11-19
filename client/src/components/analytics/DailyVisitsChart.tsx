import {formatDate} from '../../utils/date-display.ts';
import {useState} from 'react';
import {featureAction} from '../../analytics/features';
import type {AnalyticsSummary} from '../../analytics/tracker';
import {beijingDay,dailySeries,number} from './analytics-presentation';
import {SectionHeading} from './AnalyticsSections';
import AnalyticsHelp,{analyticsHelp} from './AnalyticsHelp';

export default function DailyVisitsChart({daily,since,earliest,now}:{daily:AnalyticsSummary['daily'];since:number;earliest:number|null;now:number}){
  const [metric,setMetric]=useState<'pv'|'uv'>('pv'),[selected,setSelected]=useState<string|null>(null);
  const days=dailySeries(daily,since,earliest,now),peak=Math.max(0,...days.map(day=>day[metric]));
  const step=Math.max(1,Math.ceil(peak/4)),ceiling=step*4,ticks=[ceiling,step*3,step*2,step,0];
  const active=days.find(day=>day.day===selected)??days[days.length-1],dense=days.length>10;
  const columns={gridTemplateColumns:`repeat(${Math.max(1,days.length)},minmax(0,1fr))`};
  return <section className="analytics-panel analytics-trend" data-metric={metric}>
    <SectionHeading title="访问趋势" help={analyticsHelp.trend} description={`${formatDate(days[0]?.day,{fallback:''})} — ${formatDate(days[days.length-1]?.day,{fallback:''})} · 北京时间 · 最多近30天`}>
      <div className="analytics-segment" role="group" aria-label="趋势指标">{(['pv','uv'] as const).map(value=><button key={value} type="button" aria-pressed={metric===value} onClick={()=>{if(metric!==value)featureAction('analytics','metric','admin');setMetric(value);}}>{value==='pv'?'访问量 PV':'估算访客 UV'}</button>)}</div>
    </SectionHeading>
    <div className="analytics-chart-detail" aria-live="polite"><span>{formatDate(active?.day,{fallback:''})}{active?.day===beijingDay(now)?' · 今日未结束':''}</span>{active?.available?<><strong>{number(active.pv)}<small>次访问</small></strong><strong>{number(active.uv)}<small>个估算访客</small></strong></>:<span>无保留记录</span>}</div>
    <div className="analytics-chart">
      <div className="analytics-chart-axis" aria-hidden="true">{ticks.map((tick,index)=><span key={tick} style={{top:`${index/(ticks.length-1)*100}%`}}>{number(tick)}</span>)}</div>
      <div className="analytics-chart-scroll"><div className="analytics-chart-body" style={{minWidth:days.length*(dense?24:36)}}>
        <div className="analytics-chart-plot">
          <div className="analytics-chart-grid" aria-hidden="true">{ticks.map(tick=><span key={tick}/>)}</div>
          <div className="analytics-chart-columns" style={columns}>{days.map(day=><button type="button" key={day.day} className="analytics-chart-column" aria-pressed={active?.day===day.day} aria-label={`${day.day}：${day.available?`${day.pv}次访问，${day.uv}个估算访客`:'无保留记录'}`} onPointerEnter={event=>{if(event.pointerType==='mouse')setSelected(day.day);}} onFocus={()=>setSelected(day.day)} onClick={()=>{featureAction('analytics','select_day','admin');setSelected(day.day);}}>
            <span className="analytics-chart-bar" data-available={day.available} style={{height:day.available?`${day[metric]/ceiling*100}%`:'2px'}}/>
            {!dense&&day.available&&day[metric]>0&&<span className="analytics-chart-value" style={{bottom:`${day[metric]/ceiling*100}%`}}>{number(day[metric])}</span>}
          </button>)}</div>
        </div>
        <div className="analytics-chart-dates" aria-hidden="true" style={columns}>{days.map((day,i)=><span key={day.day}>{!dense||i===0||i===days.length-1||i%5===0?formatDate(day.day,{short:true}):''}</span>)}</div>
      </div></div>
    </div>
    <p className="analytics-footnote">{peak===0?'所选范围暂无可展示的访问数据。':'悬停、点击柱形或使用键盘查看日期数值。'} 零访问不画柱，灰色标记表示无保留记录。{dense?'日期较多，可横向滚动。':''}</p>
    <details className="analytics-daily-data"><summary>查看每日数据表</summary><div className="analytics-data-table"><table><thead><tr><th scope="col">日期</th><th scope="col">访问量 PV</th><th scope="col">估算访客 UV</th></tr></thead><tbody>{days.map(day=><tr key={day.day}><th scope="row">{day.day}</th><td>{day.available?number(day.pv):'无保留记录'}</td><td>{day.available?number(day.uv):'无保留记录'}</td></tr>)}</tbody></table></div></details>
  </section>;
}
