import {useEffect,useState,type RefObject} from 'react';
export default function AnalyticsBackToTop({viewportRef}:{viewportRef:RefObject<HTMLElement|null>}){
  const [visible,setVisible]=useState(false);
  useEffect(()=>{
    const viewport=viewportRef.current;
    if(!viewport)return;
    const update=()=>setVisible(viewport.scrollTop>400);
    update();viewport.addEventListener('scroll',update,{passive:true});
    return()=>viewport.removeEventListener('scroll',update);
  },[viewportRef]);
  return visible?<div className="analytics-back-top-rail"><button type="button" className="analytics-back-top" onClick={()=>viewportRef.current?.scrollTo({top:0,behavior:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})}>
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 12 6-6 6 6M12 6v14"/></svg><span>回到顶部</span>
  </button></div>:null;
}
