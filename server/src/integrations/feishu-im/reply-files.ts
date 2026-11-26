import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const maxFileBytes = 30_000_000;
export const maxFeishuReplyFiles = 10;
const shareable = new Set(['.csv', '.tsv', '.xlsx', '.xls', '.ods', '.pdf', '.docx', '.doc', '.pptx', '.ppt',
  '.md', '.txt', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.zip', '.mp4', '.mp3', '.wav']);

export const feishuReplyFile = z.object({
  id: z.string().uuid(), path: z.string().min(1).max(2048), name: z.string().min(1).max(255),
  fingerprint: z.string().min(1).max(256),
}).strict();
type ReplyFile = z.output<typeof feishuReplyFile>;

function localPath(value: string) {
  return /^(?:\/?[a-z]:[\\/]|\/(?!\/)|[\p{L}\p{N}_.-]+[\\/]|file:\/\/)/iu.test(value)
    || (!/[:/?#\\]/.test(value) && shareable.has(extname(value).toLowerCase()));
}

function safeRelative(workspace: string, target: string) {
  const path = relative(workspace, target);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return null;
  if (path.split(sep).some(part => part.startsWith('.') || /^(?:node_modules|credentials?|secrets?)$/i.test(part))) return null;
  if (/(?:^|[._-])(?:credentials?|secrets?|tokens?|private[._-]?keys?)(?:[._-]|$)/i.test(basename(path))) return null;
  return path;
}

function fingerprint(info: BigIntStats) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function validFile(info: BigIntStats) {
  return info.isFile() && info.nlink === 1n && info.size > 0n && info.size <= BigInt(maxFileBytes);
}

function referencePath(value: string) {
  if (/^file:/i.test(value)) {
    try { value = fileURLToPath(value); } catch { return null; }
  }
  return value.replace(/^\/(?=[a-z]:[\\/])/i, '').replace(/:\d+(?::\d+)?$/, '');
}

async function withReplyFile<T>(workspace: string, value: string,
  read: (handle: Awaited<ReturnType<typeof open>>, info: BigIntStats, path: string) => Promise<T> | T) {
  const cleaned = referencePath(value);
  if (!cleaned) return null;
  const target = resolve(workspace, cleaned);
  const path = safeRelative(workspace, target);
  if (!path || !shareable.has(extname(path).toLowerCase()) || /[\p{Cc}\p{Cf}]/u.test(path)) return null;
  try {
    const file = await realpath(target);
    const actual = safeRelative(workspace, file);
    if (!actual || (process.platform === 'win32' ? actual.toLowerCase() !== path.toLowerCase() : actual !== path)) return null;
    const expected = await stat(file, { bigint: true });
    if (!validFile(expected)) return null;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat({ bigint: true });
      if (fingerprint(info) !== fingerprint(expected) || safeRelative(workspace, await realpath(target)) !== actual) return null;
      return await read(handle, info, actual);
    } finally { await handle.close(); }
  } catch { return null; }
}

export async function prepareFeishuReplyFiles(body: string, workspace: string) {
  const files: ReplyFile[] = [];
  const inspected = new Set<string>();
  const unavailable = new Set<string>();
  const omitted = new Set<string>();
  const parts: string[] = [];
  let offset = 0;
  // Consume code fences and web links before matching local references inside prose.
  const references = new RegExp([
    /(^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\2[ \t]*$|(?![\s\S])))/.source,
    /!?\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^()\n]+))\)/.source,
    '(?<ticks>`+)([^`\\n]+)\\k<ticks>',
    /https?:\/\/[^\s<>`]+/.source,
    /(?<![\w:/\\])(?:file:\/\/|\/?[a-z]:[\\/]|\/(?!\/)|[\p{L}\p{N}_.-]+[\\/])[^\s<>`，。；、！？）]+/u.source,
  ].join('|'), 'gimu');
  for (const match of body.matchAll(references)) {
    const [raw, fence, , label, angled, link, , code] = match;
    const rawTarget = angled ?? link ?? code ?? raw.replace(/[,.;)\]]+$/, '');
    const target = rawTarget.trim();
    if (fence || !localPath(target)) continue;
    const path = referencePath(target);
    const name = basename((path ?? target).replace(/\\/g, '/'));
    const key = path ? resolve(workspace, path) : target;
    const shareableName = shareable.has(extname(name).toLowerCase());
    if (label === undefined && !shareableName) continue;
    const text = (shareableName ? name : label ?? name)
      .replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)
      .replace(/[\\`*_[\]~|]/g, '\\$&');
    parts.push(body.slice(offset, match.index), text, label === undefined && code === undefined ? raw.slice(rawTarget.length) : '');
    offset = match.index + raw.length;
    if (!shareableName) {
      unavailable.add(key);
      continue;
    }
    if (!inspected.has(key)) {
      if (inspected.size >= 40 || files.length >= maxFeishuReplyFiles) {
        omitted.add(key);
        continue;
      }
      inspected.add(key);
      const file = await withReplyFile(workspace, target, (_handle, info, path) => feishuReplyFile.parse({
        id: randomUUID(), path, name: basename(path), fingerprint: fingerprint(info),
      }));
      if (file && !files.some(prior => prior.path === file.path)) files.push(file);
      if (!file) unavailable.add(key);
    }
  }
  parts.push(body.slice(offset));
  return { body: parts.join(''), files, unavailableFileCount: unavailable.size, omittedFileCount: omitted.size };
}

export async function readFeishuReplyFile(workspace: string, file: ReplyFile) {
  return withReplyFile(workspace, file.path, async (handle, info, path) => {
    if (path !== file.path || fingerprint(info) !== file.fingerprint) return null;
    const content = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    return fingerprint(await handle.stat({ bigint: true })) === file.fingerprint ? content : null;
  });
}
