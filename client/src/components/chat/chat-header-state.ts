import type { Session } from '../../stores/chat';
import type { RegionLoadState } from '../../stores/region-load-state';

export type ChatHeaderTitlePresentation = 'empty' | 'loading' | 'error' | 'ready';

export function getChatHeaderTitlePresentation(
  activeSessionId: string | null,
  session: Session | undefined,
  loadState: RegionLoadState | undefined,
): ChatHeaderTitlePresentation {
  if (!activeSessionId) return 'empty';
  if (session) return 'ready';
  if (loadState?.status === 'error') return 'error';
  return 'loading';
}
