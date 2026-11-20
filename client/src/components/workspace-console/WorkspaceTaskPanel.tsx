import type { WorkspaceConsoleDashboardDto } from '../../generated/relay-contracts';
import WorkspaceSessionPanel from './WorkspaceSessionPanel';
type Task=WorkspaceConsoleDashboardDto['tasks'][number];
export default function WorkspaceTaskPanel({task,dashboard,userId,onChanged,onLaunch,onContinue}:{
  task:Task;dashboard:WorkspaceConsoleDashboardDto;userId:string;onChanged():Promise<void>|void;
  onLaunch(task:Task,dashboard:WorkspaceConsoleDashboardDto,fromSessionId?:string,newTab?:boolean):string|null;
  onContinue(sessionId:string):string|null|void;
}){
  return <>
    {!!task.diagnostics?.length&&<p role="status" className="text-xs text-amber-200">台账需核对：{task.diagnostics.join('；')}</p>}
    <WorkspaceSessionPanel taskId={task.id} dashboard={dashboard} userId={userId} onChanged={onChanged}
      onNew={()=>onLaunch(task,dashboard,undefined,true)} onOpen={onContinue}/>
  </>;
}
