export type AnalyticsSourceType='external'|'internal'|'none';
export function classifyAnalyticsSource(referrer:string|undefined,currentUrl:string,relayOrigins?:string[]):{sourceType?:AnalyticsSourceType;referrerHost:string|null};
export function analyticsRelayOrigins(config:{frontend:{origin:string};publicAccess:{addresses:Array<{origin:string}>}}):string[];
