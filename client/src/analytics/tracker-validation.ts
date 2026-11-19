import { ANALYTICS_TOOL_IDS,validateAnalyticsRegistration } from '../../../server/src/analytics/registry.ts';

export function isExtendedEvent(name:string) {
  return name === 'feature_view' || name === 'feature_action' || name === 'operation_result';
}

/** Reject content fields before any serialization or network request. */
export function validClientProperties(name:string,properties:unknown):boolean {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  if (isExtendedEvent(name)) {
    let valid=true;
    validateAnalyticsRegistration({name,properties},'client',{addIssue:()=>{valid=false;}});
    return valid;
  }
  const p=properties as Record<string,unknown>;
  const keys = name === 'page_view' ? [] : name === 'tool_open' ? ['toolId']
    : name === 'tool_action' ? ['toolId','action','result','errorCode','durationMs']
    : name === 'news_click' ? ['newsId'] : null;
  if (!keys || Object.keys(p).some(key=>!keys.includes(key))) return false;
  if (name === 'page_view') return true;
  if (name === 'news_click') return typeof p.newsId === 'string' && p.newsId.length<=128 && /^[a-zA-Z0-9:._-]+$/.test(p.newsId);
  if (!(ANALYTICS_TOOL_IDS as readonly unknown[]).includes(p.toolId)) return false;
  if (name === 'tool_open') return true;
  return ['format','minify','validate','copy','export_png','export_svg','compare','start','complete','cancel','calculate','randomize'].includes(p.action as string)
    && ['success','invalid_input','error','cancelled'].includes(p.result as string)
    && (p.errorCode === undefined || ['INVALID_INPUT','COPY_FAILED','EXPORT_FAILED','OPERATION_FAILED'].includes(p.errorCode as string))
    && (p.durationMs === undefined || (typeof p.durationMs === 'number' && Number.isInteger(p.durationMs) && p.durationMs>=0 && p.durationMs<=86_400_000));
}
