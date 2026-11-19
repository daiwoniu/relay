import {tracker} from './tracker.ts';
import type {AnalyticsFeatureProperties} from '../../../server/src/analytics/registry.ts';
/** Correlate with the server's deterministic ID without transmitting a message identifier. */
export function observeMessageIntent(messageId:string,engine?:AnalyticsFeatureProperties['engine']){
  try{
    const captured=tracker.capture();
    if(!globalThis.crypto?.subtle)return;
    void crypto.subtle.digest('SHA-256',new TextEncoder().encode(`analytics:login:message:${messageId}`)).then(buffer=>{
      const hex=Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join('');
      const operationId=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
      captured.track('feature_action',{feature:'composer',action:'submit',surface:'composer',operationId,...(engine?{engine}: {})});
    }).catch(()=>undefined);
  }catch{/* Telemetry cannot prevent sending a message. */}
}
