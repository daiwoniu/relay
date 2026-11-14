export interface PlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

/** Keep only the display contract; never copy arbitrary tool fields into history. */
export function presentPlan(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PlanStep[] => {
    if (!entry || typeof entry !== 'object' || typeof entry.step !== 'string' || !entry.step.trim()) return [];
    const status = entry.status === 'in_progress' ? 'inProgress' : entry.status;
    if (status !== 'pending' && status !== 'inProgress' && status !== 'completed') return [];
    return [{ step: entry.step, status }];
  });
}
