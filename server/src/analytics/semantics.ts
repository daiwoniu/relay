import type { AnalyticsEvent } from './contract.js';
import { findAnalyticsRegistration, type AnalyticsMetric } from './registry.js';

export interface AnalyticsMeaning {
  registrationId: string;
  feature: string;
  action: string;
  metric: AnalyticsMetric;
  result: string | null;
  operationId: string | null;
  automatic: boolean;
  analyticsSelf: boolean;
}

/** One event has one metric. Never add result counts to user action counts. */
export function analyticsMeaning(event: AnalyticsEvent): AnalyticsMeaning {
  const base = { result:null,operationId:null,automatic:false,analyticsSelf:event.page === 'analytics_admin' };
  switch (event.name) {
    case 'page_view': return {...base,registrationId:'page.view',feature:event.page,action:'open',metric:'page'};
    case 'tool_open': return {...base,registrationId:`tool.${event.properties.toolId}.open`,feature:`tool.${event.properties.toolId}`,action:'open',metric:'view'};
    case 'tool_action': return {...base,registrationId:`tool.${event.properties.toolId}.${event.properties.action}`,feature:`tool.${event.properties.toolId}`,action:event.properties.action,metric:'action',result:event.properties.result,automatic:event.properties.toolId === 'pomodoro' && event.properties.action === 'complete'};
    case 'news_click': return {...base,registrationId:'news.read',feature:'news',action:'read',metric:'action'};
    case 'login_result': return {...base,registrationId:'auth.login.result',feature:'auth',action:'login',metric:'result',result:event.properties.result ?? null};
    case 'hosting_document': return {...base,registrationId:'hosting.document',feature:'hosting',action:'document',metric:'hosting'};
    default: {
      const props = event.properties;
      const entry = findAnalyticsRegistration(event.name,props.feature,props.action);
      if (!entry) throw new Error('Unregistered analytics event');
      return {
        ...base,registrationId:entry.id,feature:props.toolId ? `tool.${props.toolId}` : entry.feature,action:entry.action,metric:entry.metric,
        result:props.result ?? null,operationId:props.operationId ?? null,
        automatic:props.trigger === 'automatic' || entry.metric === 'system',
        analyticsSelf:base.analyticsSelf || entry.feature === 'analytics',
      };
    }
  }
}
