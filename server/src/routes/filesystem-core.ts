import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import {
  FileAccessResponseDtoSchema,
  HostFileAuthorizationResponseDtoSchema,
  OkDtoSchema,
  presentApiError,
} from '../contracts/index.js';

import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';

import { MAX_DOCUMENT_PREVIEW_SIZE } from '../documents/document-preview-limits.js';
import { DocumentPreviewError, normalizeDocumentPreviewError } from '../documents/document-preview-error.js';
import { runDocumentPreviewTask } from '../documents/document-preview-runner.js';
import {
  assertWindowsHiddenAttribSucceeded,
  getWindowsDrives,
  listDirs,
  listHostFileEntries,
  parseWindowsHiddenAttribOutput,
} from './filesystem-host-browser.js';
import {
  decodeTextPreview,
  readTextPreviewHead,
  getFilePreviewDisposition,
  getMimeType,
  isImageFile,
  MAX_COMPRESSIBLE_IMAGE_SIZE,
  MAX_IMAGE_PREVIEW_SIZE,
  MAX_TEXT_PREVIEW_SIZE,
  presentDocumentPreviewResult,
  presentSpreadsheetSheetResult,
} from './filesystem-preview.js';
import { readFileGitDiff } from './filesystem-git-diff.js';

export {
  assertWindowsHiddenAttribSucceeded,
  listHostFileEntries,
  parseWindowsHiddenAttribOutput,
} from './filesystem-host-browser.js';
export {
  decodeTextPreview,
  getFilePreviewDisposition,
  MAX_COMPRESSIBLE_IMAGE_SIZE,
  MAX_IMAGE_PREVIEW_SIZE,
  MAX_TEXT_PREVIEW_SIZE,
  presentDocumentPreviewResult,
  presentSpreadsheetSheetResult,
} from './filesystem-preview.js';


const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);
const LEGACY_DOCUMENT_EXTENSIONS = new Set(['.doc', '.xls']);
const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024; // 100MB

const authorizeFileSchema = z.object({
  path: z.string().trim().min(1).max(32_768),
}).strict();

const revokeFileSchema = z.object({
  accessToken: z.string().uuid(),
}).strict();

const authorizeHostFilesSchema = z.object({
  paths: z.array(z.string().trim().min(1).max(32_768)).min(1).max(10),
}).strict();

const createDirectorySchema = z.object({
  parentPath: z.string().trim().min(1).max(32_768),
  name: z.string().max(255),
}).strict();

const INVALID_DIRECTORY_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/;
const WINDOWS_RESERVED_DIRECTORY_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

class DirectoryCreationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500) {
    super(message);
  }
}

export function validateDirectoryName(input: string): string {
  const name = input.trim();
  if (!name) throw new DirectoryCreationError('请输入文件夹名称', 400);
  if (name === '.' || name === '..') throw new DirectoryCreationError('文件夹名称无效', 400);
  if (name.length > 255) throw new DirectoryCreationError('文件夹名称不能超过 255 个字符', 400);
  if (INVALID_DIRECTORY_NAME_CHARS.test(name)) throw new DirectoryCreationError('文件夹名称包含非法字符', 400);
  if (name.endsWith('.') || name.endsWith(' ')) throw new DirectoryCreationError('文件夹名称不能以句点或空格结尾', 400);
  if (WINDOWS_RESERVED_DIRECTORY_NAMES.test(name)) throw new DirectoryCreationError('该名称是系统保留名称', 400);
  return name;
}

