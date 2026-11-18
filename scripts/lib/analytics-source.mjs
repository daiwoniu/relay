/** Only classification and host leave this function; never the raw URL. */
export function classifyAnalyticsSource(referrer,currentUrl,relayOrigins=[]){
  if(typeof referrer!=='string')return{referrerHost:null};
  if(!referrer)return{sourceType:'none',referrerHost:null};
  try{
    const from=new URL(referrer),current=new URL(currentUrl);
    if(!['http:','https:'].includes(from.protocol))return{referrerHost:null};
    const ownOrigins=new Set([current.origin,...relayOrigins.flatMap(origin=>{try{return[new URL(origin).origin];}catch{return[];}})]);
    if(ownOrigins.has(from.origin))return{sourceType:'internal',referrerHost:null};
    const host=from.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    if(host.length>253||(!from.hostname.startsWith('[')&&!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)))return{referrerHost:null};
    return{sourceType:'external',referrerHost:host};
  }catch{return{referrerHost:null};}
}

export function analyticsRelayOrigins(config){
  const origins=[config.frontend.origin,...config.publicAccess.addresses.map(address=>address.origin)];
  const local=new URL(config.frontend.origin);
  if(['127.0.0.1','localhost','[::1]'].includes(local.hostname))for(const name of ['127.0.0.1','localhost','[::1]']){local.hostname=name;origins.push(local.origin);}
  return[...new Set(origins)];
}
