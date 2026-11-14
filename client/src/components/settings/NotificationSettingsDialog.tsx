import FailureNotice from '../ui/FailureNotice';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import type { NotificationPreferencesDto } from '../../generated/relay-contracts';
import { useNotificationPreferences, getBrowserNotificationAvailability } from '../../hooks/useNotificationPreferences';
import { getBrowserNotificationPermission, getNotificationPermissionTone } from '../../hooks/notification-preferences-model';
import { NOTIFICATION_SOUND_OPTIONS, playNotificationSound, type NotificationSound } from '../../notifications/notification-sound';
import type { DeviceCategory } from '../../notifications/device-category';
import IconActionButton from '../ui/IconActionButton';
import Modal from '../ui/Modal';
import { ClosePanelIcon } from '../ui/MinimizedPanelBar';

interface Props { open: boolean; onClose: () => void; mobile: boolean; embedded?: boolean }

type EventKind = 'approval' | 'sessionEnd';
type BooleanPreferenceKey = {
  [K in keyof NotificationPreferencesDto]: NotificationPreferencesDto[K] extends boolean ? K : never
}[keyof NotificationPreferencesDto];

const DEVICE_FIELDS = {
  desktop: {
    approvalSystem: 'desktopSystemEnabled',
    approvalSound: 'desktopSoundEnabled',
    sessionEndSystem: 'desktopSessionEndSystemEnabled',
    sessionEndSound: 'desktopSessionEndSoundEnabled',
    volume: 'desktopSoundVolume',
  },
  mobile: {
    approvalSystem: 'mobileSystemEnabled',
    approvalSound: 'mobileSoundEnabled',
    sessionEndSystem: 'mobileSessionEndSystemEnabled',
    sessionEndSound: 'mobileSessionEndSoundEnabled',
    volume: 'mobileSoundVolume',
  },
} as const;

const EVENT_COPY = {
  approval: {
    title: '授权与提问',
    description: '需要授权或回答问题时提醒',
    systemLabel: '系统通知',
    systemDescription: '在设备通知中心显示待处理请求',
    soundDescription: '请求到达时播放提示音',
  },
  sessionEnd: {
    title: '会话任务结束',
    description: '任务完成、失败、停止或中断时提醒',
    systemLabel: '系统通知',
    systemDescription: '在设备通知中心显示任务结果',
    soundDescription: '会话任务进入终态时播放提示音',
  },
} as const;

function readNotificationPermission(): NotificationPermission | 'unsupported' {
  return getBrowserNotificationPermission({
    notificationAvailable: typeof Notification !== 'undefined',
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    permission: typeof Notification !== 'undefined' ? Notification.permission : undefined,
  });
}

function SettingSwitch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: () => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onChange} className={`notification-setting-switch ${checked ? 'notification-setting-switch--on' : ''}`}><span /></button>;
}

