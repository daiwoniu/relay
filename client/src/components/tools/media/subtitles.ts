export interface Cue {
  id: number;
  start: number;
  end: number;
  text: string;
}
export type SubtitleFormat = 'srt' | 'vtt';

export function subtitleTime(seconds: number, separator = '.') {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

function parseTime(value: string) {
  const match = /^(?:(\d{1,4}):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})$/.exec(value);
  if (!match) return NaN;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
}

export function parseSubtitles(source: string): Cue[] {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[\t ]*\n/);
  const cues: Cue[] = [];
  for (const block of lines) {
    const rows = block.split('\n');
    if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(rows[0] ?? '')) continue;
    const position = rows.findIndex((line) => line.includes('-->'));
    if (position < 0) continue;
    const timing = /^\s*(\S+)\s*-->\s*(\S+)/.exec(rows[position]!);
    const text = rows.slice(position + 1).join('\n').trim();
    const start = timing ? parseTime(timing[1]!) : NaN;
    const end = timing ? parseTime(timing[2]!) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !text) {
      throw new Error(`第 ${cues.length + 1} 条字幕的时间或内容有误。`);
    }
    if (cues.length >= 1500) throw new Error('最多支持 1500 条字幕。');
    cues.push({ id: cues.length + 1, start, end, text });
  }
  if (!cues.length) throw new Error('没有找到字幕，请选择 SRT 或 VTT 文件。');
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function writeSubtitles(cues: readonly Cue[], format: SubtitleFormat) {
  if (!cues.length) throw new Error('请先添加字幕。');
  const separator = format === 'srt' ? ',' : '.';
  const blocks = [...cues].sort((a, b) => a.start - b.start || a.end - b.end).map((cue, index) => {
    if (cue.start < 0 || Math.round(cue.end * 1000) <= Math.round(cue.start * 1000) || !cue.text.trim()) {
      throw new Error(`第 ${index + 1} 条字幕需要有效的时间和文字。`);
    }
    const text = cue.text.trim().replace(/\n\s*\n/g, '\n');
    return `${format === 'srt' ? `${index + 1}\n` : ''}${subtitleTime(cue.start, separator)} --> ${subtitleTime(cue.end, separator)}\n${text}`;
  });
  return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${blocks.join('\n\n')}\n`;
}

export function shiftSubtitles(cues: Cue[], shift: number) {
  return cues.filter((cue) => cue.end + shift > 0).map((cue) => {
    const start = Math.max(0, cue.start + shift);
    const end = Math.max(start + .001, cue.end + shift);
    return { ...cue, start, end };
  });
}

export function captionsAt(cues: readonly Cue[], time: number) {
  return cues.filter((cue) => time >= cue.start && time < cue.end)
    .map((cue) => cue.text.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|nbsp);/g, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ',
    })[entity] ?? entity)).join('\n');
}

export async function importSubtitles(file: File) {
  if (file.size > 512 * 1024) throw new Error('字幕文件最大支持 512 KB。');
  return parseSubtitles(await file.text());
}
