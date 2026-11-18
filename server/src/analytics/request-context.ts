import type { Context } from 'hono';
import { normalizeAnalyticsEnvironment,parseClientEnvironment } from '../../../scripts/lib/client-environment.mjs';
import type { AnalyticsEvent } from './contract.js';
import { isLoopbackIp } from '../../../scripts/lib/client-ip.mjs';

export function trustedGatewayFrontendContext(value:string|undefined,authenticated:boolean,peer:string|undefined):{clientSource?:'gateway';clientVersion?:string}{
  if(!authenticated||!isLoopbackIp(peer))return {};
  const clientVersion=value&&/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(value)?value:undefined;
  return{clientSource:'gateway',...(clientVersion?{clientVersion}:{})};
}

export function analyticsSourceRequestUrl(requestUrl:string,forwardedProto:string|undefined,authenticated:boolean,peer:string|undefined){
  if(!authenticated||!isLoopbackIp(peer)||forwardedProto!=='https')return requestUrl;
  try{const url=new URL(requestUrl);url.protocol='https:';return url.href;}catch{return requestUrl;}
}

/** Transient UA parsing; neither the raw UA nor the request URL is persisted. */
export function analyticsRequestContext(c:Context){
  const ua=(c.req.header('user-agent')??'').slice(0,4096);
  const environment=normalizeAnalyticsEnvironment(parseClientEnvironment({userAgent:ua,relayVersion:''}));
  // An absent/unrecognizable UA is not evidence of a desktop browser.
  if(environment.browser==='Other'&&environment.os==='Other'&&environment.device==='desktop')environment.device='unknown';
  const accessHost=new URL(c.req.url).hostname.toLowerCase().replace(/^\[|\]$/g,'');
  return{environment,accessHost:accessHost.length<=253?accessHost:undefined};
}

export function supplementAnalyticsEnvironment(event:AnalyticsEvent,fallback:ReturnType<typeof analyticsRequestContext>['environment']):AnalyticsEvent{
  return{...event,
    device:event.device==='unknown'?fallback.device:event.device,
    browser:event.browser==='Other'?fallback.browser:event.browser,
    os:event.os==='Other'?fallback.os:event.os,
  };
}
