export type WaitingStage = 'submitted' | 'queued' | 'forwarded' | 'started';

export function getWaitingStatusLabel(stage: WaitingStage): string {
  if (stage === 'submitted') return '消息发送中';
  if (stage === 'queued') return '已排队，等待处理';
  if (stage === 'forwarded') return '正在启动';
  return '处理中';
}
