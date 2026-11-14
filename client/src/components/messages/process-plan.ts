import type { ProcessStep } from '../../stores/chat';

export interface PlanEntry {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export function isStructuredPlan(step: ProcessStep): boolean {
  return step.type === 'plan' && Array.isArray(step.details.plan);
}

export function getProcessPlan(steps: ProcessStep[]) {
  const item = [...steps].reverse().find(isStructuredPlan);
  if (!item) return null;
  const entries = (item.details.plan as unknown[]).filter((entry): entry is PlanEntry => {
    if (!entry || typeof entry !== 'object') return false;
    const value = entry as PlanEntry;
    return typeof value.step === 'string' && Boolean(value.step.trim())
      && ['pending', 'inProgress', 'completed'].includes(value.status);
  });
  if (!entries.length) return null;
  const explanation = typeof item.details.explanation === 'string'
    ? item.details.explanation.trim()
    : '';
  return {
    id: item.id,
    entries,
    completed: entries.filter((entry) => entry.status === 'completed').length,
    active: entries.find((entry) => entry.status === 'inProgress') || null,
    explanation: explanation || null,
  };
}

export function getProcessPlanTitle(
  plan: NonNullable<ReturnType<typeof getProcessPlan>>,
  running: boolean,
): string {
  if (plan.completed === plan.entries.length) return '计划完成';
  if (running) return '正在执行';
  return '执行结束';
}
