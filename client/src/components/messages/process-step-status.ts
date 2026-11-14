interface ProcessStepStatusInput {
  type?: string;
  status: string;
  details?: { exitCode?: unknown; errorCode?: unknown; failureCode?: unknown; completedObservedAt?: unknown; resolvedAction?: unknown; success?: unknown };
}

export function isPendingProcessInteraction(step: ProcessStepStatusInput, answered = false): boolean {
  return step.type === 'interaction' && step.status === 'in_progress' && !step.details?.resolvedAction && !answered;
}

export function getProcessStepStatus(step: ProcessStepStatusInput): string {
  const details = step.details;
  const exitCode = details?.exitCode;
  if (step.status === 'incomplete' || details?.errorCode || details?.failureCode || step.type === 'dynamicToolCall' && details?.success === false
    || (exitCode != null && Number.isFinite(Number(exitCode)) && Number(exitCode) !== 0)) return 'incomplete';
  if (step.type === 'interaction' && typeof details?.resolvedAction === 'string'
    && ['accept', 'accept_for_session', 'decline', 'cancel', 'submit', 'submitted', 'resolved_elsewhere'].includes(details.resolvedAction)) return 'completed';
  const completed = details?.completedObservedAt;
  if (step.type !== 'interaction' && step.status === 'in_progress' && typeof completed === 'number' && Number.isSafeInteger(completed) && completed >= 0 && completed <= 8.64e15) return 'completed';
  return step.status;
}

export function getProcessStepStatusCounts(steps: ProcessStepStatusInput[]) {
  let completedCount = 0;
  let inProgressCount = 0;
  let failedCount = 0;

  for (const step of steps) {
    const status = getProcessStepStatus(step);
    if (status === 'in_progress') {
      inProgressCount += 1;
      continue;
    }
    if (status === 'incomplete') {
      failedCount += 1;
      continue;
    }
    completedCount += 1;
  }

  return { completedCount, inProgressCount, failedCount };
}