export default function NotificationSettingsDialog({ open, onClose, mobile, embedded = false }: Props) {
  const { user } = useAuth();
  const state = useNotificationPreferences(user?.id || null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(readNotificationPermission);
  const [selectedDevice, setSelectedDevice] = useState<DeviceCategory>(state.deviceCategory);
  const [draftVolume, setDraftVolume] = useState(45);
  const [previewKind, setPreviewKind] = useState<EventKind>('approval');
  const [soundHint, setSoundHint] = useState('');
  const [permissionHint, setPermissionHint] = useState('');
  const soundHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fields = DEVICE_FIELDS[selectedDevice];
  const preferences = state.preferences;
  const storedVolume = preferences[fields.volume];
  const approvalSoundEnabled = preferences[fields.approvalSound];
  const sessionEndSoundEnabled = preferences[fields.sessionEndSound];
  const anySoundEnabled = approvalSoundEnabled || sessionEndSoundEnabled;

  useEffect(() => {
    if (soundHintTimerRef.current) {
      clearTimeout(soundHintTimerRef.current);
      soundHintTimerRef.current = null;
    }
    setSoundHint('');
    if (!open) return;
    setPermission(readNotificationPermission());
    setPermissionHint('');
    setSelectedDevice(state.deviceCategory);
    return () => {
      if (soundHintTimerRef.current) clearTimeout(soundHintTimerRef.current);
    };
  }, [open, state.deviceCategory]);

  useEffect(() => setDraftVolume(storedVolume), [selectedDevice, storedVolume]);

  const showSoundHint = (message: string) => {
    setSoundHint(message);
    if (soundHintTimerRef.current) clearTimeout(soundHintTimerRef.current);
    soundHintTimerRef.current = setTimeout(() => {
      setSoundHint('');
      soundHintTimerRef.current = null;
    }, 3000);
  };

  const previewSound = async (kind: EventKind, volume = draftVolume) => {
    setPreviewKind(kind);
    const sound = kind === 'approval' ? preferences.approvalSound : preferences.sessionEndSound;
    const played = await playNotificationSound(sound, volume);
    showSoundHint(played ? `已试听${kind === 'approval' ? '授权请求' : '会话任务结束'}提示音` : '当前浏览器暂时无法播放提示音');
  };

  const ensureCurrentDevicePermission = async () => {
    if (selectedDevice !== state.deviceCategory) return;
    const currentPermission = readNotificationPermission();
    setPermission(currentPermission);
    if (currentPermission === 'unsupported') {
      setPermissionHint('当前浏览器无法申请通知权限，账号偏好仍会保存。');
    } else if (currentPermission === 'default') {
      try {
        setPermission(await Notification.requestPermission());
      } catch {
        setPermission(readNotificationPermission());
        setPermissionHint('当前浏览器无法申请通知权限，账号偏好仍会保存。');
      }
    }
  };

  const toggleBoolean = async (key: BooleanPreferenceKey, requestPermission: boolean) => {
    const next = !preferences[key];
    state.clearError();
    setPermissionHint('');
    if (next && requestPermission) await ensureCurrentDevicePermission();
    try { await state.patch(key, next); } catch { /* 局部错误由 store 展示 */ }
  };

  const updateTone = async (kind: EventKind, sound: NotificationSound) => {
    const key = kind === 'approval' ? 'approvalSound' : 'sessionEndSound';
    setPreviewKind(kind);
    state.clearError();
    try { await state.patch(key, sound); } catch { /* 局部错误由 store 展示 */ }
  };

  const commitVolume = async () => {
    if (draftVolume === storedVolume) {
      await previewSound(previewKind, draftVolume);
      return;
    }
    state.clearError();
    try {
      await state.patch(fields.volume, draftVolume);
      await previewSound(previewKind, draftVolume);
    } catch { /* 局部错误由 store 展示 */ }
  };

  const permissionLabel = () => {
    if (selectedDevice !== state.deviceCategory) return '需要在对应设备上首次开启浏览器通知权限';
    const enabled = preferences[fields.approvalSystem] || preferences[fields.sessionEndSystem];
    const availability = getBrowserNotificationAvailability({ supported: permission !== 'unsupported', permission, accountEnabled: enabled });
    if (availability === 'enabled_unsupported' || availability === 'unsupported') return '当前浏览器不支持系统通知';
    if (availability === 'enabled_denied') return '账号已开启，但当前浏览器已拒绝本站的系统通知权限';
    if (availability === 'denied') return '当前浏览器已拒绝本站的系统通知权限';
    if (availability === 'permission_required') return '开启系统通知时由浏览器询问权限';
    if (availability === 'available') return '当前设备的系统通知可用';
    return '系统通知尚未开启';
  };

  const permissionTone = getNotificationPermissionTone({
    currentDevice: selectedDevice === state.deviceCategory,
    accountEnabled: preferences[fields.approvalSystem] || preferences[fields.sessionEndSystem],
    permission,
  });

  const renderEventCard = (kind: EventKind) => {
    const copy = EVENT_COPY[kind];
    const systemKey = fields[kind === 'approval' ? 'approvalSystem' : 'sessionEndSystem'];
    const soundKey = fields[kind === 'approval' ? 'approvalSound' : 'sessionEndSound'];
    const toneKey = kind === 'approval' ? 'approvalSound' : 'sessionEndSound';
    const tone = preferences[toneKey];
    const soundEnabled = preferences[soundKey];
    return (
      <section className="notification-event-card" aria-labelledby={`notification-${selectedDevice}-${kind}`}>
        <div className="notification-event-card__header">
          <div className="min-w-0">
            <h3 id={`notification-${selectedDevice}-${kind}`} className="text-sm font-semibold text-[var(--color-text)]">{copy.title}</h3>
            <p className="mt-0.5 text-xs leading-5 text-[var(--color-text-tertiary)]">{copy.description}</p>
          </div>
        </div>
        <div className="notification-event-card__row">
          <div className="min-w-0 flex-1"><div className="text-sm text-[var(--color-text)]">{copy.systemLabel}</div><p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{copy.systemDescription}</p></div>
          <SettingSwitch checked={preferences[systemKey]} disabled={!state.loaded || state.savingKeys.includes(systemKey)} label={`${copy.title}系统通知`} onChange={() => void toggleBoolean(systemKey, selectedDevice === state.deviceCategory)} />
        </div>
        <div className="notification-event-card__row">
          <div className="min-w-0 flex-1"><div className="text-sm text-[var(--color-text)]">提示音</div><p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{copy.soundDescription}</p></div>
          <SettingSwitch checked={soundEnabled} disabled={!state.loaded || state.savingKeys.includes(soundKey)} label={`${copy.title}提示音`} onChange={() => void toggleBoolean(soundKey, false)} />
        </div>
        <div className={`notification-tone-row ${soundEnabled ? '' : 'notification-control-disabled'}`}>
          <label className="min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]" htmlFor={`notification-tone-${kind}`}>
            <span className="flex items-center gap-2">提示音类型 <span className="notification-shared-badge">多端共用</span></span>
            <select id={`notification-tone-${kind}`} value={tone} disabled={!soundEnabled || state.savingKeys.includes(toneKey)} onFocus={() => setPreviewKind(kind)} onChange={(event) => void updateTone(kind, event.target.value as NotificationSound)} className="notification-tone-select">
              {NOTIFICATION_SOUND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
      </section>
    );
  };

  const content = <>
      {!embedded && <div className="notification-settings-header">
        <div className="min-w-0"><h2 id="notification-settings-title" className="text-base font-semibold text-[var(--color-text)]">通知设置</h2><p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">偏好跟随账号同步；浏览器权限和声音能力只属于当前设备。</p></div>
        <IconActionButton label="关闭通知设置" variant="neutral" tooltip={false} onClick={onClose}><ClosePanelIcon /></IconActionButton>
      </div>}
      <div className="notification-device-tabs" role="tablist" aria-label="通知设备">
        {(['desktop', 'mobile'] as const).map((device) => <button key={device} id={`notification-device-tab-${device}`} type="button" role="tab" aria-controls="notification-device-panel" aria-selected={selectedDevice === device} onClick={() => setSelectedDevice(device)} className={`notification-device-tab ${selectedDevice === device ? 'notification-device-tab--active' : ''}`}><span>{device === 'desktop' ? '桌面端' : '移动端'}</span>{state.deviceCategory === device && <span className="notification-current-badge">当前设备</span>}</button>)}
      </div>
      <div id="notification-device-panel" className="notification-settings-body" role="tabpanel" aria-labelledby={`notification-device-tab-${selectedDevice}`}>
        <div className="notification-permission-status"><span className={`notification-permission-status__dot notification-permission-status__dot--${permissionTone}`} aria-hidden="true" /><span>{permissionLabel()}</span></div>
        {renderEventCard('approval')}
        {renderEventCard('sessionEnd')}
        <section className={`notification-volume-card ${anySoundEnabled ? '' : 'notification-control-disabled'}`} aria-labelledby="notification-volume-title">
          <div className="flex items-center justify-between gap-3"><div><h3 id="notification-volume-title" className="text-sm font-semibold text-[var(--color-text)]">{selectedDevice === 'desktop' ? '桌面端' : '移动端'}音量</h3><p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">两类提示音共用当前设备音量</p></div><span className="tabular-nums text-sm font-medium text-[var(--color-text)]">{draftVolume}%</span></div>
          <input aria-label={`${selectedDevice === 'desktop' ? '桌面端' : '移动端'}提示音音量`} type="range" min="10" max="100" step="5" value={draftVolume} disabled={!anySoundEnabled || state.savingKeys.includes(fields.volume)} onChange={(event) => setDraftVolume(Number(event.target.value))} onPointerUp={() => void commitVolume()} onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void commitVolume(); }} className="notification-volume-range" />
          <div className="mt-1 flex justify-between text-[10px] text-[var(--color-text-tertiary)]"><span>10%</span><span>100%</span></div>
        </section>
      </div>
      <div className="notification-settings-feedback" aria-live="polite">
        {soundHint && <div role="status">{soundHint}</div>}
        {permissionHint && <div role="status">{permissionHint}</div>}
        {state.error && <div role="alert" className="notification-settings-error"><FailureNotice error={state.error} /></div>}
      </div>
      <div className="notification-settings-footer">
        <button type="button" disabled={!approvalSoundEnabled} onClick={() => void previewSound('approval')} className="notification-footer-preview">试听授权提示音</button>
        <button type="button" disabled={!sessionEndSoundEnabled} onClick={() => void previewSound('sessionEnd')} className="notification-footer-preview">试听任务结束提示音</button>
      </div>
  </>;

  if (embedded) return <div className="notification-settings-dialog notification-settings-dialog--embedded">{content}</div>;
  return <Modal open={open} onClose={onClose} labelledBy="notification-settings-title" containerClassName={mobile ? 'notification-settings-container' : ''} contentClassName="notification-settings-dialog">{content}</Modal>;
}
