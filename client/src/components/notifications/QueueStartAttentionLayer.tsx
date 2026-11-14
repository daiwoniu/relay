import { useCallback, useEffect } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useNotificationPreferences } from '../../hooks/useNotificationPreferences';
import { useChatStore } from '../../stores/chat';
import { useQueueStartAttentionStore } from '../../stores/queue-start-attention';
import { coordinateQueueStartAttention, getQueueStartAttentionDecision } from '../../notifications/queue-start-policy';
import { getNotificationPermission, showQueueStartBrowserNotification } from '../../notifications/browser-notifications';
import { playNotificationSound } from '../../notifications/notification-sound';

export default function QueueStartAttentionLayer({ setActiveSession }: { setActiveSession(sessionId: string): void }) {
  const { user } = useAuth();
  const notification = useNotificationPreferences(user?.id || null);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const pending = useQueueStartAttentionStore((state) => state.events[0] || null);
  const acknowledge = useQueueStartAttentionStore((state) => state.acknowledge);
  const openSession = useCallback((sessionId: string) => setActiveSession(sessionId), [setActiveSession]);
  useEffect(() => { if (pending && pending.userId !== user?.id) acknowledge(pending.sequence); }, [acknowledge, pending, user?.id]);
  useEffect(() => {
    if (!notification.loaded || !pending || pending.userId !== user?.id) return;
    let active = true;
    void (async () => {
      const pageVisible = document.visibilityState === 'visible';
      const windowFocused = document.hasFocus();
      const currentDevice = notification.deviceCategory;
      const preferences = notification.preferences;
      const permission = getNotificationPermission();
      const decision = getQueueStartAttentionDecision({ pageVisible, windowFocused, activeSessionId, eventSessionId: pending.sessionId, systemEnabled: currentDevice === 'mobile' ? preferences.mobileSessionEndSystemEnabled : preferences.desktopSessionEndSystemEnabled, systemSupported: permission !== 'unsupported', systemPermission: permission, soundEnabled: currentDevice === 'mobile' ? preferences.mobileSessionEndSoundEnabled : preferences.desktopSessionEndSoundEnabled });
      const ownsAttention = await coordinateQueueStartAttention(pending.queueId, decision.suppressLocally);
      if (!active) return;
      if (ownsAttention) {
        if (decision.sendSystemNotification) showQueueStartBrowserNotification(pending, () => openSession(pending.sessionId));
        if (decision.playSound) void playNotificationSound(preferences.sessionEndSound, currentDevice === 'mobile' ? preferences.mobileSoundVolume : preferences.desktopSoundVolume);
      }
      acknowledge(pending.sequence);
    })();
    return () => { active = false; };
  }, [acknowledge, activeSessionId, notification.deviceCategory, notification.loaded, notification.preferences, openSession, pending, user?.id]);
  return null;
}
