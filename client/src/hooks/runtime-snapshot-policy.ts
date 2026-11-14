import type { ProcessItemDto, ProcessTimelineEntryDto, SessionStatus } from '../generated/relay-contracts.ts';
import { hasVisibleProcessPresentation } from '../stores/process-step-visibility.ts';
import type { WaitingStage } from '../utils/waiting-status';

export interface RuntimeSnapshotInput {
  sessionId: string;
  startTime: number | null;
  requestForwarded: boolean;
  isRunning: boolean;
  isStopping: boolean;
  currentContent: string;
  processContent?: string;
  processSteps: ProcessItemDto[];
  processTimeline?: ProcessTimelineEntryDto[];
  queue?: { state: 'queued' | 'claimed' } | null;
}

export interface RuntimeSnapshotProjection {
  sessionId: string;
  startTime: number | null;
  waitingStage: WaitingStage;
  isStreaming: boolean;
  isStopping: boolean;
  currentContent: string;
  processContent: string;
  processSteps: ProcessItemDto[];
  processTimeline: ProcessTimelineEntryDto[];
}

export function hasPendingRuntimeInteraction(input: RuntimeSnapshotInput): boolean {
  return input.processSteps.some((item) => item.type === 'interaction' && item.status === 'in_progress');
}

export function shouldPresentRuntimeSnapshot(input: RuntimeSnapshotInput): boolean {
  return Boolean(input.queue) || input.isRunning || input.isStopping || hasPendingRuntimeInteraction(input);
}

export function projectRuntimeSnapshot(
  input: RuntimeSnapshotInput,
  sessionStatus?: SessionStatus | null,
): RuntimeSnapshotProjection {
  const hasPresentation = Boolean(input.currentContent)
    || hasVisibleProcessPresentation(input.processContent, input.processSteps);
  const isStreaming = hasPresentation
    || input.isRunning && (sessionStatus === 'processing' || sessionStatus === 'recovering');
  return {
    sessionId: input.sessionId,
    startTime: input.startTime,
    waitingStage: isStreaming ? 'started' : input.queue?.state === 'queued' ? 'queued' : input.requestForwarded || input.queue?.state === 'claimed' ? 'forwarded' : 'submitted',
    isStreaming,
    isStopping: input.isStopping,
    currentContent: input.currentContent,
    processContent: input.processContent ?? '',
    processSteps: [...input.processSteps],
    processTimeline: [...(input.processTimeline ?? [])],
  };
}
