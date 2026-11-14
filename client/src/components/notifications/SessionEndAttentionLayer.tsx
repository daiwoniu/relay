import { useCallback, useEffect } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useNotificationPreferences } from '../../hooks/useNotificationPreferences';
import { useSessionEndAttention } from '../../hooks/useSessionEndAttention';
import { useChatStore } from '../../stores/chat';
import { useSessionEndAttentionStore } from '../../stores/session-end-attention';

interface Props {
  setActiveSession: (sessionId: string) => void;
}

export default function SessionEndAttentionLayer({ setActiveSession }: Props) {
  const { user } = useAuth();
  const notificationPreferences = useNotificationPreferences(user?.id || null);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const pendingEvent = useSessionEndAttentionStore((state) => state.events[0] || null);
  const acknowledge = useSessionEndAttentionStore((state) => state.acknowledge);
  const openSession = useCallback((sessionId: string) => setActiveSession(sessionId), [setActiveSession]);
  const currentDevice = notificationPreferences.deviceCategory;
  const preferences = notificationPreferences.preferences;
  const event = pendingEvent?.userId === user?.id ? pendingEvent : null;

  useEffect(() => {
    if (pendingEvent && pendingEvent.userId !== user?.id) acknowledge(pendingEvent.sequence);
  }, [acknowledge, pendingEvent, user?.id]);

  useSessionEndAttention({
    ready: notificationPreferences.loaded,
    event,
    activeSessionId,
    systemEnabled: currentDevice === 'mobile' ? preferences.mobileSessionEndSystemEnabled : preferences.desktopSessionEndSystemEnabled,
    soundEnabled: currentDevice === 'mobile' ? preferences.mobileSessionEndSoundEnabled : preferences.desktopSessionEndSoundEnabled,
    sound: preferences.sessionEndSound,
    soundVolume: currentDevice === 'mobile' ? preferences.mobileSoundVolume : preferences.desktopSoundVolume,
    onOpenSession: openSession,
    onHandled: acknowledge,
  });

  return null;
}
