import type { RegionStatus } from '../../stores/region-load-state.ts';

export type ChatContentState = 'restoring_location' | 'loading_messages' | 'message_error' | 'empty' | 'ready';

export function getChatInitializationState(input: {
  navigationStatus: RegionStatus;
  activeSessionId: string | null;
  messageStatus: RegionStatus;
  hasMessages: boolean;
}): ChatContentState {
  if (!input.activeSessionId) {
    return input.navigationStatus === 'idle' || input.navigationStatus === 'loading'
      ? 'restoring_location'
      : 'empty';
  }
  if (input.hasMessages) return 'ready';
  if (input.messageStatus === 'error') return 'message_error';
  if (input.messageStatus === 'idle' || input.messageStatus === 'loading') return 'loading_messages';
  return 'empty';
}
