import type { SuggestedReplyCandidate } from './suggested-reply';

export type SuggestedReplyDraftStatus = 'active' | 'selected' | 'dismissed';

export interface SuggestedReplyDraftState {
  sourceMessageId: string;
  status: SuggestedReplyDraftStatus;
}

interface StoredSuggestedReplyDraftState extends SuggestedReplyDraftState {
  version: 1;
}

interface SuggestedReplyPrefillInput {
  draft: string;
  candidate: SuggestedReplyCandidate | null;
  state: SuggestedReplyDraftState | null;
}

interface SuggestedReplyPrefillResult {
  value: string;
  state: SuggestedReplyDraftState | null;
  active: boolean;
  shouldPersistDraft: boolean;
  selectionPending: boolean;
}

export function getSuggestedReplyDraftKey(chatDraftKey: string): string {
  return `${chatDraftKey}:suggested-reply`;
}

export function readSuggestedReplyDraftState(
  storage: Pick<Storage, 'getItem'>,
  key: string,
): SuggestedReplyDraftState | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSuggestedReplyDraftState>;
    if (
      parsed.version !== 1
      || typeof parsed.sourceMessageId !== 'string'
      || !parsed.sourceMessageId
      || !['active', 'selected', 'dismissed'].includes(String(parsed.status))
    ) return null;
    return {
      sourceMessageId: parsed.sourceMessageId,
      status: parsed.status as SuggestedReplyDraftStatus,
    };
  } catch {
    return null;
  }
}

export function writeSuggestedReplyDraftState(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string,
  state: SuggestedReplyDraftState | null,
): void {
  if (!state) {
    storage.removeItem(key);
    return;
  }
  const stored: StoredSuggestedReplyDraftState = { version: 1, ...state };
  storage.setItem(key, JSON.stringify(stored));
}

export function dismissSuggestedReplyDraftState(
  state: SuggestedReplyDraftState | null,
): SuggestedReplyDraftState | null {
  return state ? { ...state, status: 'dismissed' } : null;
}

export function consumeSuggestedReplySelection(
  state: SuggestedReplyDraftState | null,
): SuggestedReplyDraftState | null {
  return state?.status === 'active' ? { ...state, status: 'selected' } : state;
}

export function resolveSuggestedReplyPrefill({
  draft,
  candidate,
  state,
}: SuggestedReplyPrefillInput): SuggestedReplyPrefillResult {
  if (!candidate) {
    if (state?.status === 'active' || state?.status === 'selected') {
      return {
        value: '',
        state: null,
        active: false,
        shouldPersistDraft: true,
        selectionPending: false,
      };
    }
    return {
      value: draft,
      state,
      active: false,
      shouldPersistDraft: false,
      selectionPending: false,
    };
  }

  if (state?.sourceMessageId === candidate.sourceMessageId) {
    if (state.status === 'dismissed') {
      return {
        value: draft,
        state,
        active: false,
        shouldPersistDraft: false,
        selectionPending: false,
      };
    }
    if (draft !== candidate.text) {
      return {
        value: draft,
        state: { ...state, status: 'dismissed' },
        active: false,
        shouldPersistDraft: false,
        selectionPending: false,
      };
    }
    return {
      value: draft,
      state,
      active: true,
      shouldPersistDraft: false,
      selectionPending: state.status === 'active',
    };
  }

  if (state?.status === 'active' || state?.status === 'selected') {
    return {
      value: candidate.text,
      state: { sourceMessageId: candidate.sourceMessageId, status: 'active' },
      active: true,
      shouldPersistDraft: true,
      selectionPending: true,
    };
  }

  if (draft) {
    return {
      value: draft,
      state: { sourceMessageId: candidate.sourceMessageId, status: 'dismissed' },
      active: false,
      shouldPersistDraft: false,
      selectionPending: false,
    };
  }

  return {
    value: candidate.text,
    state: { sourceMessageId: candidate.sourceMessageId, status: 'active' },
    active: true,
    shouldPersistDraft: true,
    selectionPending: true,
  };
}
