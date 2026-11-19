import {beijingTime} from './analytics-presentation';
import {LoadError} from './AnalyticsSections';
export type ResourceState={loading:boolean;error:unknown;stale:boolean;updatedAt:number|null;data:unknown;cached?:boolean;retry:()=>void};
export default function AnalyticsResourceState({resource,label}:{resource:ResourceState;label:string}){
  const transient=(resource.loading||resource.stale)&&!resource.error;
  const message=resource.stale&&!resource.loading?'筛选更新未完成，暂显示上次结果':`${label}读取中${resource.data!==null?'，暂显示上次结果':''}…`;
  return <>{Boolean(resource.error)&&<LoadError error={resource.error} retry={resource.retry} stale={resource.data!==null}/>}
    <p role="status" className="analytics-update-status"><span className={transient?'analytics-copy-hidden':undefined} aria-hidden={transient}>{resource.updatedAt?`数据截至 ${beijingTime(resource.updatedAt)}${resource.cached?' · 缓存快照':''}`:resource.error?'暂无可用数据':''}</span><span className={transient?undefined:'analytics-copy-hidden'} aria-hidden={!transient}>{message}</span></p></>;
}
