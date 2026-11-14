import { create } from 'zustand';
import type {
  SessionMessageMatchDto,
  SessionMessageMatchesResponseDto,
  SessionSearchResponseDto,
  SessionSearchResultDto,
} from '../generated/relay-contracts';
import { getDefaultSearchMatchIndex, moveSearchMatchIndex } from '../components/chat/session-search-navigation.ts';

export type SessionSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SessionSearchState {
  query: string;
  status: SessionSearchStatus;
  results: SessionSearchResultDto[];
  error: string | null;
  requestId: number;
  matchQuery: string;
  matchStatus: SessionSearchStatus;
  matchError: string | null;
  matchRequestId: number;
  activeMatchSessionId: string | null;
  matches: SessionMessageMatchDto[];
  totalMatches: number;
  matchesTruncated: boolean;
  currentMatchIndex: number;
  targetMessageId: string | null;
  beginSearch: (query: string) => number;
  applySearchResults: (requestId: number, response: SessionSearchResponseDto) => void;
  failSearch: (requestId: number, message: string) => void;
  beginMatchSearch: (query: string) => number;
  applySessionMatches: (requestId: number, sessionId: string, response: SessionMessageMatchesResponseDto) => void;
  failMatchSearch: (requestId: number, message: string) => void;
  setSessionMatches: (sessionId: string, response: SessionMessageMatchesResponseDto) => void;
  selectMatch: (index: number) => void;
  moveMatch: (direction: 'previous' | 'next') => void;
  clearSessionMatches: () => void;
  clearCurrentSearch: () => void;
  clearSearch: () => void;
}

const initialSearchState = {
  query: '',
  status: 'idle' as const,
  results: [] as SessionSearchResultDto[],
  error: null as string | null,
  matchQuery: '',
  matchStatus: 'idle' as const,
  matchError: null as string | null,
  activeMatchSessionId: null as string | null,
  matches: [] as SessionMessageMatchDto[],
  totalMatches: 0,
  matchesTruncated: false,
  currentMatchIndex: -1,
  targetMessageId: null as string | null,
};

export const useSessionSearchStore = create<SessionSearchState>((set, get) => ({
  ...initialSearchState,
  requestId: 0,
  matchRequestId: 0,
  beginSearch: (query) => {
    const requestId = get().requestId + 1;
    const normalizedQuery = query.trim();
    set({
      query,
      requestId,
      status: normalizedQuery ? 'loading' : 'idle',
      results: [],
      error: null,
      activeMatchSessionId: null,
      matches: [],
      totalMatches: 0,
      matchesTruncated: false,
      currentMatchIndex: -1,
      targetMessageId: null,
    });
    return requestId;
  },
  applySearchResults: (requestId, response) => {
    const current = get();
    if (requestId !== current.requestId || response.query !== current.query.trim()) return;
    set({ status: 'ready', results: response.results, error: null });
  },
  failSearch: (requestId, message) => {
    if (requestId !== get().requestId) return;
    set({ status: 'error', results: [], error: message });
  },
  beginMatchSearch: (query) => {
    const matchRequestId = get().matchRequestId + 1;
    const normalizedQuery = query.trim();
    set({
      matchQuery: query,
      matchRequestId,
      matchStatus: normalizedQuery ? 'loading' : 'idle',
      matchError: null,
      activeMatchSessionId: null,
      matches: [],
      totalMatches: 0,
      matchesTruncated: false,
      currentMatchIndex: -1,
      targetMessageId: null,
    });
    return matchRequestId;
  },
  applySessionMatches: (requestId, sessionId, response) => {
    const current = get();
    if (requestId !== current.matchRequestId || response.query !== current.matchQuery.trim()) return;
    const currentMatchIndex = getDefaultSearchMatchIndex(response.matches.length);
    set({
      matchStatus: 'ready',
      matchError: null,
      activeMatchSessionId: sessionId,
      matches: response.matches,
      totalMatches: response.total,
      matchesTruncated: response.truncated,
      currentMatchIndex,
      targetMessageId: currentMatchIndex >= 0 ? response.matches[currentMatchIndex].messageId : null,
    });
  },
  failMatchSearch: (requestId, message) => {
    if (requestId !== get().matchRequestId) return;
    set({ matchStatus: 'error', matchError: message, matches: [], totalMatches: 0, currentMatchIndex: -1, targetMessageId: null });
  },
  setSessionMatches: (sessionId, response) => {
    const currentMatchIndex = getDefaultSearchMatchIndex(response.matches.length);
    set({
      matchQuery: response.query,
      matchStatus: 'ready',
      matchError: null,
      activeMatchSessionId: sessionId,
      matches: response.matches,
      totalMatches: response.total,
      matchesTruncated: response.truncated,
      currentMatchIndex,
      targetMessageId: currentMatchIndex >= 0 ? response.matches[currentMatchIndex].messageId : null,
    });
  },
  selectMatch: (index) => {
    const current = get();
    if (current.matches.length === 0) return;
    const currentMatchIndex = Math.max(0, Math.min(current.matches.length - 1, index));
    set({
      currentMatchIndex,
      targetMessageId: current.matches[currentMatchIndex].messageId,
    });
  },
  moveMatch: (direction) => {
    const current = get();
    const currentMatchIndex = moveSearchMatchIndex(current.currentMatchIndex, current.matches.length, direction);
    set({
      currentMatchIndex,
      targetMessageId: currentMatchIndex >= 0 ? current.matches[currentMatchIndex].messageId : null,
    });
  },
  clearSessionMatches: () => set({
    matchQuery: '',
    matchStatus: 'idle',
    matchError: null,
    matchRequestId: get().matchRequestId + 1,
    activeMatchSessionId: null,
    matches: [],
    totalMatches: 0,
    matchesTruncated: false,
    currentMatchIndex: -1,
    targetMessageId: null,
  }),
  clearCurrentSearch: () => set((state) => ({
    matchQuery: '',
    matchStatus: 'idle',
    matchError: null,
    matchRequestId: state.matchRequestId + 1,
    activeMatchSessionId: null,
    matches: [],
    totalMatches: 0,
    matchesTruncated: false,
    currentMatchIndex: -1,
    targetMessageId: null,
  })),
  clearSearch: () => set((state) => ({
    ...initialSearchState,
    requestId: state.requestId + 1,
    matchRequestId: state.matchRequestId + 1,
  })),
}));
