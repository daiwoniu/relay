import { useEffect,useRef } from 'react';
import { tracker } from './tracker.ts';
import { type AnalyticsFeature,type AnalyticsSurface,type AnalyticsFeatureProperties } from '../../../server/src/analytics/registry.ts';
import {createFeatureViewObserver} from './feature-view.ts';
import { generateUUID } from '../utils/uuid.ts';
export function remoteIntent(feature:AnalyticsFeature,action:string,surface:AnalyticsSurface){
  try{const operationId=generateUUID();tracker.action({feature,action,surface,operationId});return operationId;}catch{return undefined;}
}
export function useFeatureView(feature:AnalyticsFeature,visible:boolean,surface:AnalyticsSurface,action='open'){
  const observer=useRef<ReturnType<typeof createFeatureViewObserver>|null>(null);
  observer.current??=createFeatureViewObserver(tracker);
  useEffect(()=>observer.current!.mount(feature,visible,surface,action),[feature,visible,surface,action]);
}
export function featureAction(feature:AnalyticsFeature,action:string,surface:AnalyticsSurface){
  return tracker.action({feature,action,surface});
}
/** Compare locally; the query itself never enters an event. Enter followed by blur emits once. */
export function useSearchCommit(feature:AnalyticsFeature,surface:AnalyticsSurface){
  const previous=useRef('');
  return(query:string)=>{const next=query.trim();if(next===previous.current)return;previous.current=next;featureAction(feature,'search',surface);};
}
/** Local outcomes only; never turns a remote HTTP response into a committed result. */
export function localAction(feature:AnalyticsFeature,action:string,surface:AnalyticsSurface){
  const captured=tracker.capture();let settled=false;
  return(ok:boolean|NonNullable<AnalyticsFeatureProperties['result']>)=>{if(settled)return false;settled=true;return captured.track('feature_action',{feature,action,surface,result:typeof ok==='boolean'?(ok?'success':'error'):ok});};
}
