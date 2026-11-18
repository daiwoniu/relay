import type { ShareSnapshotV1 } from '../../generated/relay-contracts';
import { hasVisibleProcessPresentation, hasVisibleProcessStep } from '../../stores/process-step-visibility.ts';

export function getShareMessageSummary(snapshot: ShareSnapshotV1) {
  return { messageCount: snapshot.messages.length,
    assistantMessageCount: snapshot.messages.filter(message => message.role === 'assistant').length };
}

export function getShareProcessSummary(snapshot: ShareSnapshotV1) {
  let messages = 0;
  let records = 0;
  for (const message of snapshot.messages) {
    const items = message.processItems?.filter(hasVisibleProcessStep) || [];
    const narratives = message.processTimeline?.filter(entry => entry.type === 'narrative' && entry.content.trim()) || [];
    const count = items.length + (narratives.length || (message.processContent?.trim() ? 1 : 0)) + (message.changedFiles?.length || 0);
    if (hasVisibleProcessPresentation(message.processContent, items, message.processTimeline) || message.changedFiles?.length || message.changedFilesIncomplete) messages += 1;
    records += count;
  }
  return { messages, records, label: messages > 0 ? `含处理过程 · ${messages} 条消息 · ${records} 项记录`
    : snapshot.includeProcess === true ? '已选择包含过程，本次消息没有可展示的过程记录'
    : snapshot.includeProcess === false ? '仅消息正文，不包含处理过程' : '本快照没有可展示的处理过程' };
}
