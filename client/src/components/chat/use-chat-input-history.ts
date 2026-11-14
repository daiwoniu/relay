import { useCallback, useEffect, useRef, type KeyboardEvent, type MutableRefObject } from 'react';
import type { MessageDto } from '../../generated/relay-contracts';
import { writeChatDraft } from './chat-drafts';
import { getChatInputHistoryNavigation, getRecentChatInputHistory, shouldSendMessageOnKeyDown } from './chat-input-keyboard';

interface Options {
  isMobile: boolean;
  messages: MessageDto[];
  draftKey: string;
  setInputState: (value: string) => void;
  pendingCaretPositionRef: MutableRefObject<number | null>;
  onSend: () => void;
}

export function useChatInputHistory({
  isMobile,
  messages,
  draftKey,
  setInputState,
  pendingCaretPositionRef,
  onSend,
}: Options) {
  const stateRef = useRef<{ index: number | null; draft: string }>({ index: null, draft: '' });
  const reset = useCallback(() => {
    stateRef.current = { index: null, draft: '' };
  }, []);

  useEffect(reset, [draftKey, reset]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSendMessageOnKeyDown({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    }, { isMobile })) {
      event.preventDefault();
      console.log('[ChatInput] Enter pressed');
      onSend();
      return;
    }
    const history = getRecentChatInputHistory(messages);
    const navigation = getChatInputHistoryNavigation({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
    }, {
      isMobile,
      value: event.currentTarget.value,
      selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd,
      history,
      historyIndex: stateRef.current.index,
      draft: stateRef.current.draft,
    });
    if (!navigation) return false;
    event.preventDefault();
    const target = event.currentTarget;
    stateRef.current = { index: navigation.historyIndex, draft: navigation.draft };
    pendingCaretPositionRef.current = navigation.caret;
    setInputState(navigation.value);
    if (typeof sessionStorage !== 'undefined') writeChatDraft(sessionStorage, draftKey, navigation.value);
    window.requestAnimationFrame(() => {
      if (target.isConnected) target.setSelectionRange(navigation.caret, navigation.caret);
    });
    return true;
  }, [draftKey, isMobile, messages, onSend, pendingCaretPositionRef, setInputState]);

  return { handleKeyDown, resetInputHistory: reset };
}
