import { formatDateTime } from '../../utils/date-display.ts';
import type { AnalyticsSummary } from '../../analytics/tracker';
import { toolsCatalog } from '../tools/tools-catalog.ts';
import { MEDIA_TOOL_IDS } from '../../../../server/src/analytics/registry.ts';
import { analyticsPageLabels } from '../../../../server/src/analytics/pages.ts';

export const analyticsLabels:Record<string,string>={...analyticsPageLabels,calendar:'万年历',weather:'天气',greeting:'随机问候语',timestamp:'时间戳与时区',json:'JSON格式化',qr:'二维码',diff:'文本对比',pomodoro:'番茄钟',units:'单位换算',dates:'日期助手',shopping:'购物计算',random:'随机选择',success:'成功',invalid_input:'输入无效',error:'处理错误',cancelled:'已取消',rejected:'登录被拒绝',throttled:'已限流',desktop:'电脑',mobile:'手机',tablet:'平板',guest:'访客',member:'成员',admin:'管理员',page_view:'页面访问',login_result:'登录结果',hosting_document:'HTML请求'};
for (const id of MEDIA_TOOL_IDS) analyticsLabels[id] = toolsCatalog[id].term ?? toolsCatalog[id].title;
export const analyticsName=(value:string)=>analyticsLabels[value]??value;
export const analyticsSourceName=(value:string)=>value.startsWith('external:')?value.slice(9):({internal:'站内访问',none:'无来源信息',unknown:'未记录','直接或未知':'未记录'} as Record<string,string>)[value]??value;
export const analyticsVisitSource=(row:{source:string|null;sourceType?:string|null})=>row.source?`外部网站：${row.source}`:analyticsSourceName(row.sourceType??'unknown');
export const analyticsBrowserName=(value:string)=>({WeChat:'微信内置浏览器',Huawei:'华为浏览器',Xiaomi:'小米浏览器',QQ:'QQ浏览器',UC:'UC浏览器',Quark:'夸克浏览器',Samsung:'Samsung Internet',Other:'未识别'} as Record<string,string>)[value]??value;
export const analyticsOsName=(value:string)=>({HarmonyOS:'鸿蒙 HarmonyOS',HyperOS:'小米 HyperOS',MIUI:'小米 MIUI',Other:'未识别'} as Record<string,string>)[value]??value;
export const number=(value:number)=>value.toLocaleString('zh-CN');
export const beijingDay=(at:number)=>new Date(at+8*3600_000).toISOString().slice(0,10);
export const beijingTime=(at:number)=>formatDateTime(at, { short: true, seconds: true, timeZone: 'Asia/Shanghai' });
export const beijingDateTimeInput=(at:number)=>new Date(at+8*3600_000).toISOString().slice(0,16);
export const beijingMinute=(at:number)=>beijingDateTimeInput(at).replace('T',' ');
export function parseBeijingDateTime(value:string){
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value))return NaN;
  const at=Date.parse(`${value}+08:00`);
  return Number.isFinite(at)&&beijingDateTimeInput(at)===value?at:NaN;
}
export const analyticsRangeLabels={today:'今天','24h':'近 24 小时','7d':'近 7 天','30d':'近 30 天',custom:'自定义',all:'所有时间'} as const;
export type AnalyticsRange=keyof typeof analyticsRangeLabels;
export function describeAnalyticsRange(range:AnalyticsRange,since:number,until:number,asOf:number){
  const start=beijingDateTimeInput(since),end=beijingDateTimeInput(until);
  const sameDay=start.slice(0,10)===end.slice(0,10);
  const showYear=start.slice(0,4)!==end.slice(0,4)||end.slice(0,4)!==beijingDay(asOf).slice(0,4);
  const dayLabel=(value:string)=>`${showYear?`${value.slice(0,4)} 年 `:''}${Number(value.slice(5,7))} 月 ${Number(value.slice(8,10))} 日`;
  const dayRange=sameDay?dayLabel(start):`${dayLabel(start)} — ${dayLabel(end)}`;
  if(range==='7d'||range==='30d'||range==='all'){
    return end.slice(0,10)===beijingDay(asOf)?`${dayRange} · 今日截至 ${end.slice(11)}`:dayRange;
  }
  return `${dayLabel(start)} ${start.slice(11)} — ${sameDay?'':`${dayLabel(end)} `}${end.slice(11)}`;
}
export function dailySeries(daily:AnalyticsSummary['daily'],since:number,earliest:number|null,now:number){
  const counts=new Map(daily.map(row=>[row.day,row]));
  since=Math.max(since,now-29*86_400_000);
  const first=earliest===null?null:beijingDay(earliest),today=beijingDay(now);
  const rows:Array<AnalyticsSummary['daily'][number]&{available:boolean}>=[];
  for(let i=0;i<30;i++){
    const day=beijingDay(since+i*86_400_000);if(day>today)break;
    const row=counts.get(day);
    rows.push({...row,day,pv:row?.pv??0,uv:row?.uv??0,available:Boolean(row)||(first!==null&&day>=first)});
  }
  return rows;
}
export function trendSeries(trend:NonNullable<AnalyticsSummary['trend']>,since:number,earliest:number|null,until:number){
  const {start,step,points}=trend;
  const counts=new Map(points.map(point=>[point.at,point]));
  const hourly=step<86_400_000;
  const length=until<since?0:Math.min(30,Math.floor((until-start)/step)+1);
  return Array.from({length},(_,index)=>{
    const at=start+index*step,row=counts.get(at);
    const label=hourly?beijingMinute(at):beijingDay(at);
    // The selected range can begin or end partway through an hour or a group of days.
    const from=Math.max(at,since),to=Math.min(at+step-1,until);
    const fullLabel=hourly?`${beijingMinute(from)} – ${beijingMinute(to)}`:
      beijingDay(from)===beijingDay(to)?beijingDay(from):`${beijingDay(from)} – ${beijingDay(to)}`;
    return{...row,day:label,label:fullLabel,tick:hourly?label.slice(11):label.slice(5),pv:row?.pv??0,uv:row?.uv??0,available:Boolean(row)||(earliest!==null&&earliest<=to)};
  });
}
export function trendLinePath(values:Array<number|null>,ceiling:number){
  return values.flatMap((value,index)=>value===null?[]:[
    `${index===0||values[index-1]===null?'M':'L'} ${(index+.5)*100/values.length} ${100-value/ceiling*100}`,
  ]).join(' ');
}
export function sortedTools(rows:AnalyticsSummary['tools'],sort:'opens'|'actions'){
  return [...rows].sort((a,b)=>b[sort]-a[sort]||b[sort==='opens'?'actions':'opens']-a[sort==='opens'?'actions':'opens']||a.label.localeCompare(b.label));
}
export function resultTone(value:string){
  return value==='success'?'success':value==='error'?'danger':['invalid_input','rejected','throttled'].includes(value)?'warning':'neutral';
}
