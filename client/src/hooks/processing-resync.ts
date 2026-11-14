import type { SessionStatus } from '../stores/chat';

export const PROCESSING_RESYNC_DELAYS_MS = [3_000, 8_000, 20_000] as const;

interface BlankProcessingInput {
  activeSessionId: string | null;
  streamingSessionId: string | null;
  sessionStatus: SessionStatus | null | undefined;
  hasPresentation: boolean;
  isStopping: boolean;
  isAwaitingAction: boolean;
}

export function shouldResyncBlankProcessing(input: BlankProcessingInput): boolean {
  if (!input.activeSessionId || input.sessionStatus !== 'processing') return false;
  if (input.hasPresentation || input.isStopping || input.isAwaitingAction) return false;
  return !input.streamingSessionId || input.streamingSessionId === input.activeSessionId;
}

export function getBlankProcessingPresentation(elapsedMs: number): {
  message: string;
  allowManualResync: boolean;
} {
  if (elapsedMs < 8_000) {
    return {
      message: '任务已启动，等待首个输出…',
      allowManualResync: false,
    };
  }
  if (elapsedMs < 30_000) {
    return {
      message: '模型仍在处理中，暂未返回内容',
      allowManualResync: true,
    };
  }
  return {
    message: '处理时间较长，正在同步最新状态…',
    allowManualResync: true,
  };
}