export function createChildDirectory(parentPath: string, inputName: string): string {
  if (!path.isAbsolute(parentPath)) throw new DirectoryCreationError('当前路径必须是绝对路径', 400);

  const name = validateDirectoryName(inputName);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parentPath);
  } catch {
    throw new DirectoryCreationError('当前目录不存在或不可访问', 404);
  }

  if (!fs.statSync(realParent).isDirectory()) {
    throw new DirectoryCreationError('当前路径不是目录', 400);
  }

  const targetPath = path.join(realParent, name);
  if (path.dirname(targetPath) !== realParent) {
    throw new DirectoryCreationError('只能在当前目录下创建一级文件夹', 400);
  }
  if (fs.existsSync(targetPath)) {
    throw new DirectoryCreationError('同名文件夹已存在', 409);
  }

  try {
    fs.mkdirSync(targetPath);
    return fs.realpathSync(targetPath);
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'EEXIST') throw new DirectoryCreationError('同名文件夹已存在', 409);
    if (code === 'ENOENT') throw new DirectoryCreationError('当前目录不存在', 404);
    throw new DirectoryCreationError('创建文件夹失败，请检查目录权限', 500);
  }
}

export function isPathInsideRoots(targetPath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export interface FilesystemCoreOptions {
  getAllowedProjectRoots:(actor:Actor)=>Promise<string[]>;
  grants:{allows:(path:string,token:string|undefined,userId:string)=>boolean;grant:(path:string,userId:string)=>string;revoke:(token:string,userId:string)=>void};
}
/** File IO runs in the Native filesystem Worker; the legacy wrapper retains its previous execution model. */
export function createFilesystemCore(options:FilesystemCoreOptions){
const filesystem=new Hono<RelayEnv>(),fileAccessGrants=options.grants;
async function getAllowedProjectRoots(actor:Actor):Promise<string[]>{
  return (await options.getAllowedProjectRoots(actor)).flatMap(root=>{try{return[fs.realpathSync(root)];}catch{return[];}});
}
async function isFileAllowed(realPath: string, actor: Actor, accessToken?: string): Promise<boolean> {
  if (fileAccessGrants.allows(realPath, accessToken, actor.userId)) return true;
  return isPathInsideRoots(realPath, await getAllowedProjectRoots(actor));
}

class FileRouteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code?: string,
    readonly canForceAccess?: boolean,
  ) {
    super(message);
  }
}

async function resolveAllowedFile(filePath: string, actor: Actor, accessToken?: string): Promise<{ realPath: string; stat: fs.Stats }> {
  if (!filePath) throw new FileRouteError('缺少 path 参数', 400);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new FileRouteError('文件不存在', 404);
  const realPath = fs.realpathSync(resolved);
  if (!await isFileAllowed(realPath, actor, accessToken)) {
    throw new FileRouteError('该文件不在已添加的项目目录中', 403, 'PATH_NOT_ALLOWED', true);
  }
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new FileRouteError('不是文件', 400);
  return { realPath, stat };
}

function getFileCreatedAt(stat: fs.Stats): number | null {
  return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : null;
}

function documentErrorResponse(error: unknown): { message: string; code?: string; status: 400 | 403 | 404 | 408 | 409 | 500 } {
  if (error instanceof FileRouteError) {
    return { message: error.message, code: error.code, status: error.status };
  }
  const normalized = normalizeDocumentPreviewError(error);
  if (normalized.code === 'DOCUMENT_TIMEOUT') return { message: normalized.message, code: normalized.code, status: 408 };
  if (normalized.code === 'DOCUMENT_CHANGED') return { message: normalized.message, code: normalized.code, status: 409 };
  return { message: normalized.message, code: normalized.code, status: 400 };
}

/** 浏览目录接口 */
filesystem.get('/browse', async (c) => {
  const targetPath = c.req.query('path') || '';

  try {
    if (!targetPath) {
      // 根级：Windows 返回盘符列表，Unix 返回根目录
      if (process.platform === 'win32') {
        const drives = getWindowsDrives();
        return c.json({
          current: '',
          parent: null,
          entries: drives.map((d) => ({ name: `${d}\\`, path: `${d}\\`, modifiedAt: null })),
        });
      } else {
        return c.json({ current: '/', parent: null, entries: listDirs('/') });
      }
    }

    const resolved = fs.realpathSync(path.resolve(targetPath));
    if (!fs.statSync(resolved).isDirectory()) return c.json(presentApiError('当前路径不是目录'), 400);
    let parent = path.dirname(resolved);

    // 盘符根目录（如 C:\）的 parent 返回空字符串，表示回到盘符选择界面
    if (parent === resolved || /^[A-Z]:\\?$/i.test(resolved)) {
      parent = '';
    }

    return c.json({
      current: resolved,
      parent: parent !== resolved ? parent : '',
      entries: listDirs(resolved),
    });
  } catch {
    return c.json(presentApiError('无法访问此目录'), 403);
  }
});

