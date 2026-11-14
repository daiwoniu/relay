import type { ExecutionStage } from '../../generated/relay-contracts';
import type { WaitingStage } from '../../utils/waiting-status';

interface RunningMessageStateInput {
  isWaiting: boolean;
  isStreaming: boolean;
  isStopping: boolean;
  hasPresentation: boolean;
  errorMessage: string | null;
  waitingStage: WaitingStage;
}

export interface RunningMessageState {
  show: boolean;
  executionStage: ExecutionStage;
}

export function getRunningMessageState(input: RunningMessageStateInput): RunningMessageState {
  return {
    show: !input.errorMessage
      && (input.isWaiting || input.isStreaming || input.isStopping || input.hasPresentation),
    executionStage: input.hasPresentation
      ? 'responding'
      : input.waitingStage === 'started'
        ? 'started'
        : 'accepted',
  };
}
