import { crc32 } from 'node:zlib';
import { ArchivePreviewDtoSchema, type ArchiveEntryDto, type ArchivePreviewDto } from '../contracts/index.js';
import { DocumentPreviewError } from './document-preview-error.js';

const MAX_SCAN_ENTRIES = 5000;
const MAX_DISPLAY_ENTRIES = 1000;
const MAX_PATH_BYTES = 512 * 1024;

function invalid(message = 'ZIP 目录损坏，无法预览，请下载后查看'): never {
  throw new DocumentPreviewError('DOCUMENT_INVALID', message);
}

function checkedEntryPath(name: string): string {
  const entryPath = name.replace(/\\/g, '/').replace(/\/$/, '');
  if (!entryPath || entryPath.length > 1024 || entryPath.split('/').length > 32 || /[\x00-\x1f\x7f]/.test(entryPath)
    || entryPath.startsWith('/') || /^[a-z]:/i.test(entryPath) || entryPath.split('/').some(part => !part || part === '.' || part === '..')) {
    invalid('ZIP 包含无法安全展示的目录路径，请下载后查看');
  }
  return entryPath;
}

/** Read only the ZIP central directory. Payloads are never decoded or inflated. */
function inspectDirectory(buffer: Buffer): ArchiveEntryDto[] {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65535); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset; break;
    }
  }
  if (end < 0) invalid();
  const count = buffer.readUInt16LE(end + 10);
  const bytes = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || bytes === 0xffffffff || start === 0xffffffff) {
    invalid('暂不支持 ZIP64 压缩包目录预览，请下载后查看');
  }
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count) {
    invalid('暂不支持分卷 ZIP 压缩包目录预览，请下载后查看');
  }
  if (count > MAX_SCAN_ENTRIES) throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', 'ZIP 目录超过 5000 条，无法预览，请下载后查看');
  if (start + bytes !== end) invalid();
  const entries: ArchiveEntryDto[] = [];
  const paths = new Set<string>();
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = buffer.readUInt16LE(offset + 8);
    if (flags & 65) invalid('该 ZIP 已加密，暂不支持目录预览，请下载后查看');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (nameLength === 0 || nameLength > 4096 || buffer.readUInt16LE(offset + 34)) invalid();
    if (buffer.readUInt32LE(offset + 20) === 0xffffffff || buffer.readUInt32LE(offset + 24) === 0xffffffff || buffer.readUInt32LE(offset + 42) === 0xffffffff) {
      invalid('暂不支持 ZIP64 压缩包目录预览，请下载后查看');
    }
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) invalid();
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    checkedEntryPath(decodeLegacyName(rawName));
    const extra = buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const name = decodeEntryName(rawName, flags, extra);
    const entryPath = checkedEntryPath(name);
    if (paths.has(entryPath)) invalid('ZIP 存在重复或冲突路径，无法完整预览目录，请下载后查看');
    paths.add(entryPath);
    const compressedSize = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (localOffset + 30 > start || buffer.readUInt32LE(localOffset) !== 0x04034b50) invalid();
    const payloadStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (payloadStart + compressedSize > start) invalid();
    const attributes = buffer.readUInt32LE(offset + 38);
    const directory = /[\\/]$/.test(name) || Boolean(attributes & 0x10) || (attributes >>> 16 & 0xf000) === 0x4000;
    entries.push({ path: entryPath, directory, size, compressedSize, modifiedAt: decodeDosTime(buffer.readUInt16LE(offset + 14), buffer.readUInt16LE(offset + 12)) });
    offset = next;
  }
  if (offset !== end) invalid();
  return entries;
}

function decodeLegacyName(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}

function decodeEntryName(rawName: Buffer, flags: number, extra: Buffer): string {
  let unicodeName: string | undefined;
  for (let offset = 0; offset < extra.length;) {
    if (offset + 4 > extra.length) invalid();
    const kind = extra.readUInt16LE(offset), length = extra.readUInt16LE(offset + 2);
    const next = offset + 4 + length;
    if (next > extra.length) invalid();
    if (kind === 1) invalid('暂不支持 ZIP64 压缩包目录预览，请下载后查看');
    if (kind === 0x7075 && length >= 5 && extra[offset + 4] === 1 && extra.readUInt32LE(offset + 5) === crc32(rawName)) {
      try { unicodeName = new TextDecoder('utf-8', { fatal: true }).decode(extra.subarray(offset + 9, next)); }
      catch { invalid(); }
    }
    offset = next;
  }
  if (flags & 0x800) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(rawName); }
    catch { invalid(); }
  }
  return unicodeName ?? decodeLegacyName(rawName);
}

function decodeDosTime(date: number, time: number): number | null {
  const year = 1980 + (date >>> 9), month = (date >>> 5 & 15) - 1, day = date & 31;
  const hour = time >>> 11, minute = time >>> 5 & 63, second = (time & 31) * 2;
  const result = new Date(year, month, day, hour, minute, second);
  return result.getFullYear() === year && result.getMonth() === month && result.getDate() === day
    && result.getHours() === hour && result.getMinutes() === minute && result.getSeconds() === second ? result.getTime() : null;
}

export async function parseArchivePreview(buffer: Buffer): Promise<ArchivePreviewDto> {
  const files = inspectDirectory(buffer);
  const entries: ArchiveEntryDto[] = [];
  let totalFiles = 0, totalSize = 0, totalCompressedSize = 0, pathBytes = 0, truncated = false;
  for (const file of files) {
    if (!file.directory) { totalFiles++; totalSize += file.size; totalCompressedSize += file.compressedSize; }
    // Keep a prefix so search and directory browsing share a clear, bounded scope.
    if (!truncated && entries.length < MAX_DISPLAY_ENTRIES && pathBytes + Buffer.byteLength(file.path) <= MAX_PATH_BYTES) {
      pathBytes += Buffer.byteLength(file.path);
      entries.push(file);
    } else truncated = true;
  }
  return ArchivePreviewDtoSchema.parse({ type: 'archive', format: 'zip', entries, totalEntries: files.length, totalFiles, totalSize, totalCompressedSize, truncated, size: buffer.length });
}
