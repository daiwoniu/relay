import type { ProjectDeletionImpactDto } from '../../generated/relay-contracts';

export type ProjectDeletionImpactState =
  | { projectId: string; status: 'loading'; impact: null }
  | { projectId: string; status: 'ready'; impact: ProjectDeletionImpactDto }
  | { projectId: string; status: 'unavailable'; impact: null };

export function getProjectDeleteMenuState(
  isSystem: boolean,
  state: ProjectDeletionImpactState | null,
  hasVisibleInProgressSession = false,
  deletionProtected = false,
  isDefaultProject = false,
): { disabled: boolean; reason?: string } {
  if (isSystem) return { disabled: true, reason: '默认项目不允许删除' };
  if (isDefaultProject) return { disabled: true, reason: '当前是默认项目，请先切换默认项目' };
  if (deletionProtected) return { disabled: true, reason: '该项目已设置为不可删除' };
  if (!state || state.status === 'loading') return { disabled: true, reason: '正在确认项目状态…' };
  if (state.status === 'unavailable') return { disabled: true, reason: '暂时无法确认项目状态' };
  if (state.impact.inProgressSessionCount > 0 || hasVisibleInProgressSession) {
    return { disabled: true, reason: '项目中有会话正在处理中，完成后才能删除' };
  }
  return { disabled: false };
}