/** 浏览 Relay 主机目录并列出可选择的普通文件。 */
filesystem.get('/browse-files', async (c) => {
  const targetPath = c.req.query('path') || '';
  try {
    if (!targetPath) {
      if (process.platform === 'win32') {
        return c.json({
          current: '',
          parent: null,
          entries: getWindowsDrives().map((drive) => ({
            name: `${drive}\\`, path: `${drive}\\`, kind: 'directory' as const, size: null, modifiedAt: null,
          })),
        });
      }
      return c.json({ current: '/', parent: null, entries: listHostFileEntries('/') });
    }

    const realPath = fs.realpathSync(path.resolve(targetPath));
    if (!fs.statSync(realPath).isDirectory()) return c.json(presentApiError('当前路径不是目录'), 400);
    let parent = path.dirname(realPath);
    if (parent === realPath || /^[A-Z]:\\?$/i.test(realPath)) parent = '';
    return c.json({
      current: realPath,
      parent: parent !== realPath ? parent : '',
      entries: listHostFileEntries(realPath),
    });
  } catch {
    return c.json(presentApiError('无法访问此目录'), 403);
  }
});

/** 在当前浏览目录下创建单级子目录 */
filesystem.post('/directories', async (c) => {
  const parsed = createDirectorySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('无效的创建目录请求'), 400);

  try {
    const createdPath = createChildDirectory(parsed.data.parentPath, parsed.data.name);
    return c.json({ path: createdPath });
  } catch (error: unknown) {
    if (error instanceof DirectoryCreationError) {
      return c.json(presentApiError(error.message), error.status);
    }
    return c.json(presentApiError('创建文件夹失败'), 500);
  }
});

/** 读取文件基础信息，与正文预览解耦，确保不支持预览的文件仍可显示元数据。 */
filesystem.get('/metadata', async (c) => {
  const filePath = c.req.query('path') || '';
  const accessToken = c.req.query('accessToken');

  try {
    const { realPath, stat } = await resolveAllowedFile(filePath, getRequestActor(c), accessToken);
    return c.json({
      path: realPath,
      size: stat.size,
      createdAt: getFileCreatedAt(stat),
      modifiedAt: stat.mtimeMs,
    });
  } catch (error: unknown) {
    if (error instanceof FileRouteError) {
      return c.json(presentApiError(error.message, {
        ...(error.code ? { code: error.code } : {}),
        ...(error.canForceAccess ? { canForceAccess: true } : {}),
      }), error.status);
    }
    return c.json(presentApiError(error instanceof Error ? error.message : '读取文件信息失败'), 500);
  }
});

/** Return a bounded single-file diff, subject to the same file access boundary as preview. */
filesystem.get('/git-diff', async (c) => {
  try {
    const { realPath, stat } = await resolveAllowedFile(c.req.query('path') || '', getRequestActor(c), c.req.query('accessToken'));
    if (stat.size > MAX_TEXT_PREVIEW_SIZE) return c.json(presentApiError('文件超过文本预览上限'), 400);
    return c.json(await readFileGitDiff(realPath));
  } catch (error: unknown) {
    if (error instanceof FileRouteError) {
      return c.json(presentApiError(error.message, {
        ...(error.code ? { code: error.code } : {}),
        ...(error.canForceAccess ? { canForceAccess: true } : {}),
      }), error.status);
    }
    return c.json(presentApiError('Git 变更读取失败或变更过大'), 500);
  }
});

