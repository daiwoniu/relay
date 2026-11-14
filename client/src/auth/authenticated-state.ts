import { activateMessageCacheUser, clearMessageCache, clearMessageCacheOwner } from '../cache/message-cache';
import { approvalTrustStore } from '../stores/approval-trust';
import { useChatStore } from '../stores/chat';
import { useEngineConcurrencyStore } from '../stores/engine-concurrency';
import { useEngineModelsStore } from '../stores/engine-models';
import { usePendingApprovalStore } from '../stores/pending-approvals';
import { useQueueStartAttentionStore } from '../stores/queue-start-attention';
import { useSessionEndAttentionStore } from '../stores/session-end-attention';
import { useSessionSearchStore } from '../stores/session-search';
import { clearAuthenticatedLocalStorage } from './authenticated-storage';

let resetSequence = Promise.resolve();

export async function activateAuthenticatedClientState(userId: string): Promise<void> {
  await activateMessageCacheUser(userId).catch(() => undefined);
  useChatStore.getState().restoreStoredChatCandidate();
}

async function performAuthenticatedClientStateReset(): Promise<void> {
  useChatStore.getState().resetAuthenticatedChatState();
  useSessionSearchStore.getState().clearSearch();
  usePendingApprovalStore.getState().configureUser(null);
  useEngineConcurrencyStore.setState({ concurrencyByResourceKey: {}, queueBySessionId: {}, savingResourceKeys: [] });
  useEngineModelsStore.setState({ byEngine: {}, draftBySession: {} });
  approvalTrustStore.getState().dispose();
  approvalTrustStore.setState({ entries: {}, activeProjectId: null, activeSessionId: null, sessionProjects: {} });
  useQueueStartAttentionStore.setState({ nextSequence: 1, events: [] });
  useSessionEndAttentionStore.setState({ nextSequence: 1, events: [] });
  clearAuthenticatedLocalStorage();
  clearAuthenticatedLocalStorage(typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
  await clearMessageCache();
  clearMessageCacheOwner();
}

export function resetAuthenticatedClientState(): Promise<void> {
  resetSequence = resetSequence.catch(() => undefined).then(performAuthenticatedClientStateReset);
  return resetSequence;
}
