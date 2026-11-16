import type { ShareSnapshotV1 } from '../../generated/relay-contracts';
import type { ProcessFlowContext, FlowInput } from '../messages/process-flow-model';
import { hasVisibleProcessPresentation } from '../../stores/process-step-visibility.ts';

export function buildShareFlows(snapshot: ShareSnapshotV1): Map<string, ProcessFlowContext> {
  const flows = new Map<string, ProcessFlowContext>();
  for (const message of snapshot.messages) {
    if (message.role !== 'assistant' || !hasVisibleProcessPresentation(message.processContent, message.processItems, message.processTimeline)) continue;
    const users = message.turnId ? snapshot.messages.filter(user => user.role === 'user' && user.turnId === message.turnId && user.createdAt <= message.createdAt) : [];
    const input = (user: typeof message): FlowInput => ({ id: user.id, content: user.content, recordedAt: user.createdAt, delivery: '已记录', state: 'completed', positionKnown: false, attachments: user.attachments });
    const sourceTimeline = [...(message.processTimeline || [])];
    if (message.processContent?.trim() && !sourceTimeline.some(entry => entry.type === 'narrative' && entry.content.trim())) {
      sourceTimeline.unshift({ type: 'narrative', itemId: `share-process:${message.id}`, content: message.processContent });
    }
    const referenced = new Set(sourceTimeline.map(entry => entry.itemId));
    const timeline = [...sourceTimeline, ...(message.processItems || []).filter(item => !referenced.has(item.id)).map(item => ({ type: 'operation' as const, itemId: item.id }))];
    flows.set(message.id, {
      id: message.id, sessionId: '', turnId: message.turnId || '', readOnly: true,
      root: users[0] ? input(users[0]) : { id: `missing:${message.id}`, content: '', delivery: '分享未包含关联输入', state: 'unknown', positionKnown: false },
      inputs: users.slice(1).map(input), steps: message.processItems || [], timeline,
      ui: { expanded: {}, details: {}, view: 'list' },
    });
  }
  return flows;
}
