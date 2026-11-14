import { useEffect, useRef, useState } from 'react';
import type { InteractionResponseResultEvent, PendingApprovalDto, RespondInteractionCommand } from '../../generated/relay-contracts';
import { usePendingApprovalStore } from '../../stores/pending-approvals';
import AuthorizationReminderCard from './AuthorizationReminderCard';
import BatchApprovalDialog from './BatchApprovalDialog';
import { createBatchApprovalSnapshot, executeBatchApprovals, hasBatchApprovalExceptions, type BatchAction } from './batch-approvals';
import { useApprovalAttention } from '../../hooks/useApprovalAttention';
import { useAuth } from '../../auth/AuthContext';
import { useNotificationPreferences } from '../../hooks/useNotificationPreferences';

interface Props {
  setActiveSession: (sessionId: string) => void;
  respondToInteraction: (
    sessionId: string,
    interactionId: string,
    action: RespondInteractionCommand['action'],
    options?: Pick<RespondInteractionCommand, 'formData'>,
  ) => Promise<InteractionResponseResultEvent>;
}

function escapeSelector(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

export default function AuthorizationReminderLayer({ setActiveSession, respondToInteraction }: Props) {
  const { user } = useAuth();
  const notificationPreferences = useNotificationPreferences(user?.id || null);
  const state = usePendingApprovalStore();
  const [navigationHint, setNavigationHint] = useState('');
  const animatedSequence = useRef(state.liveSequence);
  const hasApprovals = state.orderedIds.length > 0;
  const acceptSnapshot = createBatchApprovalSnapshot(state.approvalsById, state.orderedIds);
  const animate = state.liveSequence > animatedSequence.current;

  useApprovalAttention({
    liveSequence: state.liveSequence,
    lastLiveApproval: state.lastLiveApproval,
    pendingCount: state.orderedIds.length,
    onOpenCard: state.showCard,
    systemEnabled: notificationPreferences.deviceCategory === 'mobile' ? notificationPreferences.preferences.mobileSystemEnabled : notificationPreferences.preferences.desktopSystemEnabled,
    soundEnabled: notificationPreferences.deviceCategory === 'mobile' ? notificationPreferences.preferences.mobileSoundEnabled : notificationPreferences.preferences.desktopSoundEnabled,
    sound: notificationPreferences.preferences.approvalSound,
    soundVolume: notificationPreferences.deviceCategory === 'mobile' ? notificationPreferences.preferences.mobileSoundVolume : notificationPreferences.preferences.desktopSoundVolume,
  });

  useEffect(() => {
    if (!animate) return;
    animatedSequence.current = state.liveSequence;
  }, [animate, state.liveSequence]);

  if (!hasApprovals && !state.batch) return null;

  const navigate = (target: PendingApprovalDto) => {
    setNavigationHint('');
    setActiveSession(target.sessionId);
    let attempts = 0;
    const findTarget = () => {
      const element = document.querySelector<HTMLElement>(`[data-interaction-id="${escapeSelector(target.id)}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      if (attempts < 20) window.setTimeout(findTarget, 100);
      else setNavigationHint('已切换到原会话，请在消息中查看该请求。');
    };
    window.setTimeout(findTarget, 0);
  };

  const startBatch = (action: BatchAction) => {
    const snapshot = createBatchApprovalSnapshot(state.approvalsById, state.orderedIds);
    if (snapshot) state.setBatch({ ...snapshot, status: 'confirming' });
  };

  const confirmBatch = async () => {
    const snapshot = usePendingApprovalStore.getState().batch;
    if (!snapshot || snapshot.status !== 'confirming') return;
    state.setBatch({ ...snapshot, status: 'submitting', processed: 0, success: 0, skipped: 0, failed: 0 });
    const summary = await executeBatchApprovals(snapshot, (item, action, options) => (
      respondToInteraction(item.sessionId, item.id, action, options)
    ), (processed, outcomes) => {
      const current = usePendingApprovalStore.getState().batch;
      if (current) state.setBatch({ ...current, status: 'submitting', processed, ...outcomes });
    });
    const current = usePendingApprovalStore.getState().batch;
    if (!current) return;
    if (!hasBatchApprovalExceptions(summary)) {
      state.setBatch(null);
      return;
    }
    state.setBatch({ ...current, status: 'complete', processed: snapshot.requestCount, ...summary });
  };

  return (
    <div className="authorization-reminder-layer">
      {hasApprovals && state.cardHidden && (
        <button type="button" className="authorization-reminder-trigger" onClick={state.showCard} aria-label={`展开 ${state.orderedIds.length} 项待处理请求`}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 2.5a4 4 0 00-4 4v1.4c0 1-.35 1.95-1 2.7L2.8 12h12.4L14 10.6a4.4 4.4 0 01-1-2.7V6.5a4 4 0 00-4-4zM7 14.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span>待处理</span>
          <span className="authorization-reminder-trigger__count">{state.orderedIds.length}</span>
        </button>
      )}
      {hasApprovals && !state.cardHidden && <AuthorizationReminderCard
        approvalsById={state.approvalsById}
        orderedIds={state.orderedIds}
        currentId={state.currentId}
        connected={state.connectionAvailable}
        submittingIds={state.submittingIds}
        detailsExpanded={state.detailsExpanded}
        animate={animate}
        onSelect={state.select}
        onDetailsExpandedChange={state.setDetailsExpanded}
        onRespond={respondToInteraction}
        onSubmittingChange={state.setSubmitting}
        onNavigate={navigate}
        onClose={state.hideCurrentGeneration}
        batchAcceptCount={acceptSnapshot?.requestCount || 0}
        onBatchStart={startBatch}
      />}
      {navigationHint && <div role="status" className="authorization-reminder-hint">{navigationHint}</div>}
      <BatchApprovalDialog batch={state.batch} onClose={() => state.setBatch(null)} onConfirm={() => void confirmBatch()} />
    </div>
  );
}
