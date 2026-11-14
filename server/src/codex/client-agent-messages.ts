const AGENT_MESSAGE_LONG_GAP_MS = 30_000;

export type AgentMessagePhase = 'commentary' | 'final_answer';

export interface AgentMessageState {
  buffer: string;
  commentaryBuffer: string;
  finalAnswerBuffer: string;
  agentMessages: Map<string, { phase: AgentMessagePhase | null; text: string }>;
  agentMessageOrder: string[];
}

export function buildCompletedMessageContent(
  state: AgentMessageState,
): { content: string; processContent?: string; finalAnswerItemId?: string } {
  const messages = state.agentMessageOrder
    .map((itemId) => ({ itemId, message: state.agentMessages.get(itemId) }))
    .filter((entry): entry is {
      itemId: string;
      message: { phase: AgentMessagePhase | null; text: string };
    } => Boolean(entry.message && entry.message.text.trim()));
  // Some providers mark every agent response as final; the last non-empty
  // final item is the turn's authoritative completed answer.
  const finalItemIds = state.agentMessageOrder.filter((itemId) => {
    const message = state.agentMessages.get(itemId);
    return message?.phase === 'final_answer' && message.text.trim();
  });
  const finalItemId = finalItemIds.at(-1);

  if (!finalItemId) {
    const hasCommentary = messages.some((entry) => entry.message.phase === 'commentary');
    return {
      content: hasCommentary ? '' : state.buffer,
      processContent: state.commentaryBuffer || undefined,
    };
  }

  return {
    content: state.agentMessages.get(finalItemId)?.text || '',
    processContent: messages
      .filter((entry) => entry.itemId !== finalItemId)
      .map((entry) => entry.message.text)
      .join('\n\n') || undefined,
    finalAnswerItemId: finalItemId,
  };
}

export function buildCompletedMessageContentFromItems(
  items: Array<{ id: string; type?: string; phase?: unknown; text?: unknown }>,
): { content: string; processContent?: string; finalAnswerItemId?: string } {
  const state: AgentMessageState = {
    buffer: '',
    commentaryBuffer: '',
    finalAnswerBuffer: '',
    agentMessages: new Map(),
    agentMessageOrder: [],
  };
  for (const item of items) {
    if (item.type && item.type !== 'agentMessage') continue;
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    setAgentMessageText(state, item.id, item.text, getAgentMessagePhase(item.phase));
  }
  rebuildAgentMessageBuffers(state);
  return buildCompletedMessageContent(state);
}

export function getAgentMessagePhase(value: unknown): AgentMessagePhase | null {
  return value === 'commentary' || value === 'final_answer' ? value : null;
}

export function appendAgentMessageItemText(
  existing: string,
  delta: string,
  itemId: string | null,
  previousItemId: string | null,
): { text: string; appended: string; itemId: string | null } {
  const separator = existing && itemId && previousItemId && itemId !== previousItemId ? '\n\n' : '';
  const appended = separator + delta;
  return { text: existing + appended, appended, itemId: itemId || previousItemId };
}

export interface AgentMessageGapDiagnostic {
  itemId: string;
  phase: AgentMessagePhase | null;
  gapMs: number;
  deltaLength: number;
  cumulativeLength: number;
}

export function buildAgentMessageGapDiagnostic(
  itemId: string,
  phase: AgentMessagePhase | null,
  previousAt: number | null,
  currentAt: number,
  deltaLength: number,
  cumulativeLength: number,
): AgentMessageGapDiagnostic | null {
  if (previousAt === null || currentAt - previousAt < AGENT_MESSAGE_LONG_GAP_MS) return null;
  return {
    itemId,
    phase,
    gapMs: currentAt - previousAt,
    deltaLength,
    cumulativeLength,
  };
}

export function ensureAgentMessage(
  state: AgentMessageState,
  itemId: string,
  phase: AgentMessagePhase | null,
): { phase: AgentMessagePhase | null; text: string } {
  const existing = state.agentMessages.get(itemId);
  if (existing) {
    if (phase && existing.phase !== phase) existing.phase = phase;
    return existing;
  }
  const created = { phase, text: '' };
  state.agentMessages.set(itemId, created);
  state.agentMessageOrder.push(itemId);
  return created;
}

export function setAgentMessageText(
  state: AgentMessageState,
  itemId: string,
  text: string,
  phase: AgentMessagePhase | null,
): void {
  const message = ensureAgentMessage(state, itemId, phase);
  message.text = text;
}

export function appendAgentMessageDelta(
  state: AgentMessageState,
  itemId: string,
  delta: string,
  phase: AgentMessagePhase | null,
): void {
  const message = ensureAgentMessage(state, itemId, phase);
  message.text += delta;
}

function joinAgentMessages(
  state: AgentMessageState,
  phase?: AgentMessagePhase,
): string {
  return state.agentMessageOrder
    .map((itemId) => state.agentMessages.get(itemId))
    .filter((message): message is { phase: AgentMessagePhase | null; text: string } => Boolean(
      message && message.text && (!phase || message.phase === phase),
    ))
    .map((message) => message.text)
    .join('\n\n');
}

export function rebuildAgentMessageBuffers(state: AgentMessageState): void {
  state.buffer = joinAgentMessages(state);
  state.commentaryBuffer = joinAgentMessages(state, 'commentary');
  state.finalAnswerBuffer = joinAgentMessages(state, 'final_answer');
}
