type Flushable={flush:(keepalive?:boolean)=>Promise<void>};
type Schedule={set:(callback:()=>void,ms:number)=>unknown;clear:(handle:unknown)=>void};
type Life={owners:number;stop:()=>void};
const mounted=new WeakMap<object,WeakMap<EventTarget,Life>>();

/** Multiple owners share one timer/listener set; effect cleanup is idempotent. */
export function attachAnalyticsLifecycle(
  tracker:Flushable,windowTarget:EventTarget,documentTarget:EventTarget & {visibilityState:string},
  schedule:Schedule={set:(callback,ms)=>setInterval(callback,ms),clear:handle=>clearInterval(handle as ReturnType<typeof setInterval>)},
){
  let windows=mounted.get(tracker);
  if(!windows){windows=new WeakMap();mounted.set(tracker,windows);}
  let life=windows.get(windowTarget);
  if(!life){
    const flush=(keepalive=false)=>{
      try{void tracker.flush(keepalive).catch(()=>undefined);}catch{/* Lifecycle telemetry cannot break navigation. */}
    };
    const hide=()=>flush(true),visibility=()=>{if(documentTarget.visibilityState==='hidden')hide();};
    const timer=schedule.set(()=>flush(),5000);
    windowTarget.addEventListener('pagehide',hide);
    documentTarget.addEventListener('visibilitychange',visibility);
    life={owners:0,stop:()=>{
      schedule.clear(timer);windowTarget.removeEventListener('pagehide',hide);
      documentTarget.removeEventListener('visibilitychange',visibility);
    }};
    windows.set(windowTarget,life);
  }
  life.owners++;const active=life,activeWindows=windows;let detached=false;
  return()=>{
    if(detached)return;detached=true;
    if(--active.owners===0){active.stop();activeWindows.delete(windowTarget);}
  };
}
