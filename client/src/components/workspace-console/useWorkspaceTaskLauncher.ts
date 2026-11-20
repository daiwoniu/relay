import {featureAction} from '../../analytics/features';
import type {WorkspaceConsoleDashboardDto} from '../../generated/relay-contracts';
import {useChatStore} from '../../stores/chat';
import {getAttachmentDraftKey} from '../chat/attachment-drafts';
import {getChatDraftKey} from '../chat/chat-drafts';
import {buildWorkspaceEntryLaunch,type WorkspaceSessionEntry} from './workspace-task-entry';
import {clearWorkspaceTaskLaunch,openWorkspaceTaskSession,prepareWorkspaceTaskLaunch,workspaceSessionUrl} from './workspace-task-launch';

export function useWorkspaceTaskLauncher() {
  const continueSession=(sessionId:string):string|null=>{
    const tab=window.open('about:blank','_blank');
    if(!tab)return '浏览器阻止了新标签页，请允许弹出窗口后重试。';
    try{
      clearWorkspaceTaskLaunch(tab.sessionStorage);
      tab.sessionStorage.removeItem('relay:workspace-prefill');
      tab.opener=null;
      tab.location.replace(workspaceSessionUrl(window.location.href,sessionId));
      featureAction('workbench','open_session','workbench');
      return null;
    }catch{
      tab.close();
      return '无法在新标签页打开会话，请重试。';
    }
  };

  const launchTaskEntry=(entry:WorkspaceSessionEntry,dashboard:WorkspaceConsoleDashboardDto|null):string|null=>{
    if(!dashboard)return '工作区尚未读取成功，请刷新后重试。';
    const project=useChatStore.getState().projects.find(item=>item.path.toLowerCase()===dashboard.workspacePath.toLowerCase());
    if(!project)return '固定工作区项目尚未登记到 Relay，请先在侧栏添加该项目。';
    const tab=window.open('about:blank','_blank');
    if(!tab)return '浏览器阻止了新标签页，请允许弹出窗口后重试。';
    try{
      const draftKey=getChatDraftKey({sessionId:null,pendingProjectPath:null,currentProjectId:project.id});
      tab.sessionStorage.removeItem(draftKey);
      tab.sessionStorage.removeItem(getAttachmentDraftKey(draftKey));
      tab.sessionStorage.removeItem('relay:workspace-prefill');
      clearWorkspaceTaskLaunch(tab.sessionStorage);
      prepareWorkspaceTaskLaunch(tab.sessionStorage,buildWorkspaceEntryLaunch(entry,project.id,dashboard.workspaceId));
      tab.opener=null;
      const url=new URL('/',window.location.href);
      url.searchParams.set('workspaceProject',project.id);
      tab.location.replace(url.href);
      featureAction('workbench','open_session','workbench');
      return null;
    }catch{
      tab.close();
      return '无法在新标签页准备任务草稿，请重试。';
    }
  };

  const continueTaskSession=async(dashboard:WorkspaceConsoleDashboardDto|null,sessionId:string,isCurrent:()=>boolean):Promise<string|null>=>openWorkspaceTaskSession(dashboard,sessionId,{isCurrent,open:continueSession});
  return {continueSession,launchTaskEntry,continueTaskSession};
}
