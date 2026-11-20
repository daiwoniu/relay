import {featureAction} from '../../analytics/features';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceConsoleDashboardDto } from '../../generated/relay-contracts';
import { useChatStore } from '../../stores/chat';
import { getAttachmentDraftKey, readAttachmentDrafts } from '../chat/attachment-drafts';
import { getChatDraftKey, readChatDraft } from '../chat/chat-drafts';
import {openWorkspaceTaskSession,workspaceSessionUrl} from './workspace-task-launch';
import { findContextSessionHandoffSummary } from '../chat/context-session-handoff';
import { buildFeishuWorkItemDraft, buildFeishuWorkItemLaunch, buildWorkspaceTaskDraft, clearWorkspaceTaskLaunch, prepareWorkspaceTaskLaunch, resolveFeishuWorkItemPrimaryAction, resolveWorkspaceTaskPrimaryAction, workspaceTaskSessionTitle } from './workspace-task-launch';

type Task = WorkspaceConsoleDashboardDto['tasks'][number];

export function useWorkspaceTaskLauncher() {
  const navigate = useNavigate();

  const continueSession = (sessionId: string) => {
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

  const launchTask = (task: Task, dashboard: WorkspaceConsoleDashboardDto, fromSessionId?: string, newTab = false): string | null => {
    const state = useChatStore.getState();
    const project = state.projects.find((item) => item.path.toLowerCase() === dashboard.workspacePath.toLowerCase());
    if (!project) return '固定工作区项目尚未登记到 Relay，请先在侧栏添加该项目。';
    const draftKey = getChatDraftKey({ sessionId: null, pendingProjectPath: null, currentProjectId: project.id });
    if (!newTab && (readChatDraft(sessionStorage, draftKey).trim() || readAttachmentDrafts(sessionStorage, getAttachmentDraftKey(draftKey)).length)) {
      return '该工作区已有未发送的草稿或附件，请先处理后再从任务新建会话。';
    }
    const summary = fromSessionId ? findContextSessionHandoffSummary(state.messages[fromSessionId] || []) : null;
    const draft = { taskId: task.id, workspaceId:dashboard.workspaceId, projectId: project.id, ...(!fromSessionId ? { title: workspaceTaskSessionTitle(task) } : {}), text: buildWorkspaceTaskDraft(task, summary), createdAt: Date.now() };
    if (newTab) {
      const tab = window.open('about:blank', '_blank');
      if (!tab) return '浏览器阻止了新标签页，请允许弹出窗口后重试。';
      try {
        tab.sessionStorage.removeItem(draftKey);
        tab.sessionStorage.removeItem(getAttachmentDraftKey(draftKey));
        prepareWorkspaceTaskLaunch(tab.sessionStorage, draft);
        tab.opener = null;
        const url = new URL('/', window.location.href);
        url.searchParams.set('workspaceProject', project.id);
        tab.location.replace(url.href);featureAction('workbench','open_session','workbench');
      } catch {
        tab.close();
        return '无法在新标签页准备任务草稿，请重试。';
      }
      return null;
    }
    state.setCurrentProject(project.id);
    state.setActiveSession('', { autoOpenProjectPicker: false, projectSelectionLocked: true });
    prepareWorkspaceTaskLaunch(sessionStorage, draft);
    featureAction('workbench','open_session','workbench');navigate('/');
    return null;
  };

  const executePrimary = (task: Task, dashboard: WorkspaceConsoleDashboardDto): string | null => {
    const action = resolveWorkspaceTaskPrimaryAction(task, dashboard.sessions);
    if (action.kind === 'continue') return continueSession(action.sessionId);
    if (action.kind === 'choose') return '关联了多个历史会话，请在任务详情中选择。';
    return launchTask(task, dashboard, undefined, true);
  };

  const launchFeishuWorkItem = (item: Parameters<typeof buildFeishuWorkItemDraft>[0] & {parentId?:string}, dashboard: WorkspaceConsoleDashboardDto | null, completed = false,forceNew=false): string | null => {
    if (!dashboard) return '固定工作区尚未读取成功，请刷新任务后重试。';
    const action = forceNew?{kind:'start' as const}:resolveFeishuWorkItemPrimaryAction(item.parentId?`feishu-subtask:${item.parentId}:${item.workItemId}`:item.workItemId,dashboard,completed);
    if(action.kind==='continue')return continueSession(action.sessionId);
    if(action.kind==='choose')return '关联了多个历史会话，请在事项详情中选择。';
    const state = useChatStore.getState();
    const project = state.projects.find((candidate) => candidate.path.toLowerCase() === dashboard.workspacePath.toLowerCase());
    if (!project) return '固定工作区项目尚未登记到 Relay，请先在侧栏添加该项目。';
    const tab = window.open('about:blank', '_blank');
    if (!tab) return '浏览器阻止了新标签页，请允许弹出窗口后重试。';
    try {
      const draftKey = getChatDraftKey({ sessionId: null, pendingProjectPath: null, currentProjectId: project.id });
      tab.sessionStorage.removeItem(draftKey);
      tab.sessionStorage.removeItem(getAttachmentDraftKey(draftKey));
      clearWorkspaceTaskLaunch(tab.sessionStorage);
      prepareWorkspaceTaskLaunch(tab.sessionStorage, buildFeishuWorkItemLaunch(item,project.id,Date.now(),dashboard.workspaceId));
      tab.opener = null;
      const url = new URL('/', window.location.href);
      url.searchParams.set('workspaceProject', project.id);
      tab.location.replace(url.href);featureAction('workbench','open_session','workbench');
      return null;
    } catch {
      tab.close();
      return '无法在新标签页准备飞书工作项草稿，请重试。';
    }
  };

  const continueTaskSession=async(dashboard:WorkspaceConsoleDashboardDto|null,sessionId:string,isCurrent:()=>boolean):Promise<string|null>=>openWorkspaceTaskSession(dashboard,sessionId,{isCurrent,open:continueSession});
  return { continueSession, launchTask, executePrimary, launchFeishuWorkItem,continueTaskSession };
}
