import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { createHash } from 'node:crypto';
import type {
  ProjectUploadedFileDto,
  ProjectUploadUsageDto,
  UploadedFileAttachmentDto,
  UploadedFileDraftDto,
} from '../contracts/index.js';

export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PROJECT_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const TEMP_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_MESSAGE_UPLOAD_BYTES = 200 * 1024 * 1024;

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, 'i');
const MANIFEST_TEMP_PATTERN = new RegExp(`^\\.manifest-${UUID_SOURCE}\\.tmp$`, 'i');
const UPLOAD_PART_PATTERN = new RegExp(`^${UUID_SOURCE}\\.part$`, 'i');
const DANGEROUS_EXTENSIONS = new Set([
  '.app', '.appimage', '.apk', '.bin', '.cab', '.com', '.cpl', '.deb', '.dll',
  '.dmg', '.exe', '.gadget', '.img', '.iso', '.jar', '.lnk', '.msi', '.msp', '.msu',
  '.pkg', '.rpm', '.scr', '.sys',
]);
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export class UploadError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

export interface UploadManifestAttachment {
  uploadId: string;
  attachmentId: string;
  name: string;
  storedName: string;
  size: number;
  mimeType: string;
  createdAt: number;
}

export interface UploadManifest {
  version: 2;
  messageId: string;
  projectId: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
  attachments: UploadManifestAttachment[];
  forkCopy?: ForkCopyProof;
}
interface ForkCopyProof { operationId: string; sourceMessageId: string; sourceDigest: string; contentDigests: string[] }
export interface ForkUploadCopyInput {
  operationId: string; projectPath: string; sourceMessageId: string; targetMessageId: string; sourceAttachmentIds: string[];
  sourceIdentity: { projectId: string; userId: string }; targetIdentity: { projectId: string; userId: string };
}

function hashStableFile(filename: string): string {
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new UploadError(409, '附件文件已变化', 'UPLOAD_PATH_CHANGED');
  const fd = fs.openSync(filename, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new UploadError(409, '附件文件已变化', 'UPLOAD_PATH_CHANGED');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024*1024);
    let count = 0, bytes: number;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0,bytes)); count += bytes; }
    const after = fs.fstatSync(fd), current = fs.lstatSync(filename);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.isSymbolicLink()
      || current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) throw new UploadError(409, '附件文件已变化', 'UPLOAD_PATH_CHANGED');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export interface QuarantinedProjectUploads {
  operationId: string;
  quarantinePath: string;
  rollback(): void;
}

interface UploadLayout {
  projectRoot: string;
  uploadRoot: string;
  temporaryRoot: string;
  messagesRoot: string;
  identities: Map<string, { dev: number; ino: number }>;
}

type ArchiveLayout = Omit<UploadLayout, 'temporaryRoot'>;

interface StoreOptions {
  fileLimitBytes?: number;
  projectLimitBytes?: number;
  now?: () => number;
}

interface Reservation {
  messageId: string;
  size: number;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new UploadError(400, `${label} 无效`, 'INVALID_UPLOAD_ID');
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function assertNotSymlink(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new UploadError(403, '上传目录不允许使用符号链接', 'UPLOAD_SYMLINK_FORBIDDEN');
  if (!stat.isDirectory()) throw new UploadError(409, '上传路径不是目录', 'UPLOAD_PATH_CONFLICT');
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function countPayloadBytes(directory: string, ignoredPartIds = new Set<string>()): number {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.toLowerCase() === 'manifest.json' || MANIFEST_TEMP_PATTERN.test(entry.name)) continue;
    if (entry.name.endsWith('.part') && ignoredPartIds.has(entry.name.slice(0, -5))) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += countPayloadBytes(target, ignoredPartIds);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

export function hasDangerousHeader(header: Buffer): boolean {
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) return true;
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true;
  if (header.length >= 4) {
    const magic = header.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return true;
  }
  return false;
}

export function normalizeUploadName(input: string): string {
  const leaf = input.replaceAll('\\', '/').split('/').at(-1)?.normalize('NFC').trim() || '';
  if (!leaf || leaf === '.' || leaf === '..' || /[\u0000-\u001f\u007f]/.test(leaf)) {
    throw new UploadError(400, '文件名无效', 'INVALID_UPLOAD_NAME');
  }
  const extension = path.extname(portableStorageName(leaf)).toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(extension)) {
    throw new UploadError(415, '不允许上传可执行程序、安装包、动态库或磁盘镜像', 'DANGEROUS_UPLOAD');
  }
  if (Buffer.byteLength(leaf, 'utf8') > 255) throw new UploadError(400, '文件名过长', 'INVALID_UPLOAD_NAME');
  return leaf;
}

function normalizeMimeType(input: string): string {
  const mimeType = input.trim().toLowerCase();
  if (!mimeType || mimeType.length > 255 || /[\u0000-\u001f\u007f]/.test(mimeType)) {
    throw new UploadError(400, 'MIME 类型无效', 'INVALID_MIME_TYPE');
  }
  return mimeType;
}

function portableStorageName(name: string): string {
  let safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  if (!safe) safe = '文件';
  if (WINDOWS_RESERVED_NAMES.test(safe)) safe = `_${safe}`;
  return safe;
}

