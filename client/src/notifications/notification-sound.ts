import type { NotificationPreferencesDto } from '../generated/relay-contracts.ts';

export type NotificationSound = NotificationPreferencesDto['approvalSound'];

export interface NotificationSoundNote {
  frequency: number;
  start: number;
  stop: number;
  gain: number;
}

export interface NotificationSoundDefinition {
  label: string;
  oscillator: OscillatorType;
  notes: readonly NotificationSoundNote[];
}

export const NOTIFICATION_SOUND_OPTIONS: ReadonlyArray<{ value: NotificationSound; label: string }> = [
  { value: 'gentle_dual', label: '轻柔双音' },
  { value: 'crisp', label: '清脆提示' },
  { value: 'soft_chime', label: '柔和铃声' },
  { value: 'short_tone', label: '简短单音' },
  { value: 'high_dual', label: '高穿透双响' },
  { value: 'rising_triple', label: '上扬三音' },
  { value: 'falling_low', label: '低沉下降音' },
];

export const NOTIFICATION_SOUND_DEFINITIONS: Record<NotificationSound, NotificationSoundDefinition> = {
  gentle_dual: {
    label: '轻柔双音',
    oscillator: 'sine',
    notes: [
      { frequency: 660, start: 0, stop: 0.105, gain: 0.82 },
      { frequency: 880, start: 0.13, stop: 0.235, gain: 1 },
    ],
  },
  crisp: {
    label: '清脆提示',
    oscillator: 'triangle',
    notes: [
      { frequency: 920, start: 0, stop: 0.075, gain: 0.72 },
      { frequency: 1240, start: 0.085, stop: 0.18, gain: 1 },
    ],
  },
  soft_chime: {
    label: '柔和铃声',
    oscillator: 'sine',
    notes: [
      { frequency: 523.25, start: 0, stop: 0.18, gain: 0.62 },
      { frequency: 659.25, start: 0.11, stop: 0.31, gain: 0.78 },
      { frequency: 783.99, start: 0.22, stop: 0.45, gain: 1 },
    ],
  },
  short_tone: {
    label: '简短单音',
    oscillator: 'sine',
    notes: [{ frequency: 760, start: 0, stop: 0.13, gain: 0.88 }],
  },
  high_dual: {
    label: '高穿透双响',
    oscillator: 'triangle',
    notes: [
      { frequency: 880, start: 0, stop: 0.085, gain: 0.82 },
      { frequency: 1320, start: 0.105, stop: 0.205, gain: 1 },
    ],
  },
  rising_triple: {
    label: '上扬三音',
    oscillator: 'triangle',
    notes: [
      { frequency: 660, start: 0, stop: 0.09, gain: 0.72 },
      { frequency: 880, start: 0.105, stop: 0.205, gain: 0.84 },
      { frequency: 1100, start: 0.22, stop: 0.34, gain: 1 },
    ],
  },
  falling_low: {
    label: '低沉下降音',
    oscillator: 'triangle',
    notes: [
      { frequency: 520, start: 0, stop: 0.13, gain: 0.9 },
      { frequency: 390, start: 0.15, stop: 0.31, gain: 1 },
    ],
  },
};

let audioContext: AudioContext | null = null;

export function getNotificationSoundPeakGain(volume: number): number {
  const safeVolume = Math.min(100, Math.max(10, volume));
  return Number(((safeVolume / 100) * 0.55).toFixed(4));
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  audioContext ??= new AudioContextConstructor();
  return audioContext;
}

export async function playNotificationSound(sound: NotificationSound, volume: number): Promise<boolean> {
  try {
    const context = getAudioContext();
    if (!context) return false;
    if (context.state === 'suspended') await context.resume();
    const definition = NOTIFICATION_SOUND_DEFINITIONS[sound];
    const peakGain = getNotificationSoundPeakGain(volume);
    const now = context.currentTime;
    for (const note of definition.notes) {
      const noteStart = now + note.start;
      const noteStop = now + note.stop;
      const noteGain = Math.max(0.0001, peakGain * note.gain);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(noteGain, noteStart + Math.min(0.014, (note.stop - note.start) / 4));
      gain.gain.setValueAtTime(noteGain, Math.max(noteStart, noteStop - 0.03));
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStop);
      gain.connect(context.destination);
      const oscillator = context.createOscillator();
      oscillator.type = definition.oscillator;
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      oscillator.connect(gain);
      oscillator.start(noteStart);
      oscillator.stop(noteStop);
    }
    return true;
  } catch {
    return false;
  }
}
