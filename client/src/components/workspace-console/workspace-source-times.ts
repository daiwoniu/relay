import type {WorkspaceConsoleDashboardDto,WorkspaceConsoleResponsibilityDto} from '../../generated/relay-contracts';

/** Full snapshot content time, independent of collection time and visible card filters. */
export function latestFeishuTaskUpdatedAt(report:Pick<WorkspaceConsoleResponsibilityDto,'items'|'workbenchItems'>|null):number|null{
  let latest:number|null=null;
  const add=(value?:string|null)=>{
    if(typeof value!=='string'||!value.trim())return;
    const at=Date.parse(value);
    if(Number.isFinite(at)&&at>0&&(latest===null||at>latest))latest=at;
  };
  for(const item of report?.items??[]){
    add(item.updatedAt);
    for(const child of item.personalSubtasks??[])add(child.updatedAt);
  }
  for(const item of report?.workbenchItems??[]){
    add(item.updatedAt);
    for(const child of item.mySubtasks??[])add(child.updatedAt);
  }
  return latest;
}

export type WorkspaceRefreshTimes={local:number|null;project:number|null};

export interface WorkspaceSourceRefreshActivity {
  pending: number;
  startedAt: number | null;
  finishedAt: number | null;
  dismissed: boolean;
  succeeded: boolean;
}

export function isSuccessfulDashboardRefresh(value: Pick<WorkspaceConsoleDashboardDto, 'sourceMeta' | 'errors'>, force = false): boolean {
  const state = value.sourceMeta?.state;
  return value.errors.length === 0 && (state === 'live' || (force && state === undefined));
}

export function isSuccessfulResponsibilityRefresh(
  value: Pick<WorkspaceConsoleResponsibilityDto, 'servedFromCache' | 'sourceMeta' | 'stale' | 'error'>,
  force = false,
): boolean {
  const state = value.sourceMeta?.state;
  return !value.servedFromCache && !value.stale && !value.error
    && (state === 'live' || (force && state === undefined));
}

type StorageReader=Pick<Storage,'getItem'>;
const validTime=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const refreshKey=(userId:string)=>`relay:workspace-console:successful-refresh:${userId}`;
export function readWorkspaceRefreshTimes(storage:StorageReader|null,userId:string):WorkspaceRefreshTimes{
  try{
    const data=JSON.parse(storage?.getItem(refreshKey(userId))??'null');
    return {local:validTime(data?.local)?data.local:null,project:validTime(data?.project)?data.project:null};
  }catch{return {local:null,project:null};}
}
export function rememberWorkspaceRefreshTime(storage:(StorageReader&Pick<Storage,'setItem'>)|null,userId:string,source:keyof WorkspaceRefreshTimes,completedAt:number):WorkspaceRefreshTimes{
  const times=readWorkspaceRefreshTimes(storage,userId);
  if(validTime(completedAt))times[source]=Math.max(times[source]??0,completedAt);
  try{storage?.setItem(refreshKey(userId),JSON.stringify(times));}catch{/* Memory state still updates if browser storage is unavailable. */}
  return times;
}

export async function trackSuccessfulWorkspaceRefresh<T>(request:()=>Promise<T>,successful:(value:T)=>boolean,remember:(completedAt:number)=>void,now:()=>number=Date.now):Promise<T>{
  const value=await request();
  if(successful(value))remember(now());
  return value;
}
