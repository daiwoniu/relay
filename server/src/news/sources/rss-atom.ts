import sanitizeHtml from 'sanitize-html';
import { SaxesParser } from 'saxes';
import type { SourceCandidate } from './source-types.js';

interface Frame { name: string; text: string }

function plainText(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {}, parser: { decodeEntities: true } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

export function parseRssAtom(xml: string, sourceId: string, baseUrl: string): SourceCandidate[] {
  if (Buffer.byteLength(xml, 'utf8') > 2 * 1024 * 1024) throw new RangeError('XML 超过 2 MiB');
  const parser = new SaxesParser({ xmlns: false });
  const frames: Frame[] = [];
  const candidates: SourceCandidate[] = [];
  let current: SourceCandidate | null = null;
  let guid: string | null = null;
  parser.on('opentag', (tag) => {
    const name = tag.name.split(':').at(-1)!.toLowerCase();
    frames.push({ name, text: '' });
    if (name === 'item' || name === 'entry') {
      current = { sourceId, rawUrl: '', baseUrl, title: '', description: null, rawPublishedAt: null };
      guid = null;
    }
    if (current && name === 'link') {
      const href = tag.attributes.href;
      const rel = tag.attributes.rel;
      if (typeof href === 'string' && (rel == null || rel === 'alternate')) current.rawUrl = href;
    }
  });
  parser.on('text', (text) => { if (frames.length) frames[frames.length - 1]!.text += text; });
  parser.on('cdata', (text) => { if (frames.length) frames[frames.length - 1]!.text += text; });
  parser.on('closetag', () => {
    const frame = frames.pop();
    if (!frame) return;
    const text = frame.text.trim();
    if (current) {
      if (frame.name === 'title' && !current.title) current.title = plainText(text);
      else if (frame.name === 'link' && !current.rawUrl) current.rawUrl = text;
      else if (frame.name === 'guid') guid = text;
      else if (['author', 'creator'].includes(frame.name) && !current.originalPublisher) current.originalPublisher = plainText(text) || null;
      else if (['description', 'summary', 'content', 'encoded'].includes(frame.name) && !current.description) current.description = plainText(text) || null;
      else if (['pubdate', 'published', 'updated', 'date'].includes(frame.name) && !current.rawPublishedAt) current.rawPublishedAt = text;
      if (frame.name === 'item' || frame.name === 'entry') {
        if (!current.rawUrl && guid?.startsWith('http')) current.rawUrl = guid;
        if (current.title && current.rawUrl && candidates.length < 100) candidates.push(current);
        current = null;
      }
    }
    if (frames.length) frames[frames.length - 1]!.text += frame.text;
  });
  parser.write(xml).close();
  return candidates;
}