/** 读取文件内容接口 —— 文本返回内容，图片返回 base64 data URL */
filesystem.get('/read', async (c) => {
  const filePath = c.req.query('path') || '';
  const accessToken = c.req.query('accessToken');

  if (!filePath) {
    return c.json(presentApiError('缺少 path 参数'), 400);
  }

  try {
    const { realPath, stat } = await resolveAllowedFile(filePath, getRequestActor(c), accessToken);
    const ext = path.extname(realPath).toLowerCase();

    if (LEGACY_DOCUMENT_EXTENSIONS.has(ext)) {
      return c.json(presentApiError('暂不支持此旧格式预览，请下载后查看', { code: 'DOCUMENT_FORMAT_UNSUPPORTED' }), 400);
    }
    if (DOCUMENT_EXTENSIONS.has(ext)) {
      if (stat.size > MAX_DOCUMENT_PREVIEW_SIZE) {
        return c.json(presentApiError(
          `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，预览上限 3MB，请下载后查看`,
          { code: 'FILE_PREVIEW_TOO_LARGE' },
        ), 400);
      }
      const baseTask = { filePath: realPath, expectedSize: stat.size, expectedMtimeMs: stat.mtimeMs };
      const result = await runDocumentPreviewTask({
        ...baseTask,
        kind: ext === '.pdf' ? 'pdf-metadata' : ext === '.docx' ? 'word' : 'spreadsheet',
      });
      return c.json(presentDocumentPreviewResult(result));
    }

    const previewDisposition = getFilePreviewDisposition(realPath, stat.size);

    // 图片：返回 base64 data URL
    if (previewDisposition.startsWith('image')) {
      if (previewDisposition === 'image-too-large') {
        return c.json(presentApiError(
          `图片过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 20MB，无法预览，请下载后查看`,
          { code: 'IMAGE_PREVIEW_TOO_LARGE' },
        ), 400);
      }
      if (previewDisposition === 'image-compressible') {
        return c.json({
          type: 'image-preview-required',
          size: stat.size,
          message: `图片较大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，可压缩后预览`,
        });
      }
      const buffer = fs.readFileSync(realPath);
      const mime = getMimeType(realPath);
      const base64 = buffer.toString('base64');
      return c.json({
        type: 'image',
        dataUrl: `data:${mime};base64,${base64}`,
        size: stat.size,
      });
    }

    // 文本文件：返回内容
    const truncated = previewDisposition === 'text-too-large';
    const content = truncated ? await readTextPreviewHead(realPath) : decodeTextPreview(fs.readFileSync(realPath));
    if (content === null) {
      return c.json(presentApiError(
        '该文件是二进制文件或不是受支持的 UTF-8 编码，请下载后查看',
        { code: 'FILE_PREVIEW_UNSUPPORTED' },
      ), 400);
    }
    return c.json({
      type: 'text',
      content,
      language: ext ? ext.slice(1) : 'plaintext',
      size: stat.size,
      ...(truncated ? { truncated: true } : {}),
    });
  } catch (error: unknown) {
    if (error instanceof FileRouteError) {
      return c.json(presentApiError(error.message, {
        ...(error.code ? { code: error.code } : {}),
        ...(error.canForceAccess ? { canForceAccess: true } : {}),
      }), error.status);
    }
    if (error instanceof DocumentPreviewError) {
      const response = documentErrorResponse(error);
      return c.json(presentApiError(response.message, response.code ? { code: response.code } : undefined), response.status);
    }
    return c.json(presentApiError(error instanceof Error ? error.message : '读取文件失败'), 500);
  }
});

