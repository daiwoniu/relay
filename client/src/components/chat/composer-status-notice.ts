import type { SubmissionPhase } from './submission-state';

export type ComposerNoticeTone = 'info' | 'processing' | 'warning' | 'danger';

export interface ComposerStatusNoticeValue {
  id: string;
  message: string;
  tone: ComposerNoticeTone;
  reason: string;
  nextStep: string;
}

export interface ComposerNoticePayload {
  message: string;
  tone: ComposerNoticeTone;
  reason?: string;
  nextStep?: string;
}

export function isEngineStatusBlocking(status: ComposerNoticePayload | null): boolean {
  return Boolean(status && status.tone !== 'warning');
}

export function prioritizeComposerStatusNotices(notices: ComposerStatusNoticeValue[]): ComposerStatusNoticeValue[] {
  return [
    ...notices.filter((item) => item.tone === 'warning' || item.tone === 'danger'),
    ...notices.filter((item) => item.tone === 'info' || item.tone === 'processing'),
  ];
}

interface ComposerStatusNoticeInput {
  attachmentNotice: ComposerNoticePayload | null;
  isAwaitingAction: boolean;
  canRespondToInteraction?: boolean;
  engineStatusNotice: ComposerNoticePayload | null;
  isQueued: boolean;
  submissionPhase: SubmissionPhase | 'idle';
}

function notice(id: string, message: string, tone: ComposerNoticeTone, reason: string, nextStep: string): ComposerStatusNoticeValue {
  return { id: `${id}:${message}`, message, tone, reason, nextStep };
}

export function getComposerStatusNotices(input: ComposerStatusNoticeInput): ComposerStatusNoticeValue[] {
  const notices: ComposerStatusNoticeValue[] = [];
  if (input.isAwaitingAction) notices.push(input.canRespondToInteraction === false
    ? notice('awaiting-action', '等待会话所有人处理', 'warning', '当前回复正在等待会话所有人处理操作请求。', '等待会话所有人授权或回答；你可以继续查看消息。')
    : notice('awaiting-action', '请先处理上方操作请求', 'warning',
      '当前回复正在等待你处理上方的操作请求，输入框会暂时锁定。', '到上方消息中处理请求，或使用停止等待按钮。'));
  if (input.engineStatusNotice) notices.push(notice('engine-status', input.engineStatusNotice.message, input.engineStatusNotice.tone,
    input.engineStatusNotice.reason || '当前引擎状态发生变化，提示文本是系统得到的状态说明。',
    input.engineStatusNotice.nextStep || '根据提示检查引擎状态；如果仍不可用，请稍后重试。'));
  if (input.attachmentNotice) notices.push(notice('attachment', input.attachmentNotice.message, input.attachmentNotice.tone,
    input.attachmentNotice.reason || '本次发送或附件操作没有按预期完成，提示文本包含实际结果。',
    input.attachmentNotice.nextStep || '检查提示中的错误，再重试相应操作。'));
  if (input.isQueued) notices.push(notice('queued', '消息已排队', 'info',
    '这条消息还在等待引擎的可用执行时机，系统会在条件满足时自动开始。', '可以继续等待，或点击输入框中的取消排队按钮。'));
  if (input.submissionPhase === 'verifying') notices.push(notice('verifying', '正在核实发送结果，请勿重复发送…', 'processing',
    '发送结果尚未确定，系统正在确认消息是否已被接收。', '等待核实结束；此时重复发送可能产生两条消息。'));
  if (input.submissionPhase === 'preparing-attachments') notices.push(notice('preparing-attachments', '正在准备附件…', 'processing',
    '发送前正在授权或整理本条消息的附件。', '等待附件准备完成，系统会继续发送。'));
  if (input.submissionPhase === 'sending') notices.push(notice('sending', '正在发送…', 'processing',
    '本条消息的发送请求正在进行。', '等待发送结果，无需再次点击发送。'));
  return notices;
}

export function getComposerStatusNotice(input: ComposerStatusNoticeInput): ComposerStatusNoticeValue | null {
  return getComposerStatusNotices(input)[0] ?? null;
}
