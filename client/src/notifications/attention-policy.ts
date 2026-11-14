export interface AttentionPolicyInput {
  source: 'live' | 'snapshot' | 'duplicate' | 'focus';
  pageVisible: boolean;
  windowFocused: boolean;
  systemEnabled: boolean;
  systemSupported: boolean;
  systemPermission: NotificationPermission | 'unsupported';
  soundEnabled: boolean;
}

export function getApprovalAttentionDecision(input: AttentionPolicyInput) {
  const isNew = input.source === 'live';
  const background = !input.pageVisible || !input.windowFocused;
  return {
    showCard: isNew,
    sendSystemNotification: isNew && background && input.systemEnabled && input.systemSupported && input.systemPermission === 'granted',
    playSound: isNew && background && input.soundEnabled,
    updateTitle: true,
  };
}

export function getApprovalPageTitle(count: number, originalTitle: string): string {
  return count > 0 ? `[待处理 ${count}] Relay` : originalTitle;
}