/** 返回最多前 50 页的内存 PDF 副本，扫描页图像会原样保留。 */
filesystem.get('/preview-pdf-source', async (c) => {
  try {
    const filePath = c.req.query('path') || '';
    const accessToken = c.req.query('accessToken');
    const { realPath, stat } = await resolveAllowedFile(filePath, getRequestActor(c), accessToken);
    if (path.extname(realPath).toLowerCase() !== '.pdf') throw new FileRouteError('不是支持预览的 PDF 文件', 400);
    if (stat.size > MAX_DOCUMENT_PREVIEW_SIZE) throw new FileRouteError('文件超过 3 MB 预览上限，请下载后查看', 400, 'FILE_PREVIEW_TOO_LARGE');
    const result = await runDocumentPreviewTask({
      kind: 'pdf-source',
      filePath: realPath,
      expectedSize: stat.size,
      expectedMtimeMs: stat.mtimeMs,
    });
    if (!('type' in result) || result.type !== 'pdf-source') throw new DocumentPreviewError('DOCUMENT_INVALID', 'PDF 预览结果无效');
    return c.body(Buffer.from(result.bytes), 200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(result.bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Relay-Total-Pages': String(result.totalPages),
      'X-Relay-Displayed-Pages': String(result.displayedPages),
    });
  } catch (error: unknown) {
    const response = documentErrorResponse(error);
    const canForceAccess = error instanceof FileRouteError && error.canForceAccess;
    return c.json(presentApiError(response.message, {
      ...(response.code ? { code: response.code } : {}),
      ...(canForceAccess ? { canForceAccess: true } : {}),
    }), response.status);
  }
});

/** 按需读取指定 Excel 工作表，避免一次传输整个工作簿。 */
filesystem.get('/preview-spreadsheet-sheet', async (c) => {
  try {
    const filePath = c.req.query('path') || '';
    const accessToken = c.req.query('accessToken');
    const sheetName = c.req.query('sheet') || '';
    if (!sheetName || sheetName.length > 31) throw new FileRouteError('缺少有效的工作表名称', 400);
    const { realPath, stat } = await resolveAllowedFile(filePath, getRequestActor(c), accessToken);
    if (path.extname(realPath).toLowerCase() !== '.xlsx') throw new FileRouteError('不是支持预览的 Excel 文件', 400);
    if (stat.size > MAX_DOCUMENT_PREVIEW_SIZE) throw new FileRouteError('文件超过 3 MB 预览上限，请下载后查看', 400, 'FILE_PREVIEW_TOO_LARGE');
    const result = await runDocumentPreviewTask({
      kind: 'spreadsheet',
      filePath: realPath,
      expectedSize: stat.size,
      expectedMtimeMs: stat.mtimeMs,
      sheetName,
    });
    return c.json(presentSpreadsheetSheetResult(result));
  } catch (error: unknown) {
    const response = documentErrorResponse(error);
    const canForceAccess = error instanceof FileRouteError && error.canForceAccess;
    return c.json(presentApiError(response.message, {
      ...(response.code ? { code: response.code } : {}),
      ...(canForceAccess ? { canForceAccess: true } : {}),
    }), response.status);
  }
});

/** 仅供浏览器按用户操作生成压缩预览，原图超过 20MB 时拒绝读取。 */
filesystem.get('/preview-image-source', async (c) => {
  const filePath = c.req.query('path') || '';
  const accessToken = c.req.query('accessToken');
  if (!filePath) return c.json(presentApiError('缺少 path 参数'), 400);

  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return c.json(presentApiError('文件不存在'), 404);

    const realPath = fs.realpathSync(resolved);
    if (!await isFileAllowed(realPath, getRequestActor(c), accessToken)) {
      return c.json(presentApiError('该文件不在已添加的项目目录中', { code: 'PATH_NOT_ALLOWED' }), 403);
    }

    const stat = fs.statSync(realPath);
    if (!stat.isFile()) return c.json(presentApiError('不是文件'), 400);
    if (!isImageFile(realPath)) return c.json(presentApiError('不是支持预览的图片'), 400);
    if (stat.size > MAX_COMPRESSIBLE_IMAGE_SIZE) {
      return c.json(presentApiError(
        `图片过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 20MB，无法预览，请下载后查看`,
        { code: 'IMAGE_PREVIEW_TOO_LARGE' },
      ), 400);
    }

    return c.body(fs.readFileSync(realPath), 200, {
      'Content-Type': getMimeType(realPath),
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  } catch (error: unknown) {
    return c.json(presentApiError(error instanceof Error ? error.message : '读取图片失败'), 500);
  }
});

/** 用户从预览面板明确确认后，为单次预览签发单文件能力令牌。 */
filesystem.post('/authorize-file', async (c) => {
  const parsed = authorizeFileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('无效的文件路径'), 400);
  if (!path.isAbsolute(parsed.data.path)) return c.json(presentApiError('文件路径必须是绝对路径'), 400);

  try {
    const realPath = fs.realpathSync(parsed.data.path);
    if (!fs.statSync(realPath).isFile()) return c.json(presentApiError('不是文件'), 400);
    const accessToken = fileAccessGrants.grant(realPath, getRequestActor(c).userId);
    return c.json(FileAccessResponseDtoSchema.parse({ ok: true, accessToken }));
  } catch {
    return c.json(presentApiError('文件不存在或不可访问'), 404);
  }
});

