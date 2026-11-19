import {findAnalyticsRegistration,type AnalyticsFeature,type AnalyticsSurface} from '../../../server/src/analytics/registry.ts';
import type {createTracker} from './tracker.ts';
type ViewTracker=Pick<ReturnType<typeof createTracker>,'view'|'capture'|'endView'|'subscribeContext'>;

/** A mounted view survives StrictMode's synchronous effect replay; a real close uses its opening context. */
export function createFeatureViewObserver(tracker:ViewTracker){
  const instance={};let generation=0,currentKey='',close:(()=>void)|null=null;
  const end=()=>{try{close?.();}finally{close=null;currentKey='';tracker.endView(instance);}};
  return{mount(feature:AnalyticsFeature,visible:boolean,surface:AnalyticsSurface,action='open'){
    const token=++generation,key=`${feature}:${action}`;
    if(!visible){end();return()=>{};}
    if(currentKey&&currentKey!==key)end();
    const show=()=>{
      if(!tracker.view({feature,surface,action},instance))return;
      currentKey=key;
      const entry=findAnalyticsRegistration('feature_action',feature,'close'),captured=tracker.capture();
      close=entry?.outcome==='none'?()=>{captured.track('feature_action',{feature,action:'close',surface});}:null;
    };
    show();const unsubscribe=tracker.subscribeContext(show);
    return()=>{unsubscribe();queueMicrotask(()=>{if(generation===token)end();});};
  }};
}