function addDuplicateSuffix(name: string, suffix: number): string {
  if (suffix <= 1) return name;
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const marker = ` (${suffix})`;
  let shortened = stem;
  while (Buffer.byteLength(`${shortened}${marker}${extension}`, 'utf8') > 255 && shortened.length > 0) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened || '文件'}${marker}${extension}`;
}

function allocateStorageName(name: string, usedNames: Iterable<string>): string {
  const base = portableStorageName(name);
  const used = new Set([...usedNames].map((entry) => entry.toLocaleLowerCase()));
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = addDuplicateSuffix(base, suffix);
    const normalized = candidate.toLocaleLowerCase();
    if (normalized !== 'manifest.json' && !MANIFEST_TEMP_PATTERN.test(candidate)
      && !UPLOAD_PART_PATTERN.test(candidate) && !used.has(normalized)) return candidate;
  }
  throw new UploadError(409, '同名文件过多，请修改文件名后重试', 'UPLOAD_NAME_CONFLICT');
}

export class ProjectUploadStore {
  private readonly fileLimitBytes: number;
  private readonly projectLimitBytes: number;
  private readonly now: () => number;
  private readonly reservations = new Map<string, Map<string, Reservation>>();
  private readonly messageLocks = new Map<string, Promise<void>>();

  constructor(options: StoreOptions = {}) {
    this.fileLimitBytes = options.fileLimitBytes ?? MAX_UPLOAD_FILE_BYTES;
    this.projectLimitBytes = options.projectLimitBytes ?? MAX_PROJECT_UPLOAD_BYTES;
    this.now = options.now ?? Date.now;
  }

  private layout(projectPath: string): UploadLayout {
    const projectRoot = fs.realpathSync(projectPath);
    if (!fs.statSync(projectRoot).isDirectory()) throw new UploadError(400, '项目路径不是目录');
    const uploadRoot = path.join(projectRoot, '.relay_upload');
    const temporaryRoot = path.join(uploadRoot, 'tmp');
    const messagesRoot = path.join(uploadRoot, 'messages');
    for (const target of [uploadRoot, temporaryRoot, messagesRoot]) {
      assertNotSymlink(target);
      fs.mkdirSync(target, { recursive: true });
      const real = fs.realpathSync(target);
      if (!isWithin(projectRoot, real)) throw new UploadError(403, '上传目录越出项目边界');
    }
    this.ensureUploadGitIgnore(uploadRoot);
    const identities = new Map([uploadRoot, temporaryRoot, messagesRoot].map((target) => {
      const stat = fs.lstatSync(target);
      return [target, { dev: stat.dev, ino: stat.ino }] as const;
    }));
    return { projectRoot, uploadRoot, temporaryRoot, messagesRoot, identities };
  }

  private archiveLayout(projectPath: string): ArchiveLayout | undefined {
    let projectRoot: string;
    try { projectRoot = fs.realpathSync(projectPath); }
    catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
    if (!fs.statSync(projectRoot).isDirectory()) throw new UploadError(409, '项目路径不是目录', 'UPLOAD_PATH_CONFLICT');
    const uploadRoot = path.join(projectRoot, '.relay_upload');
    const messagesRoot = path.join(uploadRoot, 'messages');
    const identities = new Map<string, { dev: number; ino: number }>();
    for (const target of [uploadRoot, messagesRoot]) {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(target); }
      catch (error) {
        if (isMissingPathError(error)) return undefined;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new UploadError(403, '托管附件目录边界校验失败', 'UPLOAD_PATH_CHANGED');
      }
      const real = fs.realpathSync(target);
      if (real !== target || !isWithin(projectRoot, real)) {
        throw new UploadError(403, '托管附件目录边界校验失败', 'UPLOAD_PATH_CHANGED');
      }
      identities.set(target, { dev: stat.dev, ino: stat.ino });
    }
    return { projectRoot, uploadRoot, messagesRoot, identities };
  }

  private ensureUploadGitIgnore(uploadRoot: string): void {
    const ignorePath = path.join(uploadRoot, '.gitignore');
    if (!fs.existsSync(ignorePath)) {
      try {
        fs.writeFileSync(ignorePath, '*\n', { encoding: 'utf8', flag: 'wx' });
        return;
      } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code !== 'EEXIST') throw error;
      }
    }
    const stat = fs.lstatSync(ignorePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new UploadError(409, '上传目录 Git 忽略文件冲突', 'UPLOAD_PATH_CONFLICT');
    if (!fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/).includes('*')) {
      throw new UploadError(409, '上传目录 Git 忽略规则无效', 'UPLOAD_PATH_CONFLICT');
    }
  }

  private assertLayoutStable(layout: UploadLayout): void {
    try {
      for (const target of [layout.uploadRoot, layout.temporaryRoot, layout.messagesRoot]) {
        const expected = layout.identities.get(target);
        const stat = fs.lstatSync(target);
        const real = fs.realpathSync(target);
        if (!expected || stat.isSymbolicLink() || !stat.isDirectory()
          || stat.dev !== expected.dev || stat.ino !== expected.ino
          || real !== target || !isWithin(layout.projectRoot, real)) {
          throw new UploadError(403, '上传目录在文件操作期间发生变化', 'UPLOAD_PATH_CHANGED');
        }
      }
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError(403, '上传目录在文件操作期间发生变化', 'UPLOAD_PATH_CHANGED');
    }
  }

  private assertManagedDirectory(layout: UploadLayout, root: string, directory: string): void {
    this.assertLayoutStable(layout);
    if (!isWithin(root, directory)) throw new UploadError(403, '上传路径越界');
    const stat = fs.lstatSync(directory);
    const real = fs.realpathSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || real !== directory || !isWithin(root, real)) {
      throw new UploadError(403, '上传目录边界校验失败', 'UPLOAD_PATH_CHANGED');
    }
  }

  private assertArchivedDirectory(layout: ArchiveLayout, directory: string): void {
    for (const target of [layout.uploadRoot, layout.messagesRoot]) {
      const expected = layout.identities.get(target);
      const stat = fs.lstatSync(target);
      if (!expected || stat.isSymbolicLink() || !stat.isDirectory()
        || stat.dev !== expected.dev || stat.ino !== expected.ino) {
        throw new UploadError(403, '托管附件目录在文件操作期间发生变化', 'UPLOAD_PATH_CHANGED');
      }
      const real = fs.realpathSync(target);
      if (real !== target || !isWithin(layout.projectRoot, real)) {
        throw new UploadError(403, '托管附件目录在文件操作期间发生变化', 'UPLOAD_PATH_CHANGED');
      }
    }
    if (!isWithin(layout.messagesRoot, directory)) throw new UploadError(403, '上传路径越界');
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UploadError(403, '上传目录边界校验失败', 'UPLOAD_PATH_CHANGED');
    }
    const real = fs.realpathSync(directory);
    if (real !== directory || !isWithin(layout.messagesRoot, real)) {
      throw new UploadError(403, '上传目录边界校验失败', 'UPLOAD_PATH_CHANGED');
    }
  }

  private projectReservations(projectRoot: string): Map<string, Reservation> {
    let current = this.reservations.get(projectRoot);
    if (!current) {
      current = new Map();
      this.reservations.set(projectRoot, current);
    }
    return current;
  }

  private messageDirectory(root: string, messageId: string): string {
    assertUuid(messageId, '消息标识');
    const directory = path.join(root, messageId);
    if (!isWithin(root, directory)) throw new UploadError(403, '上传路径越界');
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
      throw new UploadError(403, '上传目录不允许使用符号链接');
    }
    return directory;
  }

  private readManifest(directory: string): UploadManifest {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as Partial<UploadManifest>;
    if (parsed.version !== 2 || !parsed.messageId || !UUID_PATTERN.test(parsed.messageId)
      || !parsed.projectId || !UUID_PATTERN.test(parsed.projectId) || !parsed.userId || !UUID_PATTERN.test(parsed.userId)
      || !Number.isSafeInteger(parsed.createdAt) || !Number.isSafeInteger(parsed.updatedAt)
      || !Array.isArray(parsed.attachments) || parsed.attachments.some((entry) => (
        !entry || !UUID_PATTERN.test(entry.uploadId) || !UUID_PATTERN.test(entry.attachmentId)
        || !entry.name || !entry.storedName || entry.storedName === '.' || entry.storedName === '..'
        || path.basename(entry.storedName) !== entry.storedName
        || !Number.isSafeInteger(entry.size) || !entry.mimeType || !Number.isSafeInteger(entry.createdAt)
      ))) {
      throw new UploadError(409, '上传记录损坏', 'UPLOAD_MANIFEST_INVALID');
    }
    const manifest = parsed as UploadManifest;
    if (UUID_PATTERN.test(path.basename(directory)) && manifest.messageId !== path.basename(directory)) {
      throw new UploadError(409, '上传记录损坏', 'UPLOAD_MANIFEST_INVALID');
    }
    const uploadIds = new Set(manifest.attachments.map((entry) => entry.uploadId));
    const attachmentIds = new Set(manifest.attachments.map((entry) => entry.attachmentId));
    const storedNames = new Set(manifest.attachments.map((entry) => entry.storedName.toLocaleLowerCase()));
    if (uploadIds.size !== manifest.attachments.length || attachmentIds.size !== manifest.attachments.length
      || storedNames.size !== manifest.attachments.length) {
      throw new UploadError(409, '上传记录损坏', 'UPLOAD_MANIFEST_INVALID');
    }
    return manifest;
  }

  private writeManifest(directory: string, manifest: UploadManifest, flush = false): void {
    const temporary = path.join(directory, `.manifest-${uuid()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' });
    if (flush) { const fd = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    try { fs.renameSync(temporary, path.join(directory, 'manifest.json')); }
    catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }

  private emptyManifest(messageId: string, projectId: string, userId: string): UploadManifest {
    const createdAt = this.now();
    return { version: 2, messageId, projectId, userId, createdAt, updatedAt: createdAt, attachments: [] };
  }

  private assertManifestOwner(manifest: UploadManifest, projectId?: string, userId?: string): void {
    if ((projectId && manifest.projectId !== projectId) || (userId && manifest.userId !== userId)) {
      throw new UploadError(403, '无权访问此上传草稿');
    }
  }

  private assertPayloadFile(directory: string, entry: Pick<UploadManifestAttachment, 'storedName' | 'size'>): string {
    const payloadPath = path.join(directory, entry.storedName);
    if (!isWithin(directory, payloadPath) || !fs.existsSync(payloadPath)) {
      throw new UploadError(409, '上传文件不可用', 'UPLOAD_FILE_MISSING');
    }
    const stat = fs.lstatSync(payloadPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== entry.size) {
      throw new UploadError(409, '上传文件在落盘后发生变化', 'UPLOAD_PATH_CHANGED');
    }
    return payloadPath;
  }

  private findTemporary(projectPath: string, uploadId: string): { layout: UploadLayout; directory: string; manifest: UploadManifest; entry: UploadManifestAttachment } {
    assertUuid(uploadId, 'uploadId');
    const layout = this.layout(projectPath);
    for (const item of fs.readdirSync(layout.temporaryRoot, { withFileTypes: true })) {
      if (!UUID_PATTERN.test(item.name) || !item.isDirectory() || item.isSymbolicLink()) continue;
      const directory = this.messageDirectory(layout.temporaryRoot, item.name);
      try {
        const manifest = this.readManifest(directory);
        const entry = manifest.attachments.find((attachment) => attachment.uploadId === uploadId);
        if (entry) return { layout, directory, manifest, entry };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code === 'ENOENT') continue;
        if (error instanceof UploadError && error.code === 'UPLOAD_MANIFEST_INVALID') continue;
        throw error;
      }
    }
    throw new UploadError(404, '上传草稿不存在', 'UPLOAD_NOT_FOUND');
  }

  private async withMessageLock<T>(projectRoot: string, messageId: string, action: () => T | Promise<T>): Promise<T> {
    const key = `${projectRoot}\0${messageId}`;
    const previous = this.messageLocks.get(key) || Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.messageLocks.set(key, queued);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.messageLocks.get(key) === queued) this.messageLocks.delete(key);
    }
  }

  private scan(layout: UploadLayout): Omit<ProjectUploadUsageDto, 'reservedBytes' | 'limitBytes'> {
    const reservations = this.projectReservations(layout.projectRoot);
    let usedBytes = 0;
    let archivedFileCount = 0;
    let temporaryFileCount = 0;
    const scanRoot = (root: string, temporary: boolean) => {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!UUID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(root, entry.name);
        const ignoredPartIds = temporary
          ? new Set([...reservations].filter(([, reservation]) => reservation.messageId === entry.name).map(([uploadId]) => uploadId))
          : new Set<string>();
        usedBytes += countPayloadBytes(directory, ignoredPartIds);
        try {
          const count = this.readManifest(directory).attachments.length;
          if (temporary) temporaryFileCount += count;
          else archivedFileCount += count;
        } catch {}
      }
    };
    scanRoot(layout.temporaryRoot, true);
    scanRoot(layout.messagesRoot, false);
    return { usedBytes, archivedFileCount, temporaryFileCount };
  }

  getUsage(projectPath: string): ProjectUploadUsageDto {
    const layout = this.layout(projectPath);
    const reservations = this.projectReservations(layout.projectRoot);
    return {
      ...this.scan(layout),
      reservedBytes: [...reservations.values()].reduce((sum, entry) => sum + entry.size, 0),
      limitBytes: this.projectLimitBytes,
    };
  }

  reserve(projectPath: string, uploadId: string, size: number, messageId = uploadId): void {
    assertUuid(uploadId, 'uploadId');
    assertUuid(messageId, '消息标识');
    if (!Number.isSafeInteger(size) || size < 0) throw new UploadError(400, '文件大小无效');
    if (size > this.fileLimitBytes) throw new UploadError(413, '单文件超过 50MB 限制', 'UPLOAD_FILE_TOO_LARGE');
    const layout = this.layout(projectPath);
    const reservations = this.projectReservations(layout.projectRoot);
    if (reservations.has(uploadId)) throw new UploadError(409, 'uploadId 已在使用');
    const disk = this.scan(layout);
    const reservedBytes = [...reservations.values()].reduce((sum, entry) => sum + entry.size, 0);
    if (disk.usedBytes + reservedBytes + size > this.projectLimitBytes) {
      throw new UploadError(413, '项目上传容量不足', 'PROJECT_UPLOAD_LIMIT');
    }
    reservations.set(uploadId, { messageId, size });
  }

  release(projectPath: string, uploadId: string): void {
    let projectRoot: string;
    try { projectRoot = fs.realpathSync(projectPath); } catch { return; }
    const reservations = this.reservations.get(projectRoot);
    reservations?.delete(uploadId);
    if (reservations?.size === 0) this.reservations.delete(projectRoot);
  }

  hasInFlight(projectPath: string): boolean {
    try { return (this.reservations.get(fs.realpathSync(projectPath))?.size || 0) > 0; } catch { return false; }
  }

  getTemporaryDraft(projectPath: string, uploadId: string, userId?: string, projectId?: string, messageId?: string): UploadedFileDraftDto {
    const found = this.findTemporary(projectPath, uploadId);
    this.assertManifestOwner(found.manifest, projectId, userId);
    if (messageId && found.manifest.messageId !== messageId) throw new UploadError(409, '上传附件不属于当前消息草稿', 'UPLOAD_DRAFT_MISMATCH');
    this.assertManagedDirectory(found.layout, found.layout.temporaryRoot, found.directory);
    const payloadPath = this.assertPayloadFile(found.directory, found.entry);
    return {
      id: found.entry.attachmentId,
      kind: 'uploaded_file',
      messageId: found.manifest.messageId,
      uploadId: found.entry.uploadId,
      projectId: found.manifest.projectId,
      name: found.entry.name,
      path: payloadPath,
      size: found.entry.size,
      mimeType: found.entry.mimeType,
    };
  }

  deleteTemporary(projectPath: string, uploadId: string, userId?: string, projectId?: string): boolean {
    let found;
    try { found = this.findTemporary(projectPath, uploadId); }
    catch (error) {
      if (error instanceof UploadError && error.status === 404) return false;
      throw error;
    }
    this.assertManifestOwner(found.manifest, projectId, userId);
    this.assertManagedDirectory(found.layout, found.layout.temporaryRoot, found.directory);
    const payload = path.join(found.directory, found.entry.storedName);
    if (fs.existsSync(payload)) fs.rmSync(payload, { force: true });
    found.manifest.attachments = found.manifest.attachments.filter((entry) => entry.uploadId !== uploadId);
    found.manifest.updatedAt = this.now();
    const hasParts = fs.readdirSync(found.directory).some((entry) => entry.endsWith('.part'));
    if (found.manifest.attachments.length === 0 && !hasParts) fs.rmSync(found.directory, { recursive: true, force: true });
    else this.writeManifest(found.directory, found.manifest);
    return true;
  }

  prepareArchive(input: {
    projectPath: string;
    projectId: string;
    userId: string;
    messageId: string;
    drafts: UploadedFileDraftDto[];
  }): { attachments: UploadedFileAttachmentDto[]; rollback: () => void } {
    if (input.drafts.length === 0) return { attachments: [], rollback: () => undefined };
    assertUuid(input.messageId, '消息标识');
    const layout = this.layout(input.projectPath);
    const source = this.messageDirectory(layout.temporaryRoot, input.messageId);
    const target = this.messageDirectory(layout.messagesRoot, input.messageId);
    if (!fs.existsSync(source)) throw new UploadError(404, '上传草稿不存在', 'UPLOAD_NOT_FOUND');
    this.assertManagedDirectory(layout, layout.temporaryRoot, source);
    const manifest = this.readManifest(source);
    this.assertManifestOwner(manifest, input.projectId, input.userId);
    if (manifest.messageId !== input.messageId) throw new UploadError(409, '上传附件不属于当前消息草稿', 'UPLOAD_DRAFT_MISMATCH');
    if ([...this.projectReservations(layout.projectRoot).values()].some((entry) => entry.messageId === input.messageId)) {
      throw new UploadError(409, '当前消息仍有文件正在上传，请稍后重试', 'UPLOAD_IN_PROGRESS');
    }
    const seenUploads = new Set<string>();
    const seenAttachments = new Set<string>();
    let totalBytes = 0;
    const entries = input.drafts.map((draft) => {
      if (draft.messageId !== input.messageId || seenUploads.has(draft.uploadId) || seenAttachments.has(draft.id)) {
        throw new UploadError(400, '不能重复添加或跨消息使用上传附件', 'DUPLICATE_UPLOAD');
      }
      seenUploads.add(draft.uploadId);
      seenAttachments.add(draft.id);
      const entry = manifest.attachments.find((candidate) => candidate.uploadId === draft.uploadId);
      if (!entry || entry.attachmentId !== draft.id || entry.name !== draft.name || entry.size !== draft.size || entry.mimeType !== draft.mimeType) {
        throw new UploadError(409, '上传附件信息已变化，请重新选择', 'UPLOAD_DRAFT_MISMATCH');
      }
      this.assertPayloadFile(source, entry);
      totalBytes += entry.size;
      if (totalBytes > MAX_MESSAGE_UPLOAD_BYTES) throw new UploadError(413, '单条消息上传文件总量超过 200MB', 'MESSAGE_UPLOAD_LIMIT');
      return entry;
    });
    if (entries.length !== manifest.attachments.length) {
      throw new UploadError(409, '上传附件列表尚未同步，请稍后重试', 'UPLOAD_DRAFT_MISMATCH');
    }
    if (fs.existsSync(target)) throw new UploadError(409, '消息上传目录已存在', 'UPLOAD_ARCHIVE_CONFLICT');
    this.assertLayoutStable(layout);
    fs.renameSync(source, target);
    let attachments: UploadedFileAttachmentDto[];
    let targetVerified = false;
    try {
      this.assertManagedDirectory(layout, layout.messagesRoot, target);
      targetVerified = true;
      attachments = entries.map((entry) => ({
        id: entry.attachmentId,
        kind: 'uploaded_file',
        name: entry.name,
        path: this.assertPayloadFile(target, entry),
        size: entry.size,
        mimeType: entry.mimeType,
        available: true,
      }));
    } catch (error) {
      if (targetVerified && fs.existsSync(target) && !fs.existsSync(source)) {
        this.assertLayoutStable(layout);
        fs.renameSync(target, source);
        this.assertManagedDirectory(layout, layout.temporaryRoot, source);
      }
      throw error;
    }
    return {
      attachments,
      rollback: () => {
        if (fs.existsSync(target) && !fs.existsSync(source)) {
          this.assertManagedDirectory(layout, layout.messagesRoot, target);
          this.assertLayoutStable(layout);
          fs.renameSync(target, source);
          this.assertManagedDirectory(layout, layout.temporaryRoot, source);
        }
      },
    };
  }

  /** Reconcile an interrupted fork copy using a server-owned intent and content proofs; never overwrite an existing target. */
  ensureForkCopy(input: ForkUploadCopyInput): UploadedFileAttachmentDto[] {
    if (typeof input.operationId !== 'string' || !input.operationId || input.operationId.length > 256
      || !Array.isArray(input.sourceAttachmentIds) || !input.sourceAttachmentIds.length || input.sourceAttachmentIds.length > 100) throw new UploadError(400, '分支复制意图无效', 'INVALID_UPLOAD_ID');
    for (const identity of [input.sourceIdentity, input.targetIdentity]) {
      if (!identity) throw new UploadError(400, '分支复制身份缺失', 'INVALID_UPLOAD_ID');
      assertUuid(identity.projectId, '项目标识'); assertUuid(identity.userId, '用户标识');
    }
    const layout = this.layout(input.projectPath), source = this.messageDirectory(layout.messagesRoot, input.sourceMessageId);
    const target = this.messageDirectory(layout.messagesRoot, input.targetMessageId);
    this.assertManagedDirectory(layout, layout.messagesRoot, source);
    const sourceManifest = this.readManifest(source);
    this.assertManifestOwner(sourceManifest, input.sourceIdentity.projectId, input.sourceIdentity.userId);
    if (new Set(input.sourceAttachmentIds).size !== input.sourceAttachmentIds.length || input.sourceAttachmentIds.length !== sourceManifest.attachments.length) throw new UploadError(409, '分支附件清单已变化', 'UPLOAD_ARCHIVE_MISMATCH');
    const entries = input.sourceAttachmentIds.map((id) => {
      const entry = sourceManifest.attachments.find((e) => e.attachmentId === id);
      if (!entry) throw new UploadError(409, '分支附件清单已变化', 'UPLOAD_ARCHIVE_MISMATCH'); return entry;
    });
    const contentDigests = entries.map((entry) => hashStableFile(this.assertPayloadFile(source, entry)));
    const sourceDigest = createHash('sha256').update(JSON.stringify({ sourceManifest, contentDigests, order: input.sourceAttachmentIds })).digest('hex');
    const proof: ForkCopyProof = { operationId: input.operationId, sourceMessageId: input.sourceMessageId, sourceDigest, contentDigests };
    if (!fs.existsSync(target)) this.copyArchivedMessage({ ...input, copyProof: proof });
    this.assertLayoutStable(layout); this.assertManagedDirectory(layout, layout.messagesRoot, target);
    const manifest = this.readManifest(target), recorded = manifest.forkCopy;
    this.assertManifestOwner(manifest, input.targetIdentity.projectId, input.targetIdentity.userId);
    if (!recorded || recorded.operationId !== proof.operationId || recorded.sourceMessageId !== proof.sourceMessageId
      || recorded.sourceDigest !== sourceDigest || !Array.isArray(recorded.contentDigests) || recorded.contentDigests.length !== contentDigests.length
      || recorded.contentDigests.some((value, index) => value !== contentDigests[index]) || manifest.attachments.length !== entries.length) {
      throw new UploadError(409, '分支附件副本待核验，未覆盖已有目录', 'UPLOAD_FORK_COPY_UNCONFIRMED');
    }
    return manifest.attachments.map((entry, index) => {
      const original = entries[index]!;
      if (entry.name !== original.name || entry.storedName !== original.storedName || entry.size !== original.size || entry.mimeType !== original.mimeType
        || entry.attachmentId === original.attachmentId) throw new UploadError(409, '分支附件副本已变化', 'UPLOAD_FORK_COPY_UNCONFIRMED');
      const filename = this.assertPayloadFile(target, entry);
      if (hashStableFile(filename) !== contentDigests[index]) throw new UploadError(409, '分支附件内容校验不一致', 'UPLOAD_FORK_COPY_UNCONFIRMED');
      return { kind: 'uploaded_file', id: entry.attachmentId, name: entry.name, path: filename, size: entry.size, mimeType: entry.mimeType, available: true };
    });
  }

  copyArchivedMessage(input: {
    projectPath: string;
    sourceMessageId: string;
    targetMessageId: string;
    sourceAttachmentIds: string[];
    sourceIdentity?: { projectId: string; userId: string };
    targetIdentity?: { projectId: string; userId: string };
    copyProof?: ForkCopyProof;
  }): { attachments: UploadedFileAttachmentDto[]; rollback: () => void } {
    for (const identity of [input.sourceIdentity, input.targetIdentity]) {
      if (identity) { assertUuid(identity.projectId, '项目标识'); assertUuid(identity.userId, '用户标识'); }
    }
    const layout = this.layout(input.projectPath);
    const source = this.messageDirectory(layout.messagesRoot, input.sourceMessageId);
    const target = this.messageDirectory(layout.messagesRoot, input.targetMessageId);
    if (!fs.existsSync(source)) throw new UploadError(409, '来源消息附件目录不存在', 'UPLOAD_ARCHIVE_MISSING');
    if (fs.existsSync(target)) throw new UploadError(409, '分支消息附件目录已存在', 'UPLOAD_ARCHIVE_CONFLICT');
    this.assertManagedDirectory(layout, layout.messagesRoot, source);
    const sourceManifest = this.readManifest(source);
    if (input.sourceIdentity) this.assertManifestOwner(sourceManifest, input.sourceIdentity.projectId, input.sourceIdentity.userId);
    if (sourceManifest.messageId !== input.sourceMessageId) {
      throw new UploadError(409, '来源消息附件记录损坏', 'UPLOAD_MANIFEST_INVALID');
    }
    const requestedIds = new Set(input.sourceAttachmentIds);
    if (
      requestedIds.size !== input.sourceAttachmentIds.length
      || requestedIds.size !== sourceManifest.attachments.length
    ) {
      throw new UploadError(409, '来源消息附件列表与存档不一致', 'UPLOAD_ARCHIVE_MISMATCH');
    }
    const sourceEntries = input.sourceAttachmentIds.map((attachmentId) => {
      const entry = sourceManifest.attachments.find((candidate) => candidate.attachmentId === attachmentId);
      if (!entry) throw new UploadError(409, '来源消息附件列表与存档不一致', 'UPLOAD_ARCHIVE_MISMATCH');
      return entry;
    });
    const totalBytes = sourceEntries.reduce((sum, entry) => {
      this.assertPayloadFile(source, entry);
      return sum + entry.size;
    }, 0);
    if (this.getUsage(input.projectPath).usedBytes + totalBytes > this.projectLimitBytes) {
      throw new UploadError(413, '项目上传文件总量超过 1GB', 'PROJECT_UPLOAD_LIMIT');
    }

    const now = this.now();
    const entries = sourceEntries.map((entry) => ({
      ...entry,
      uploadId: uuid(),
      attachmentId: uuid(),
      createdAt: now,
    }));
    const manifest: UploadManifest = {
      ...sourceManifest,
      messageId: input.targetMessageId,
      ...(input.targetIdentity ? { projectId: input.targetIdentity.projectId, userId: input.targetIdentity.userId } : {}),
      forkCopy: input.copyProof,
      createdAt: now,
      updatedAt: now,
      attachments: entries,
    };
    this.assertLayoutStable(layout);
    fs.mkdirSync(target);
    try {
      for (let index = 0; index < entries.length; index += 1) {
        const sourceEntry = sourceEntries[index]!;
        const targetEntry = entries[index]!;
        fs.copyFileSync(
          this.assertPayloadFile(source, sourceEntry),
          path.join(target, targetEntry.storedName),
          fs.constants.COPYFILE_EXCL,
        );
        this.assertPayloadFile(target, targetEntry);
        if (input.copyProof) { const fd = fs.openSync(path.join(target, targetEntry.storedName), 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      }
      this.writeManifest(target, manifest, Boolean(input.copyProof));
      this.assertManagedDirectory(layout, layout.messagesRoot, target);
      return {
        attachments: entries.map((entry) => ({
          id: entry.attachmentId,
          kind: 'uploaded_file',
          name: entry.name,
          path: this.assertPayloadFile(target, entry),
          size: entry.size,
          mimeType: entry.mimeType,
          available: true,
        })),
        rollback: () => {
          if (!fs.existsSync(target)) return;
          this.assertManagedDirectory(layout, layout.messagesRoot, target);
          fs.rmSync(target, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (fs.existsSync(target)) {
        this.assertManagedDirectory(layout, layout.messagesRoot, target);
        fs.rmSync(target, { recursive: true, force: true });
      }
      throw error;
    }
  }

  listArchived(projectPath: string, userId?: string, projectId?: string): ProjectUploadedFileDto[] {
    const layout = this.layout(projectPath);
    const files: ProjectUploadedFileDto[] = [];
    for (const item of fs.readdirSync(layout.messagesRoot, { withFileTypes: true })) {
      if (!UUID_PATTERN.test(item.name) || !item.isDirectory() || item.isSymbolicLink()) continue;
      try {
        const directory = this.messageDirectory(layout.messagesRoot, item.name);
        const manifest = this.readManifest(directory);
        if ((userId && manifest.userId !== userId) || (projectId && manifest.projectId !== projectId)) continue;
        for (const entry of manifest.attachments) {
          const payload = path.join(directory, entry.storedName);
          files.push({
            id: entry.attachmentId,
            kind: 'uploaded_file',
            name: entry.name,
            size: entry.size,
            mimeType: entry.mimeType,
            available: fs.existsSync(payload) && !fs.lstatSync(payload).isSymbolicLink(),
            createdAt: entry.createdAt,
          });
        }
      } catch {}
    }
    return files.sort((left, right) => right.createdAt - left.createdAt);
  }

  deleteArchived(projectPath: string, attachmentIds?: string[], userId?: string, projectId?: string): number {
    const layout = this.layout(projectPath);
    const requested = attachmentIds ? new Set(attachmentIds) : null;
    let deletedCount = 0;
    for (const item of fs.readdirSync(layout.messagesRoot, { withFileTypes: true })) {
      if (!UUID_PATTERN.test(item.name) || !item.isDirectory() || item.isSymbolicLink()) continue;
      const directory = this.messageDirectory(layout.messagesRoot, item.name);
      let manifest: UploadManifest;
      try { manifest = this.readManifest(directory); } catch { continue; }
      if ((userId && manifest.userId !== userId) || (projectId && manifest.projectId !== projectId)) continue;
      const removed = manifest.attachments.filter((entry) => !requested || requested.has(entry.attachmentId));
      if (removed.length === 0) continue;
      this.assertManagedDirectory(layout, layout.messagesRoot, directory);
      for (const entry of removed) {
        const payload = path.join(directory, entry.storedName);
        if (fs.existsSync(payload)) fs.rmSync(payload, { force: true });
      }
      deletedCount += removed.length;
      manifest.attachments = manifest.attachments.filter((entry) => !removed.includes(entry));
      manifest.updatedAt = this.now();
      if (manifest.attachments.length === 0) fs.rmSync(directory, { recursive: true, force: true });
      else this.writeManifest(directory, manifest);
    }
    return deletedCount;
  }

  quarantineArchivedMessages(input: {
    projectPath: string;
    operationId: string;
    messageIds: string[];
  }): QuarantinedProjectUploads | undefined {
    if (input.messageIds.length === 0) return undefined;
    assertUuid(input.operationId, '清理操作标识');
    const messageIds = [...new Set(input.messageIds)];
    messageIds.forEach((messageId) => assertUuid(messageId, '消息标识'));
    const layout = this.archiveLayout(input.projectPath);
    if (!layout) return undefined;
    const existingMessageIds = messageIds.filter((messageId) => {
      const source = this.messageDirectory(layout.messagesRoot, messageId);
      try {
        this.assertArchivedDirectory(layout, source);
        return true;
      } catch (error) {
        if (isMissingPathError(error)) return false;
        throw error;
      }
    });
    if (existingMessageIds.length === 0) return undefined;
    const quarantineRoot = path.join(layout.uploadRoot, '.trash-quarantine');
    assertNotSymlink(quarantineRoot);
    fs.mkdirSync(quarantineRoot, { recursive: true });
    const quarantineRootReal = fs.realpathSync(quarantineRoot);
    if (quarantineRootReal !== quarantineRoot || !isWithin(layout.uploadRoot, quarantineRootReal)) {
      throw new UploadError(403, '附件隔离目录越出托管上传边界', 'UPLOAD_QUARANTINE_FORBIDDEN');
    }
    const operationPath = path.join(quarantineRoot, input.operationId);
    if (fs.existsSync(operationPath)) {
      throw new UploadError(409, '附件隔离操作已存在', 'UPLOAD_QUARANTINE_CONFLICT');
    }
    fs.mkdirSync(operationPath);
    const moved: Array<{ source: string; target: string }> = [];
    try {
      for (const messageId of existingMessageIds) {
        const source = this.messageDirectory(layout.messagesRoot, messageId);
        // The database metadata can outlive a previously removed managed archive.
        // There is no filesystem payload left to quarantine in that case.
        try { this.assertArchivedDirectory(layout, source); }
        catch (error) {
          if (isMissingPathError(error)) continue;
          throw error;
        }
        const target = path.join(operationPath, messageId);
        fs.renameSync(source, target);
        const targetStat = fs.lstatSync(target);
        const targetReal = fs.realpathSync(target);
        if (targetStat.isSymbolicLink() || !targetStat.isDirectory() || targetReal !== target || !isWithin(operationPath, targetReal)) {
          throw new UploadError(403, '托管附件隔离后边界校验失败', 'UPLOAD_PATH_CHANGED');
        }
        moved.push({ source, target });
      }
    } catch (error) {
      for (const entry of moved.reverse()) {
        if (fs.existsSync(entry.target) && !fs.existsSync(entry.source)) fs.renameSync(entry.target, entry.source);
      }
      if (fs.existsSync(operationPath) && fs.readdirSync(operationPath).length === 0) fs.rmdirSync(operationPath);
      throw error;
    }
    if (moved.length === 0) {
      fs.rmdirSync(operationPath);
      return undefined;
    }
    return {
      operationId: input.operationId,
      quarantinePath: operationPath,
      rollback: () => {
        for (const entry of [...moved].reverse()) {
          if (!fs.existsSync(entry.target)) continue;
          if (fs.existsSync(entry.source)) throw new UploadError(409, '附件原目录已被占用，无法回滚', 'UPLOAD_ROLLBACK_CONFLICT');
          fs.renameSync(entry.target, entry.source);
        }
        if (fs.existsSync(operationPath) && fs.readdirSync(operationPath).length === 0) fs.rmdirSync(operationPath);
      },
    };
  }

  async writeUpload(input: {
    projectId: string;
    projectPath: string;
    userId: string;
    messageId: string;
    uploadId: string;
    name: string;
    mimeType: string;
    declaredSize: number;
    body: AsyncIterable<Uint8Array>;
    /** Private isolated publisher inputs; never accepted from HTTP headers. */
    attachmentId?: string;
    expectedContentDigest?: string;
    mayCommit?: () => Promise<boolean>;
    flush?: boolean;
  }): Promise<UploadedFileDraftDto> {
    assertUuid(input.projectId, 'projectId');
    assertUuid(input.userId, 'userId');
    assertUuid(input.messageId, '消息标识');
    if(input.attachmentId!==undefined)assertUuid(input.attachmentId,'附件标识');
    if(input.expectedContentDigest!==undefined&&!/^[a-f0-9]{64}$/.test(input.expectedContentDigest))throw new UploadError(400,'文件摘要无效','INVALID_UPLOAD_DIGEST');
    const name = normalizeUploadName(input.name);
    const mimeType = normalizeMimeType(input.mimeType);
    this.reserve(input.projectPath, input.uploadId, input.declaredSize, input.messageId);
    const layout = this.layout(input.projectPath);
    const directory = this.messageDirectory(layout.temporaryRoot, input.messageId);
    const partPath = path.join(directory, `${input.uploadId}.part`);
    let handle: fs.promises.FileHandle | null = null;
    let createdDirectory = false;
    let ownedPart:{dev:number;ino:number}|null=null;
    let contentDigest:ReturnType<typeof createHash>|null=null;
    try {
      try {
        this.findTemporary(input.projectPath, input.uploadId);
        throw new UploadError(409, 'uploadId 已存在', 'UPLOAD_ID_CONFLICT');
      } catch (error) {
        if (!(error instanceof UploadError) || error.status !== 404) throw error;
      }
      this.assertLayoutStable(layout);
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory);
        createdDirectory = true;
      }
      this.assertManagedDirectory(layout, layout.temporaryRoot, directory);
      if (fs.existsSync(partPath)) throw new UploadError(409, 'uploadId 已存在', 'UPLOAD_ID_CONFLICT');
      handle = await fs.promises.open(partPath, 'wx');
      const openedPart=await handle.stat();ownedPart={dev:openedPart.dev,ino:openedPart.ino};
      let written = 0;
      let header = Buffer.alloc(0);
      contentDigest=input.expectedContentDigest?createHash('sha256'):null;
      for await (const value of input.body) {
        const chunk = Buffer.from(value);
        written += chunk.length;
        if (written > this.fileLimitBytes || written > input.declaredSize) {
          throw new UploadError(413, '上传实际大小超过声明或单文件限制', 'UPLOAD_FILE_TOO_LARGE');
        }
        if (header.length < 16) header = Buffer.concat([header, chunk.subarray(0, 16 - header.length)]);
        let offset=0;while(offset<chunk.length){const result=await handle.write(chunk,offset,chunk.length-offset);if(!result.bytesWritten)throw new UploadError(500,'上传写入未完成','UPLOAD_WRITE_INCOMPLETE');offset+=result.bytesWritten;}
        contentDigest?.update(chunk);
      }
      if(input.flush)await handle.sync();
      await handle.close();
      handle = null;
      if (written !== input.declaredSize) throw new UploadError(400, '上传实际大小与声明大小不一致', 'UPLOAD_SIZE_MISMATCH');
      if (hasDangerousHeader(header)) throw new UploadError(415, '检测到危险文件内容', 'DANGEROUS_UPLOAD');
      if(contentDigest&&contentDigest.copy().digest('hex')!==input.expectedContentDigest)throw new UploadError(409,'文件内容已变化','UPLOAD_CONTENT_CHANGED');

      return await this.withMessageLock(layout.projectRoot, input.messageId, async () => {
        if(input.mayCommit&&!await input.mayCommit())throw new UploadError(403,'附件写入权限已变化','UPLOAD_AUTHORITY_CHANGED');
        this.assertManagedDirectory(layout, layout.temporaryRoot, directory);
        const manifestPath = path.join(directory, 'manifest.json');
        const manifest = fs.existsSync(manifestPath)
          ? this.readManifest(directory)
          : this.emptyManifest(input.messageId, input.projectId, input.userId);
        this.assertManifestOwner(manifest, input.projectId, input.userId);
        if (manifest.messageId !== input.messageId) throw new UploadError(409, '消息上传目录冲突', 'UPLOAD_PATH_CONFLICT');
        if (manifest.attachments.some((entry) => entry.uploadId === input.uploadId)) {
          throw new UploadError(409, 'uploadId 已存在', 'UPLOAD_ID_CONFLICT');
        }
        const storedName = allocateStorageName(name, manifest.attachments.map((entry) => entry.storedName));
        const payloadPath = path.join(directory, storedName);
        if (fs.existsSync(payloadPath)) throw new UploadError(409, '上传文件名冲突', 'UPLOAD_NAME_CONFLICT');
        fs.renameSync(partPath, payloadPath);
        const attachmentId = input.attachmentId??uuid();
        const createdAt = this.now();
        const manifestEntry = { uploadId: input.uploadId, attachmentId, name, storedName, size: written, mimeType, createdAt };
        try {
          this.assertPayloadFile(directory, manifestEntry);
          manifest.attachments.push(manifestEntry);
          manifest.updatedAt = createdAt;
          this.writeManifest(directory, manifest,input.flush===true);
        } catch (error) {
          try { fs.renameSync(payloadPath, partPath); } catch {}
          throw error;
        }
        return {
          id: attachmentId,
          kind: 'uploaded_file' as const,
          messageId: input.messageId,
          uploadId: input.uploadId,
          projectId: input.projectId,
          name,
          path: payloadPath,
          size: written,
          mimeType,
        };
      });
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      try {
        this.assertLayoutStable(layout);this.assertManagedDirectory(layout,layout.temporaryRoot,directory);
        if(ownedPart&&fs.existsSync(partPath)){const current=fs.lstatSync(partPath);
          if(current.isFile()&&!current.isSymbolicLink()&&current.nlink===1&&current.dev===ownedPart.dev&&current.ino===ownedPart.ino
            &&(!contentDigest||hashStableFile(partPath)===contentDigest.copy().digest('hex')))fs.rmSync(partPath,{force:true});
        }
      } catch {}
      if (createdDirectory) {
        try { if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory); } catch {}
      }
      throw error;
    } finally {
      this.release(input.projectPath, input.uploadId);
    }
  }

  cleanupStaleTemporaryUploads(projectPath: string): number {
    const layout = this.layout(projectPath);
    const activeMessages = new Set([...this.projectReservations(layout.projectRoot).values()].map((entry) => entry.messageId));
    let removed = 0;
    for (const item of fs.readdirSync(layout.temporaryRoot, { withFileTypes: true })) {
      if (!UUID_PATTERN.test(item.name) || !item.isDirectory() || item.isSymbolicLink() || activeMessages.has(item.name)) continue;
      const directory = path.join(layout.temporaryRoot, item.name);
      let createdAt = fs.statSync(directory).mtimeMs;
      try { createdAt = this.readManifest(directory).updatedAt; } catch {}
      if (this.now() - createdAt < TEMP_UPLOAD_MAX_AGE_MS) continue;
      this.assertManagedDirectory(layout, layout.temporaryRoot, directory);
      fs.rmSync(directory, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}

export const projectUploadStore = new ProjectUploadStore();