/** 用户从文件选择器明确确认后，为本次消息签发逐文件能力令牌。 */
filesystem.post('/authorize-host-files', async (c) => {
  const parsed = authorizeHostFilesSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('请选择 1 到 10 个有效文件'), 400);

  try {
    const seen = new Set<string>();
    const files = parsed.data.paths.map((selectedPath) => {
      if (!path.isAbsolute(selectedPath)) throw new Error('文件路径必须是绝对路径');
      const realPath = fs.realpathSync(selectedPath);
      const stat = fs.statSync(realPath);
      if (!stat.isFile()) throw new Error('只能选择普通文件');
      const duplicateKey = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
      if (seen.has(duplicateKey)) throw new Error('不能重复选择同一个文件');
      seen.add(duplicateKey);
      return {
        id: randomUUID(),
        kind: 'host_file' as const,
        name: path.basename(realPath),
        path: realPath,
        size: stat.size,
      };
    });
    const attachments = files.map((file) => ({
      ...file,
      accessToken: fileAccessGrants.grant(file.path, getRequestActor(c).userId),
    }));
    return c.json(HostFileAuthorizationResponseDtoSchema.parse({ attachments }));
  } catch (error: unknown) {
    return c.json(presentApiError(error instanceof Error ? error.message : '文件不存在或不可访问'), 400);
  }
});

filesystem.post('/revoke-file', async (c) => {
  const parsed = revokeFileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('无效的访问令牌'), 400);
  fileAccessGrants.revoke(parsed.data.accessToken, getRequestActor(c).userId);
  return c.json(OkDtoSchema.parse({ ok: true }));
});

/** 下载原始文件，沿用已添加项目目录的访问边界。 */
filesystem.get('/download', async (c) => {
  const filePath = c.req.query('path') || '';
  const accessToken = c.req.query('accessToken');
  if (!filePath) return c.json(presentApiError('缺少 path 参数'), 400);

  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return c.json(presentApiError('文件不存在'), 404);

    const realPath = fs.realpathSync(resolved);
    if (!await isFileAllowed(realPath, getRequestActor(c), accessToken)) {
      return c.json(presentApiError('该文件不在已添加的项目目录中', { code: 'PATH_NOT_ALLOWED' }), 403);
    }

    const stat = fs.statSync(realPath);
    if (!stat.isFile()) return c.json(presentApiError('不是文件'), 400);
    if (stat.size > MAX_DOWNLOAD_SIZE) {
      return c.json(presentApiError(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，下载上限 100MB`), 400);
    }

    const fileName = path.basename(realPath).replace(/["\r\n]/g, '_');
    const contentType = isImageFile(realPath) ? getMimeType(realPath) : 'application/octet-stream';
    return c.body(fs.readFileSync(realPath), 200, {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'X-Content-Type-Options': 'nosniff',
    });
  } catch (error: unknown) {
    return c.json(presentApiError(error instanceof Error ? error.message : '下载文件失败'), 500);
  }
});

return filesystem;
}
