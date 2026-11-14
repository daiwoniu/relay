import type { Message } from '../../stores/chat';
import type { SessionFollowupDto } from '../../generated/relay-contracts';
import type { FlowInput, FlowState, FlowUiState, ProcessView } from './process-flow-model';

export function resetFlowCategoryExpansion(ui: FlowUiState, keepRoot = false, parentId?: string) {
  if (!keepRoot) ui.categoryOpen = {};
  ui.selectedNodeId = undefined;
  const scope = parentId ? `${parentId}:` : '';
  for (const key of Object.keys(ui.expanded)) if (key.startsWith(`subgroup:${scope}`) || key.startsWith(`capability:${scope}`)) delete ui.expanded[key];
}

export function parseProcessView(value: string | null): ProcessView { return value === 'time' || value === 'category' ? value : 'list'; }

export function hasFlowTextSelection(selection: Pick<Selection, 'isCollapsed' | 'anchorNode' | 'focusNode'> | null, container: Pick<Node, 'contains'>): boolean {
  return Boolean(selection && !selection.isCollapsed && (container.contains(selection.anchorNode) || container.contains(selection.focusNode)));
}

export function makeFlowInput(message: Pick<Message, 'id' | 'content' | 'replyToAsyncQuestionId' | 'attachments'> & { created_at?: number }, initial = false): FlowInput {
  return { id: `input:${message.id}`, recordedAt: message.created_at, content: message.content || '附件消息', kind: message.replyToAsyncQuestionId ? 'answer' : initial ? 'initial' : 'supplement', delivery: initial ? '请求已接收' : '消息已保存', state: 'completed', positionKnown: initial, attachments: message.attachments };
}

const DELIVERY: Record<SessionFollowupDto['state'], [string, FlowState]> = {
  received: ['已接收，尚未送达', 'waiting'], steering: ['正在加入当前执行', 'waiting'], steered: ['已送入当前执行', 'completed'],
  queued: ['等待下一轮处理', 'waiting'], dispatching: ['正在转入下一轮', 'waiting'], delivered: ['已转入下一轮', 'completed'],
  paused: ['后续消息已暂停', 'waiting'], uncertain: ['送达结果未确认', 'unknown'], cancelled: ['后续消息已取消', 'stopped'],
};
export function makeFlowFollowup(followup: SessionFollowupDto): FlowInput {
  const [delivery, state] = DELIVERY[followup.state];
  return { ...makeFlowInput({ ...followup, created_at: followup.createdAt, replyToAsyncQuestionId: followup.replyToAsyncQuestionId || undefined }), delivery, state };
}
