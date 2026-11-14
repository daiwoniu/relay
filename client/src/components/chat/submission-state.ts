export type SubmissionPhase = 'preparing-attachments' | 'sending' | 'verifying';

export interface SubmissionState {
  draftKey: string;
  phase: SubmissionPhase;
}

export function beginSubmissionState(draftKey: string, phase: SubmissionPhase): SubmissionState {
  return { draftKey, phase };
}

export function getSubmissionPhase(
  state: SubmissionState | null,
  draftKey: string,
): SubmissionPhase | 'idle' {
  return state?.draftKey === draftKey ? state.phase : 'idle';
}

export function updateSubmissionState(
  state: SubmissionState | null,
  draftKey: string,
  phase: SubmissionPhase,
): SubmissionState | null {
  return state?.draftKey === draftKey ? { draftKey, phase } : state;
}

export function clearSubmissionState(
  state: SubmissionState | null,
  draftKey: string,
): SubmissionState | null {
  return state?.draftKey === draftKey ? null : state;
}
