import { useCallback,useEffect,useId,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import { computeFloatingPosition } from '../ui/floating-position';
import { useOverlay } from '../ui/OverlayProvider';

export const analyticsHelp={
  actions:'统计主动操作，不含访问、结果、系统观察及自动完成。',
  failures:'非系统失败记录，含本地复制、下载失败。同次操作可能有多条记录，不能直接当作失败人数或失败率。',
  features:'访问、操作和结果分别计数，不能相加。数字可联动明细；未采集的历史使用不补算。',
  detailFilters:'下方条件只筛选操作与结果明细，不改变顶部指标或图表。日期及排除身份、内网条件作用于整页业务统计；采集健康计数不受日期影响。',
  result:'仅记录访问或操作的行本身没有成功、失败结果；结果记录单独统计。本地操作有时直接带结果，可通过结果筛选同时查看。',
  system:'系统观察、状态变化或自动完成，默认隐藏；不代表用户主动点击。查看同次操作会包含已采集的系统记录。',
  related:'只看同次操作已采集的触发、结果和系统记录，仍受顶部筛选限制；没有其他记录时只显示一条。',
  trend:'北京时间按日汇总，最多近30天。每日UV不可相加为期间UV；今日为截至快照时的部分数据。',
  quality:'本次后端启动以来的健康计数，重启清零，不随日期筛选变化。批次与事件不可相加；零异常不代表完全无漏记。',
  tools:'仅工具运行记录，不含收藏等界面操作；包括番茄钟自动完成，因此与顶部明确操作计数不同。',
  retention:'统计为尽力采集，不作完整业务审计。未采集的历史不补算，未记录耗时不显示为零。普通读取有短时缓存，浏览器上报可能延迟。',
  views:'刷新页面和站内页面切换都会增加次数；统计页自身和托管请求不计入。',
  visitors:'换设备、浏览器或清除 Cookie 可能重复统计。每日访客数不能直接相加作为整个期间的访客数。',
  admin:'按访问发生时识别到的身份排除；未登录或匿名访问不会推测为管理员。',
  internal:'按可信来源 IP 排除本机及内网访问，无法识别的记录仍保留。通过公网入口访问的设备通常不会被排除；历史记录缺少分类时也会保留。',
  source:'外部域名来自浏览器自动提供的来源信息；浏览器未提供时，Relay 无法恢复。',
  hosting:'重复打开或刷新可能重复计数，不代表阅读人数，也不代表页面已阅读完成。',
  recent:'时间统一按北京时间显示，记录的是服务端接收时间；浏览器批量上报可能晚于实际触发。',
  version:'Web / PWA 为浏览器上报版本；前端网关为处理请求的前端构建版本。旧标签页可能使用较早版本。',
};

/** Explanatory text only: hover/focus on desktop, tap toggle on touch. */
export default function AnalyticsHelp({label,content}:{label:string;content:string}){
  const id=useId(),overlayId=`analytics-help-${id}`;
  const {openOverlay,closeOverlay,isOverlayOpen}=useOverlay();
  const visible=isOverlayOpen('tooltip',overlayId);
  const trigger=useRef<HTMLButtonElement>(null),popup=useRef<HTMLSpanElement>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [position,setPosition]=useState<{left:number;top:number}|null>(null);
  const clear=useCallback(()=>{if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}},[]);
  const close=useCallback(()=>{clear();closeOverlay('tooltip',overlayId);},[clear,closeOverlay,overlayId]);
  const open=()=>{clear();setPosition(null);openOverlay('tooltip',overlayId);};
  const leave=()=>{clear();timer.current=setTimeout(()=>{if(!trigger.current?.matches(':focus-visible'))close();},180);};
  useEffect(()=>()=>{clear();closeOverlay('tooltip',overlayId);},[clear,closeOverlay,overlayId]);
  useEffect(()=>{
    if(!visible)return;
    const update=()=>{if(trigger.current&&popup.current)setPosition(computeFloatingPosition(trigger.current.getBoundingClientRect(),popup.current.getBoundingClientRect(),{width:window.innerWidth,height:window.innerHeight},{preferredPlacement:'top',gap:6,padding:8}));};
    const outside=(event:PointerEvent)=>{if(!trigger.current?.contains(event.target as Node)&&!popup.current?.contains(event.target as Node))close();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
    const scroll=(event:Event)=>{if(!popup.current?.contains(event.target as Node))close();};
    const collapse=(event:Event)=>{const details=event.target as HTMLDetailsElement;if(details.tagName==='DETAILS'&&!details.open&&details.contains(trigger.current))close();};
    const frame=requestAnimationFrame(update);
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',escape,true);
    document.addEventListener('toggle',collapse,true);
    window.addEventListener('scroll',scroll,true);
    window.addEventListener('resize',close);
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);document.removeEventListener('toggle',collapse,true);window.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',close);};
  },[visible,close,content]);
  return <><button ref={trigger} type="button" className="analytics-help" aria-label={`${label}说明`} aria-describedby={visible?id:undefined} aria-expanded={visible}
    onPointerEnter={event=>{if(event.pointerType!=='touch'&&window.matchMedia('(hover: hover) and (pointer: fine)').matches){clear();timer.current=setTimeout(open,300);}}}
    onPointerLeave={event=>{if(event.pointerType!=='touch')leave();}} onPointerCancel={close}
    onFocus={event=>{if(event.currentTarget.matches(':focus-visible'))open();}} onBlur={close}
    onClick={event=>{event.stopPropagation();if(visible)close();else open();}}>
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 5.5v1"/></svg>
  </button>{visible&&createPortal(<span ref={popup} id={id} role="tooltip" className="analytics-help-popup" style={{left:position?.left??0,top:position?.top??0,visibility:position?'visible':'hidden'}} onPointerEnter={clear} onPointerLeave={event=>{if(event.pointerType!=='touch')leave();}}>{content.replace(/([。；;])[ \t]*(?=\S)/g,'$1\n')}</span>,document.body)}</>;
}
