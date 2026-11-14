import { useEffect } from 'react';
import { getSessionEndAttentionDecision, type SessionEndAttentionEvent } from '../notifications/session-end-policy';
import { getNotificationPermission, showSessionEndBrowserNotification } from '../notifications/browser-notifications';
import { playNotificationSound, type NotificationSound } from '../notifications/notification-sound';
import { coordinateDeviceAttention } from '../notifications/device-attention-coordinator';

interface Options {
  ready: boolean;
  event: SessionEndAttentionEvent | null;
  activeSessionId: string | null;
  systemEnabled: boolean;
  soundEnabled: boolean;
  sound: NotificationSound;
  soundVolume: number;
  onOpenSession: (sessionId: string) => void;
  onHandled: (sequence: number) => void;
}

export function useSessionEndAttention({ ready, event, activeSessionId, systemEnabled, soundEnabled, sound, soundVolume, onOpenSession, onHandled }: Options) {
  useEffect(() => {
    if (!ready || !event) return;
    let active = true;
    void (async () => {
      const pageVisible = document.visibilityState === 'visible';
      const windowFocused = document.hasFocus();
      const suppressLocally = pageVisible && windowFocused && activeSessionId === event.sessionId;
      const ownsAttention = await coordinateDeviceAttention(
        `session-end:${event.userId}:${event.sessionId}:${event.resultMessageId ?? `${event.status}:${event.occurredAt}`}`,
        suppressLocally,
      );
      if (!active) return;
      if (ownsAttention) {
        const permission = getNotificationPermission();
        const decision = getSessionEndAttentionDecision({
          pageVisible,
          windowFocused,
          activeSessionId,
          eventSessionId: event.sessionId,
          systemEnabled,
          systemSupported: permission !== 'unsupported',
          systemPermission: permission,
          soundEnabled,
        });
        if (decision.sendSystemNotification) showSessionEndBrowserNotification(event, () => onOpenSession(event.sessionId));
        if (decision.playSound) void playNotificationSound(sound, soundVolume);
      }
      onHandled(event.sequence);
    })();
    return () => { active = false; };
  }, [activeSessionId, event, onHandled, onOpenSession, ready, sound, soundEnabled, soundVolume, systemEnabled]);
}
