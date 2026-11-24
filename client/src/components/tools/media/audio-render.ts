export interface PcmAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export type WaveShape = 'sine' | 'triangle' | 'square' | 'sawtooth';

export async function decodeAudio(file: Blob) {
  if (file.size > 100 * 1024 ** 2) throw new Error('音频文件最大支持 100 MB。');
  if (typeof AudioContext === 'undefined') throw new Error('当前浏览器不支持音频解码。');
  const context = new AudioContext();
  try { return await context.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('无法解码音频，请尝试 MP3、WAV 或浏览器支持的其他音频。'); }
  finally { await context.close(); }
}

export function sliceAudio(audio: AudioBuffer, start: number, end: number, gain: number, fadeIn: number, fadeOut: number): PcmAudio {
  const from = Math.floor(start * audio.sampleRate);
  const to = Math.min(audio.length, Math.ceil(end * audio.sampleRate));
  if (from < 0 || to <= from) throw new Error('结束时间必须晚于开始时间。');
  const frames = to - from;
  const fadeInFrames = fadeIn * audio.sampleRate;
  const fadeOutFrames = fadeOut * audio.sampleRate;
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => {
    const input = audio.getChannelData(channel);
    const output = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const inFactor = fadeInFrames ? i / fadeInFrames : 1;
      const outFactor = fadeOutFrames ? (frames - i - 1) / fadeOutFrames : 1;
      output[i] = input[from + i]! * gain * Math.min(1, inFactor, outFactor);
    }
    return output;
  });
  return { channels, sampleRate: audio.sampleRate };
}

export function encodeWav({ channels, sampleRate }: PcmAudio) {
  const frames = channels[0]?.length ?? 0;
  const frameBytes = channels.length * 2;
  const payloadSize = frames * frameBytes;
  const bytes = new ArrayBuffer(44 + payloadSize);
  const view = new DataView(bytes);
  function writeText(offset: number, value: string) {
    for (const [index, character] of Array.from(value).entries()) view.setUint8(index + offset, character.charCodeAt(0));
  }
  writeText(0, 'RIFF'); view.setUint32(4, 36 + payloadSize, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true); view.setUint16(32, frameBytes, true); view.setUint16(34, 16, true);
  writeText(36, 'data'); view.setUint32(40, payloadSize, true);
  let offset = 44;
  for (let index = 0; index < frames; index++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[index]!));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export function waveform(channel: Float32Array, count = 180) {
  return Array.from({ length: Math.min(channel.length, count) }, (_, index) => {
    const start = Math.floor(index * channel.length / count), end = Math.floor((index + 1) * channel.length / count);
    let max = 0;
    for (let sample = start; sample < Math.max(end, start + 1); sample++) max = Math.max(max, Math.abs(channel[sample] ?? 0));
    return max;
  });
}

export function toneAudio(frequencies: number[], seconds: number, gap: number, gain: number, decay: number, shape: WaveShape): PcmAudio {
  const sampleRate = 24000;
  const noteSamples = Math.round(seconds * sampleRate);
  const gapSamples = Math.round(gap * sampleRate);
  const output = new Float32Array(noteSamples * frequencies.length + gapSamples * (frequencies.length - 1));
  frequencies.forEach((frequency, note) => {
    const offset = note * (noteSamples + gapSamples);
    for (let index = 0; index < noteSamples; index++) {
      const phase = (index * frequency / sampleRate) % 1;
      const sine = Math.sin(phase * 2 * Math.PI);
      const value = shape === 'sine' ? sine : shape === 'triangle' ? 1 - 4 * Math.abs(phase - 0.5) : shape === 'square' ? Math.sign(sine) : 2 * phase - 1;
      const attack = index / (sampleRate * 0.008);
      const release = (noteSamples - index - 1) / Math.max(sampleRate * decay, sampleRate * 0.008);
      output[offset + index] = value * gain * Math.min(1, attack, release);
    }
  });
  return { sampleRate, channels: [output] };
}
