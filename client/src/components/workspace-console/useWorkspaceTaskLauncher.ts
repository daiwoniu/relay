import { useNavigate } from 'react-router-dom';
import type { WorkspaceConsoleDashboardDto } from '../../generated/relay-contracts';
import { useChatStore } from '../../stores/chat';
import { getAttachmentDraftKey, readAttachmentDrafts } from '../chat/attachment-drafts';
import { getChatDraftKey, readChatDraft } from '../chat/chat-drafts';
import { findContextSessionHandoffSummary } from '../chat/context-session-handoff';
import { buildFeishuWorkItemDraft, buildFeishuWorkItemLaunch, buildWorkspaceTaskDraft, clearWorkspaceTaskLaunch, prepareWorkspaceTaskLaunch, resolveFeishuWorkItemPrimaryAction, resolveWorkspaceTaskPrimaryAction, workspaceTaskSessionTitle } from './workspace-task-launch';

type Task = WorkspaceConsoleDashboardDto['tasks'][number];

export function useWorkspaceTaskLauncher() {
  const navigate = useNavigate();

  const continueSession = (sessionId: string) => {
    useChatStore.getState().setActiveSession(sessionId);
    navigate('/');
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
    const draft = { taskId: task.id, projectId: project.id, ...(!fromSessionId ? { title: workspaceTaskSessionTitle(task) } : {}), text: buildWorkspaceTaskDraft(task, summary), createdAt: Date.now() };
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
        tab.location.replace(url.href);
      } catch {
        tab.close();
        return '无法在新标签页准备任务草稿，请重试。';
      }
      return null;
    }
    state.setCurrentProject(project.id);
    state.setActiveSession('', { autoOpenProjectPicker: false, projectSelectionLocked: true });
    prepareWorkspaceTaskLaunch(sessionStorage, draft);
    navigate('/');
    return null;
  };

  const executePrimary = (task: Task, dashboard: WorkspaceConsoleDashboardDto): string | null => {
    const action = resolveWorkspaceTaskPrimaryAction(task, dashboard.sessions);
    if (action.kind === 'continue') { continueSession(action.sessionId); return null; }
    return launchTask(task, dashboard, undefined, action.newTab);
  };

  const launchFeishuWorkItem = (item: Parameters<typeof buildFeishuWorkItemDraft>[0], dashboard: WorkspaceConsoleDashboardDto | null, completed = false): string | null => {
    if (!dashboard) return '固定工作区尚未读取成功，请刷新任务后重试。';
    const action = resolveFeishuWorkItemPrimaryAction(item.workItemId,dashboard,completed);
    if(action.kind==='continue'){continueSession(action.sessionId);return null;}
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
      prepareWorkspaceTaskLaunch(tab.sessionStorage, buildFeishuWorkItemLaunch(item,project.id));
      tab.opener = null;
      const url = new URL('/', window.location.href);
      url.searchParams.set('workspaceProject', project.id);
      tab.location.replace(url.href);
      return null;
    } catch {
      tab.close();
      return '无法在新标签页准备飞书工作项草稿，请重试。';
    }
  };

  return { continueSession, launchTask, executePrimary, launchFeishuWorkItem };
}
