import { clearTurnModelSnapshot, type SessionRuntime } from '../engine/runtime.js';

export function resetSessionRuntime(runtime: SessionRuntime, resolvePending: (interactionId: string) => void): void {
  if (runtime.recoveryInteractionTimer) clearTimeout(runtime.recoveryInteractionTimer);
  runtime.recoveryInteractionTimer = null;
  if (runtime.standaloneInteractionTimer) clearTimeout(runtime.standaloneInteractionTimer);
  runtime.standaloneInteractionTimer = null;
  runtime.standaloneInteractionItems = [];
  for (const interactionId of runtime.pendingInteractions.keys()) resolvePending(interactionId);
  Object.assign(runtime, {
    turnStartTime: null, currentTurnId: null, turnItems: [], processTimeline: [], currentContent: '',
    commentaryContent: '', finalAnswerContent: '', lastFinalAnswerItemId: null, isRunning: false, isStopping: false,
    requestForwarded: false, interactionCancelRequested: false, latestTokenUsage: null, tokenUsage: null,
    isRecovering: false, recoveryPreviousStatus: null, attemptId: null, resourceKey: null,
    leaseToken: null, requestedByUserId: null,
  });
  runtime.pendingInteractions.clear();
  clearTurnModelSnapshot(runtime);
}
