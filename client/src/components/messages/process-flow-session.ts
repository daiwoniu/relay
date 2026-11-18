import type { Message, ProcessStep, ProcessTimelineEntry } from '../../stores/chat';
import type { SessionFollowupDto } from '../../generated/relay-contracts';
import { makeFlowFollowup, makeFlowInput } from './process-flow-input.ts';
import type { ProcessFlowContext } from './process-flow-model';
import { isHistoricalOperationRecord } from '../chat/historical-operation-records.ts';
import { hasVisibleProcessStep } from '../../stores/process-step-visibility.ts';

function isFlowReply(message: Message): boolean {
  return message.role === 'assistant' && !isHistoricalOperationRecord(message)
    && (message.phase !== 'interaction' || Boolean(message.stopped || message.isError || message.errorCode || message.outcome && message.outcome !== 'completed'));
}

/** Presentation-only capture. Never reconstruct an operation position from wall-clock proximity. */
export function captureProcessFlow(previous: ProcessFlowContext | null, input: {
  sessionId: string;
  messages: Message[];
  followups: SessionFollowupDto[];
  steps: ProcessStep[];
  timeline: ProcessTimelineEntry[];
  projectName?: string;
  projectPath?: string;
  knownProjects?: ProcessFlowContext['knownProjects'];
  allowMissingRoot?: boolean;
}): ProcessFlowContext | null {
  const messages = input.messages.filter(message => message.session_id === input.sessionId);
  const terminalTurns = new Set(messages.filter(isFlowReply).flatMap(message => [message.turn_id, message.requestTurnId].filter(Boolean)));
  const followups = new Map(input.followups.filter(item => item.sessionId === input.sessionId).map(item => [item.id, item]));
  const canStartFlow = (message: Message) => {
    if (message.role !== 'user' || !message.turn_id || terminalTurns.has(message.turn_id)) return false;
    const followup = followups.get(message.id);
    // A queued message becomes a root only after it is persisted as a new turn's user message.
    if (followup) return followup.state === 'delivered' || followup.state === 'dispatching';
    return !message.replyToAsyncQuestionId;
  };
  const candidate = [...messages].reverse().find(canStartFlow);
  const root = candidate && messages.find(message => message.turn_id === candidate.turn_id && canStartFlow(message));
  if (!root) {
    if (!input.allowMissingRoot || getFlowCompletionMessage(previous, messages)) return null;
    return {
      id: `pending:${input.sessionId}`, sessionId: input.sessionId, turnId: '',
      root: { id: `missing:${input.sessionId}`, content: '', delivery: '原始用户输入尚未加载', state: 'unknown', positionKnown: false },
      inputs: [], steps: input.steps, timeline: input.timeline,
      projectName: input.projectName, projectPath: input.projectPath, knownProjects: input.knownProjects,
      ui: previous?.sessionId === input.sessionId
        ? previous.id === `pending:${input.sessionId}` ? previous.ui : { expanded: {}, details: {}, view: previous.ui.view }
        : { expanded: {}, details: {} },
    };
  }
  const sameSession = previous?.sessionId === input.sessionId;
  const sameFlow = previous?.id === root.id && sameSession;
  const context: ProcessFlowContext = sameFlow ? previous : {
    id: root.id, sessionId: input.sessionId, turnId: root.turn_id,
    root: makeFlowInput(root, true), inputs: [], ui: sameSession && previous?.id === `pending:${input.sessionId}` ? previous.ui : { expanded: {}, details: {} }, steps: [], timeline: [],
  };
  const existing = new Map(context.inputs.map(item => [item.id, item]));
  const initialCapture = !sameFlow;
  const inputs = messages.filter(message => message.role === 'user' && message.id !== root.id && message.turn_id === root.turn_id).map(message => makeFlowInput(message));
  for (const followup of input.followups) if (followup.sessionId === input.sessionId && followup.createdAt >= root.created_at && followup.id !== root.id) {
    const item = makeFlowFollowup(followup);
    const index = inputs.findIndex(value => value.id === item.id);
    if (index >= 0) inputs[index] = { ...item, attachments: inputs[index].attachments }; else inputs.push(item);
  }
  const visibleSteps = input.steps.filter(step => step.type !== 'reasoning' || hasVisibleProcessStep(step));
  const visibleIds = new Set(visibleSteps.map(step => step.id));
  const lastItemId = [...input.timeline].reverse().find(entry => entry.type === 'narrative' ? Boolean(entry.content?.trim()) : visibleIds.has(entry.itemId))?.itemId || visibleSteps[visibleSteps.length - 1]?.id;
  return {
    ...context, turnId: root.turn_id, root: makeFlowInput(root, true), projectName: input.projectName, projectPath: input.projectPath, knownProjects: input.knownProjects,
    steps: input.steps, timeline: input.timeline,
    inputs: inputs.map(item => {
      const old = existing.get(item.id);
      return { ...item, positionKnown: old?.positionKnown ?? !initialCapture, afterItemId: old ? old.afterItemId : initialCapture ? undefined : lastItemId };
    }),
  };
}

export function getFlowCompletionMessage(context: ProcessFlowContext | null, messages: Message[]): Message | undefined {
  if (!context?.turnId) return undefined;
  return [...messages].reverse().find(message => message.session_id === context.sessionId && (message.turn_id === context.turnId || message.requestTurnId === context.turnId) && isFlowReply(message));
}

export function buildCompletedFlows(messages: Message[], previous: Map<string, ProcessFlowContext>, resource: Pick<ProcessFlowContext, 'projectPath' | 'projectName' | 'knownProjects'>): Map<string, ProcessFlowContext> {
  const inputs = new Map<string, Message[]>();
  const key = (message: Message) => JSON.stringify([message.session_id, message.turn_id]);
  for (const message of messages) if (message.role === 'user' && message.turn_id) {
    const group = inputs.get(key(message)) || []; group.push(message); inputs.set(key(message), group);
  }
  const flows = new Map<string, ProcessFlowContext>();
  for (const message of messages) if (isFlowReply(message) && (!message.modelInfo || message.modelInfo.engineId === 'codex')) {
    const requestTurn = message.requestTurnId || message.turn_id;
    const users = requestTurn ? inputs.get(JSON.stringify([message.session_id, requestTurn])) || [] : [];
    const supplements = message.requestTurnId && message.requestTurnId !== message.turn_id ? inputs.get(key(message)) || [] : [];
    const old = previous.get(message.id);
    flows.set(message.id, {
      ...resource, id: message.id, sessionId: message.session_id, turnId: message.turn_id,
      root: users[0] ? makeFlowInput(users[0], true) : { id: `missing:${message.id}`, content: '', delivery: '历史窗口未包含原始输入', state: 'unknown', positionKnown: false },
      inputs: [...users.slice(1), ...supplements].map(user => makeFlowInput(user)),
      ui: old?.sessionId === message.session_id ? old.ui : { expanded: {}, details: {} },
      steps: message.items || [], timeline: message.processTimeline || [],
    });
  }
  return flows;
}
