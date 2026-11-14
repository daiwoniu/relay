import { useEffect, useRef } from 'react';
import type { PendingApprovalDto } from '../generated/relay-contracts';
import { getApprovalAttentionDecision, getApprovalPageTitle } from '../notifications/attention-policy';
import { getNotificationPermission, showApprovalBrowserNotification } from '../notifications/browser-notifications';
import { playNotificationSound, type NotificationSound } from '../notifications/notification-sound';
import { coordinateDeviceAttention } from '../notifications/device-attention-coordinator';

interface Options {
  liveSequence: number;
  lastLiveApproval: PendingApprovalDto | null;
  pendingCount: number;
  systemEnabled?: boolean;
  soundEnabled?: boolean;
  sound?: NotificationSound;
  soundVolume?: number;
  onOpenCard: () => void;
}

export function useApprovalAttention({ liveSequence, lastLiveApproval, pendingCount, systemEnabled = false, soundEnabled = false, sound = 'gentle_dual', soundVolume = 45, onOpenCard }: Options) {
  const originalTitleRef = useRef(typeof document === 'undefined' ? 'Relay' : document.title);
  const seenSequenceRef = useRef(liveSequence);
  const pendingRef = useRef<PendingApprovalDto[]>([]);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = getApprovalPageTitle(pendingCount, originalTitleRef.current);
  }, [pendingCount]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (typeof document !== 'undefined') document.title = originalTitleRef.current;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!lastLiveApproval || liveSequence <= seenSequenceRef.current) return;
    seenSequenceRef.current = liveSequence;
    pendingRef.current.push(lastLiveApproval);
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      const approvals = pendingRef.current.splice(0);
      if (approvals.length === 0) return;
      const pageVisible = document.visibilityState === 'visible';
      const windowFocused = document.hasFocus();
      const sortedApprovals = [...approvals].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const latestApproval = sortedApprovals[sortedApprovals.length - 1];
      const ownsAttention = await coordinateDeviceAttention(
        `approval:${latestApproval?.sessionId || 'unknown'}:${latestApproval?.id || liveSequence}:${latestApproval?.createdAt || 0}`,
        pageVisible && windowFocused,
      );
      if (!mountedRef.current) return;
      if (ownsAttention) {
        const permission = getNotificationPermission();
        const decision = getApprovalAttentionDecision({
          source: 'live',
          pageVisible,
          windowFocused,
          systemEnabled,
          systemSupported: permission !== 'unsupported',
          systemPermission: permission,
          soundEnabled,
        });
        if (decision.sendSystemNotification) showApprovalBrowserNotification(approvals, onOpenCard);
        if (decision.playSound) void playNotificationSound(sound, soundVolume);
      }
    }, 500);
  }, [lastLiveApproval, liveSequence, onOpenCard, sound, soundEnabled, soundVolume, systemEnabled]);
}
