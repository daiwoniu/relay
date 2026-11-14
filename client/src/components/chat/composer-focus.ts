export type ComposerFocusReason =
  | 'session-opened'
  | 'new-chat'
  | 'search-closed'
  | 'send-finished'
  | 'stop-finished'
  | 'attachment-selected'
  | 'attachment-cancelled'
  | 'project-selected';

export interface ComposerFocusRequest {
  id: number;
  reason: ComposerFocusReason;
  sourceElement: HTMLElement | null;
}

export type ComposerFocusHandler = (request: ComposerFocusRequest) => boolean;

export interface ComposerFocusOutletContext {
  composerFocusRequest: ComposerFocusRequest | null;
  requestComposerFocus: (reason: ComposerFocusReason) => void;
  registerComposerFocusHandler: (handler: ComposerFocusHandler) => () => void;
}

const MOBILE_FOCUS_REASONS = new Set<ComposerFocusReason>([
  'new-chat',
  'send-finished',
  'stop-finished',
  'attachment-selected',
  'project-selected',
]);

export function shouldFocusComposerOnDevice(reason: ComposerFocusReason, mobile: boolean): boolean {
  return !mobile || MOBILE_FOCUS_REASONS.has(reason);
}
