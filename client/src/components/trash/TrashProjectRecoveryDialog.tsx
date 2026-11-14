import { useState } from 'react';
import type { ApiErrorDto, ProjectDto } from '../../generated/relay-contracts';
import { createProject, getProjectInTrashConflict, listProjects, restoreProjectFromTrash } from '../../api/projects';
import { useChatStore } from '../../stores/chat';
import ConfirmDialog from '../ui/ConfirmDialog';
import { getTrashRestoreNotice, hasTrashRestoreWarning } from './trash-restore-presentation';

type Conflict = { project: NonNullable<ApiErrorDto['projectInTrash']>; path: string; restoreCommitted: boolean };

export function useTrashProjectRecovery() {
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [warning, setWarning] = useState('');
  const createOrPrompt = async (projectPath: string): Promise<ProjectDto> => {
    setWarning('');
    try { return await createProject(projectPath); }
    catch (error) {
      const project = getProjectInTrashConflict(error);
      if (!project) throw error;
      setConflict({ project, path: projectPath, restoreCommitted: false });
      throw new Error('该项目仍在回收站，请确认是否完整恢复');
    }
  };
  const confirm = async () => {
    if (!conflict) return;
    let restoreCommitted = conflict.restoreCommitted;
    let restoreWarning = '';
    try {
      if (!restoreCommitted) {
        const result = await restoreProjectFromTrash(conflict.project.id);
        if (hasTrashRestoreWarning(result)) restoreWarning = getTrashRestoreNotice('project', result);
        restoreCommitted = true;
        setConflict((current) => current?.project.id === conflict.project.id ? { ...current, restoreCommitted: true } : current);
      }
      const store = useChatStore.getState();
      const restored = store.projects.find((project) => project.id === conflict.project.id)
        ?? (await listProjects()).find((project) => project.id === conflict.project.id);
      if (!restored) throw new Error('项目已恢复，但暂时无法刷新项目列表');
      store.addProject(restored);
      if (store.pendingProjectPath === conflict.path) {
        store.setCurrentProject(restored.id);
        store.setPendingProject(null);
      }
      setConflict(null);
      setWarning(restoreWarning);
    } catch (error) {
      const message = error instanceof Error ? error.message : '恢复项目失败';
      useChatStore.getState().setError(restoreCommitted && !message.startsWith('项目已恢复')
        ? `项目已恢复，但刷新项目列表失败：${message}`
        : message);
      throw error;
    }
  };
  return { conflict, warning, createOrPrompt, confirm, cancel: () => setConflict(null), dismissWarning: () => setWarning('') };
}

export type TrashProjectRecovery = ReturnType<typeof useTrashProjectRecovery>;

export default function TrashProjectRecoveryDialog({ recovery }: { recovery: TrashProjectRecovery }) {
  const conflict = recovery.conflict;
  return <><ConfirmDialog open={conflict !== null} eyebrow="项目在回收站" title="恢复原项目？" tone="warning"
    description="此路径对应的项目已被移入回收站，不会创建重复项目。确认后将完整恢复项目与其中的会话。"
    subject={conflict ? { label: '待恢复项目', value: conflict.project.name, detail: `${conflict.project.sessionCount} 个会话` } : undefined}
    impacts={conflict ? [`恢复 ${conflict.project.sessionCount} 个会话`, '自动取消由删除导致的 Codex 归档', '不会创建重复项目'] : []}
    confirmLabel="恢复项目" onCancel={recovery.cancel} onConfirm={recovery.confirm} />
    {recovery.warning && <div role="status" className="fixed bottom-5 left-1/2 z-[80] flex max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-xl border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] px-4 py-3 text-sm text-[var(--color-text)] shadow-lg">
      <span className="min-w-0 flex-1">{recovery.warning}</span>
      <button type="button" className="shrink-0 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]" onClick={recovery.dismissWarning}>关闭</button>
    </div>}
  </>;
}
