import { coordinateDeviceAttention } from './device-attention-coordinator.ts';

export function getQueueStartAttentionDecision(input: {
  pageVisible: boolean;
  windowFocused: boolean;
  activeSessionId: string | null;
  eventSessionId: string;
  systemEnabled: boolean;
  systemSupported: boolean;
  systemPermission: NotificationPermission | 'unsupported';
  soundEnabled: boolean;
}) {
  const alreadyAttending = input.pageVisible && input.windowFocused && input.activeSessionId === input.eventSessionId;
  return {
    suppressLocally: alreadyAttending,
    sendSystemNotification: !alreadyAttending && input.systemEnabled && input.systemSupported && input.systemPermission === 'granted',
    playSound: !alreadyAttending && input.soundEnabled,
  };
}

export async function coordinateQueueStartAttention(queueId: string, suppress: boolean) {
  return coordinateDeviceAttention(`queue-start:${queueId}`, suppress);
}
