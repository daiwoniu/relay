import type { ShareScope } from '../../generated/relay-contracts.ts';

export function getShareScopePresentation(scope: ShareScope, selectedMessageCount?: number) {
  if (scope === 'single') return { label: '单条消息', description: '仅公开当前选中的一条消息' };
  if (scope === 'selection') {
    return {
      label: '所选消息',
      description: selectedMessageCount && selectedMessageCount > 0
        ? `仅公开本次选择的 ${selectedMessageCount} 条消息`
        : '仅公开本次选择的多条消息',
    };
  }
  return { label: '整个会话', description: '公开截至最后一条已完成回复的会话内容' };
}
