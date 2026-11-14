import type { ExecutionStage, MessageOutcome } from '../../generated/relay-contracts';
import { getWaitingStatusLabel, type WaitingStage } from '../../utils/waiting-status.ts';
import { getSessionStatusPresentation } from '../layout/session-status.ts';

export type MessageVisualState = MessageOutcome | 'processing' | 'recovering' | 'awaiting_action' | 'stopping';
export type MessageStatusTone = 'processing' | 'warning' | 'success' | 'danger' | 'stopped' | 'interrupted';

export interface MessageStatusPresentation {
  label: string;
  tone: MessageStatusTone;
  detail?: string;
}

export function shouldExpandProcessWithoutFinalReply(
  isStreaming: boolean,
  hasProcess: boolean,
  finalContent: string,
): boolean {
  return !isStreaming && hasProcess && finalContent.trim().length === 0;
}

export function getMessageStatusPresentation(
  state: MessageVisualState,
  stage: ExecutionStage = 'accepted',
  errorMessage?: string,
  errorCode?: string,
  waitingStage?: WaitingStage,
  pendingKind?: 'approval' | 'input' | 'mixed' | null,
  canRespond = true,
): MessageStatusPresentation {
  const started = stage !== 'accepted';
  const base = getSessionStatusPresentation(state, pendingKind, canRespond, stage);
  switch (state) {
    case 'processing':
      return {
        label: started ? '处理中' : getWaitingStatusLabel(waitingStage || 'forwarded'),
        tone: 'processing',
      };
    case 'recovering':
      return { label: base.label, tone: 'processing' };
    case 'awaiting_action':
      return { label: base.label, tone: 'warning' };
    case 'stopping':
      return { label: base.label, tone: 'stopped' };
    case 'completed':
      return { label: base.label, tone: 'success' };
    case 'failed':
      if (errorCode === 'CODEX_INIT_FAILED' && /thread\/start 请求超时/.test(errorMessage || '')) {
        return {
          label: '新会话创建超时',
          tone: 'danger',
          detail: 'Codex 当前响应较慢，本条消息尚未开始处理。',
        };
      }
      if (errorMessage === '未生成最终回复') {
        return { label: '未生成最终回复', tone: 'danger' };
      }
      return { label: base.label, tone: 'danger', detail: errorMessage };
    case 'stopped':
      if (errorCode === 'CODEX_TURN_INTERRUPTED') {
        return {
          label: '已取消',
          tone: 'stopped',
          detail: '你取消了待授权操作，本轮任务已结束。',
        };
      }
      return {
        label: base.label,
        tone: 'stopped',
        detail: started ? '已保留中断前产生的内容' : '任务尚未开始',
      };
    case 'interrupted':
      return {
        label: base.label,
        tone: 'interrupted',
        detail: errorMessage,
      };
  }
}
