import type { Context } from 'hono';
export type NewsAnalyticsFact={feature:'news'|'news_admin';action:string;result:'success'|'error'|'rejected'};
export type NewsAnalyticsObserver=(context:Context,fact:NewsAnalyticsFact)=>void;
export function observeNews(observer:NewsAnalyticsObserver|undefined,c:Context,action:string,result:NewsAnalyticsFact['result']='success',feature:NewsAnalyticsFact['feature']='news_admin'){
  try{observer?.(c,{feature,action,result});}catch{/* Metrics never interrupt committed news operations. */}
}
