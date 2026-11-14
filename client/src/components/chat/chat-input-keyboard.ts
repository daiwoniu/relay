interface ChatInputKeyboardEvent {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

interface ChatInputHistoryKeyboardEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

interface ChatInputHistoryNavigationContext {
  isMobile: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  history: string[];
  historyIndex: number | null;
  draft: string;
}

export interface ChatInputHistoryNavigation {
  value: string;
  historyIndex: number | null;
  draft: string;
  caret: number;
}

interface ChatInputKeyboardContext {
  isMobile: boolean;
}

export const CHAT_INPUT_HISTORY_LIMIT = 20;

export function getRecentChatInputHistory(
  messages: Array<{ role: string; content: string }>,
): string[] {
  return messages
    .filter((message) => message.role === 'user' && message.content.length > 0)
    .map((message) => message.content)
    .filter((content, index, list) => index === 0 || list[index - 1] !== content)
    .slice(-CHAT_INPUT_HISTORY_LIMIT);
}

export function shouldSendMessageOnKeyDown(
  event: ChatInputKeyboardEvent,
  context: ChatInputKeyboardContext,
): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && !context.isMobile;
}

export function getChatInputHistoryNavigation(
  event: ChatInputHistoryKeyboardEvent,
  context: ChatInputHistoryNavigationContext,
): ChatInputHistoryNavigation | null {
  if (context.isMobile || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return null;
  }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null;
  if (context.selectionStart !== context.selectionEnd || context.history.length === 0) return null;

  if (event.key === 'ArrowUp') {
    if (context.selectionStart !== 0) return null;
    const nextIndex = context.historyIndex === null
      ? context.history.length - 1
      : Math.max(0, context.historyIndex - 1);
    if (nextIndex === context.historyIndex) return null;
    const nextValue = context.history[nextIndex];
    return {
      value: nextValue,
      historyIndex: nextIndex,
      draft: context.historyIndex === null ? context.value : context.draft,
      caret: nextValue.length,
    };
  }

  if (context.historyIndex === null || context.selectionEnd !== context.value.length) return null;
  if (context.historyIndex < context.history.length - 1) {
    const nextIndex = context.historyIndex + 1;
    const nextValue = context.history[nextIndex];
    return {
      value: nextValue,
      historyIndex: nextIndex,
      draft: context.draft,
      caret: nextValue.length,
    };
  }
  return {
    value: context.draft,
    historyIndex: null,
    draft: context.draft,
    caret: context.draft.length,
  };
}
