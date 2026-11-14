import { getProcessStepStatusCounts } from './process-step-status.ts';

interface ProcessOperationStep {
  status: string;
  details?: { exitCode?: unknown };
}

export function getProcessOperationGroupState(steps: ProcessOperationStep[]) {
  const { completedCount, inProgressCount, failedCount } = getProcessStepStatusCounts(steps);
  const progressLabel = [
    `${inProgressCount} 进行中`,
    failedCount > 0 ? `${failedCount} 未完成` : '',
    completedCount > 0 ? `${completedCount} 已完成` : '',
  ].filter(Boolean).join(' · ');

  return {
    label: `${steps.length} 项操作`,
    progressLabel: inProgressCount > 0
      ? progressLabel
      : failedCount > 0
        ? `${failedCount} 项未完成`
        : '已完成',
    tone: inProgressCount > 0
      ? 'processing'
      : failedCount > 0
        ? 'danger'
        : 'completed',
    completedCount,
    inProgressCount,
    failedCount,
  };
}

export function getEffectiveProcessOperationGroupExpanded(
  expanded: boolean,
  containsSearchTarget: boolean,
): boolean {
  return expanded || containsSearchTarget;
}
