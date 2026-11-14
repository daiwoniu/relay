import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import { createDocxBuffer, createPdfBuffer, createXlsxBuffer } from '../documents/test-documents.js';
import rawFilesystemRouter, {
  createChildDirectory,
  decodeTextPreview,
  getFilePreviewDisposition,
  isPathInsideRoots,
  MAX_COMPRESSIBLE_IMAGE_SIZE,
  MAX_IMAGE_PREVIEW_SIZE,
  MAX_TEXT_PREVIEW_SIZE,
  assertWindowsHiddenAttribSucceeded,
  validateDirectoryName,
  listHostFileEntries,
  parseWindowsHiddenAttribOutput,
  presentDocumentPreviewResult,
  presentSpreadsheetSheetResult,
} from './filesystem.js';

const filesystemRouter = new Hono<RelayEnv>();
filesystemRouter.use('*', async (c, next) => {
  c.set('relayActor', { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin' });
  return next();
});
filesystemRouter.route('/', rawFilesystemRouter);

test('文本预览只接受严格 UTF-8 和常规文本控制字符', () => {
  assert.equal(decodeTextPreview(Buffer.from('hello\n中文\tworld', 'utf8')), 'hello\n中文\tworld');
  assert.equal(decodeTextPreview(Buffer.from('line one\r\nline two', 'utf8')), 'line one\r\nline two');
  assert.equal(decodeTextPreview(Buffer.from([0x61, 0x00, 0x62])), null);
  assert.equal(decodeTextPreview(Buffer.from([0xc3, 0x28])), null);
  assert.equal(decodeTextPreview(Buffer.from([0x61, 0x01, 0x62])), null);
});

test('文件元数据接口返回大小与文件时间并遵守单文件授权边界', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-metadata-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const filePath = path.join(tempRoot, 'report.md');
  fs.writeFileSync(filePath, 'metadata');

  const denied = await filesystemRouter.request(`http://localhost/metadata?path=${encodeURIComponent(filePath)}`);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { code: string }).code, 'PATH_NOT_ALLOWED');

  const authorization = await filesystemRouter.request('http://localhost/authorize-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
  });
  const token = (await authorization.json() as { accessToken: string }).accessToken;
  const response = await filesystemRouter.request(`http://localhost/metadata?path=${encodeURIComponent(filePath)}&accessToken=${token}`);
  const body = await response.json() as { path: string; size: number; createdAt: number | null; modifiedAt: number };
  const stat = fs.statSync(filePath);

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.path, fs.realpathSync(filePath));
  assert.equal(body.size, stat.size);
  assert.equal(body.modifiedAt, stat.mtimeMs);
  assert.equal(body.createdAt, Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : null);
});

test('无扩展名文本使用 plaintext，二进制文件拒绝预览', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-text-preview-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const textPath = path.join(tempRoot, 'Dockerfile');
  const binaryPath = path.join(tempRoot, 'archive.bin');
  const textContent = 'FROM node:22\nRUN npm ci\n';
  fs.writeFileSync(textPath, textContent);
  fs.writeFileSync(binaryPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

  const authorize = async (filePath: string) => {
    const response = await filesystemRouter.request('http://localhost/authorize-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { accessToken: string }).accessToken;
  };

  const textToken = await authorize(textPath);
  const textResponse = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(textPath)}&accessToken=${textToken}`);
  const textBody = await textResponse.json() as { type: string; content: string; language: string; size: number };
  assert.equal(textResponse.status, 200);
  assert.deepEqual(textBody, {
    type: 'text', content: textContent, language: 'plaintext', size: Buffer.byteLength(textContent),
  });

  const binaryToken = await authorize(binaryPath);
  const binaryResponse = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(binaryPath)}&accessToken=${binaryToken}`);
  const binaryBody = await binaryResponse.json() as { error: string; code: string };
  assert.equal(binaryResponse.status, 400);
  assert.equal(binaryBody.code, 'FILE_PREVIEW_UNSUPPORTED');
  assert.match(binaryBody.error, /二进制|编码/);
});

test('文件预览按文本 3MB、图片 5MB 和图片压缩 20MB 分级', () => {
  assert.equal(getFilePreviewDisposition('readme.md', MAX_TEXT_PREVIEW_SIZE), 'text');
  assert.equal(getFilePreviewDisposition('readme.md', MAX_TEXT_PREVIEW_SIZE + 1), 'text-too-large');
  assert.equal(getFilePreviewDisposition('screen.png', MAX_IMAGE_PREVIEW_SIZE), 'image');
  assert.equal(getFilePreviewDisposition('screen.png', MAX_IMAGE_PREVIEW_SIZE + 1), 'image-compressible');
  assert.equal(getFilePreviewDisposition('screen.png', MAX_COMPRESSIBLE_IMAGE_SIZE), 'image-compressible');
  assert.equal(getFilePreviewDisposition('screen.png', MAX_COMPRESSIBLE_IMAGE_SIZE + 1), 'image-too-large');
});

test('文件读取接口返回压缩预览提示并在 20MB 处拒绝图片预览', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-preview-size-'));
  const textPath = path.join(tempRoot, 'large.txt');
  const compressibleImagePath = path.join(tempRoot, 'compressible.png');
  const oversizedImagePath = path.join(tempRoot, 'oversized.png');

  const authorize = async (filePath: string) => {
    const response = await filesystemRouter.request('http://localhost/authorize-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { accessToken: string }).accessToken;
  };

  try {
    fs.writeFileSync(textPath, Buffer.alloc(MAX_TEXT_PREVIEW_SIZE + 1));
    fs.writeFileSync(compressibleImagePath, Buffer.alloc(MAX_IMAGE_PREVIEW_SIZE + 1));
    fs.writeFileSync(oversizedImagePath, Buffer.alloc(MAX_COMPRESSIBLE_IMAGE_SIZE + 1));

    const textToken = await authorize(textPath);
    const textResponse = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(textPath)}&accessToken=${textToken}`);
    const textBody = await textResponse.json() as { error: string };
    assert.equal(textResponse.status, 400, JSON.stringify(textBody));
    assert.match(textBody.error, /二进制文件|UTF-8/);

    const imageToken = await authorize(compressibleImagePath);
    const imageResponse = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(compressibleImagePath)}&accessToken=${imageToken}`);
    assert.equal(imageResponse.status, 200);
    assert.equal((await imageResponse.json() as { type: string }).type, 'image-preview-required');

    const previewSourceResponse = await filesystemRouter.request(`http://localhost/preview-image-source?path=${encodeURIComponent(compressibleImagePath)}&accessToken=${imageToken}`);
    assert.equal(previewSourceResponse.status, 200);
    assert.equal(Number(previewSourceResponse.headers.get('Content-Length')), MAX_IMAGE_PREVIEW_SIZE + 1);

    const oversizedToken = await authorize(oversizedImagePath);
    const oversizedResponse = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(oversizedImagePath)}&accessToken=${oversizedToken}`);
    assert.equal(oversizedResponse.status, 400);
    assert.match((await oversizedResponse.json() as { error: string }).error, /超过 20MB/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('文件读取接口返回 PDF、Word、Excel 结构化预览并支持受保护子接口', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-document-routes-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const pdfPath = path.join(tempRoot, 'sample.pdf');
  const wordPath = path.join(tempRoot, 'sample.docx');
  const excelPath = path.join(tempRoot, 'sample.xlsx');
  fs.writeFileSync(pdfPath, await createPdfBuffer(51, true));
  fs.writeFileSync(wordPath, await createDocxBuffer({ paragraphs: ['标题', '正文'], savedPages: 2, includeImage: true, renderedPageBreakAfter: [1] }));
  fs.writeFileSync(excelPath, await createXlsxBuffer());

  const authorize = async (filePath: string) => {
    const response = await filesystemRouter.request('http://localhost/authorize-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { accessToken: string }).accessToken;
  };

  const pdfToken = await authorize(pdfPath);
  const pdfResponse = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(pdfPath)}&accessToken=${pdfToken}`);
  assert.equal(pdfResponse.status, 200);
  assert.deepEqual(await pdfResponse.json(), {
    type: 'pdf-document', totalPages: 51, displayedPages: 50, truncated: true, size: fs.statSync(pdfPath).size,
  });
  const pdfSource = await filesystemRouter.request(`http://localhost/preview-pdf-source?path=${encodeURIComponent(pdfPath)}&accessToken=${pdfToken}`);
  assert.equal(pdfSource.status, 200);
  assert.equal(pdfSource.headers.get('Content-Type'), 'application/pdf');
  assert.equal(pdfSource.headers.get('Cache-Control'), 'no-store');
  assert.equal((await PDFDocument.load(await pdfSource.arrayBuffer())).getPageCount(), 50);

  const wordToken = await authorize(wordPath);
  const wordResponse = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(wordPath)}&accessToken=${wordToken}`);
  const wordBody = await wordResponse.json() as { type: string; html: string };
  assert.equal(wordResponse.status, 200, JSON.stringify(wordBody));
  assert.equal(wordBody.type, 'word-document');
  assert.match(wordBody.html, /data:image\/png;base64/);

  const excelToken = await authorize(excelPath);
  const excelResponse = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(excelPath)}&accessToken=${excelToken}`);
  const excelBody = await excelResponse.json() as { type: string; sheets: Array<{ name: string }> };
  assert.equal(excelResponse.status, 200, JSON.stringify(excelBody));
  assert.equal(excelBody.type, 'spreadsheet');
  assert.deepEqual(excelBody.sheets.map((sheet) => sheet.name), ['数据', '隐藏']);

  const hiddenSheet = await filesystemRouter.request(`http://localhost/preview-spreadsheet-sheet?path=${encodeURIComponent(excelPath)}&accessToken=${excelToken}&sheet=${encodeURIComponent('隐藏')}`);
  assert.equal(hiddenSheet.status, 200);
  assert.equal((await hiddenSheet.json() as { sheet: { name: string } }).sheet.name, '隐藏');
});

test('旧 Office 格式明确提示下载查看', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-legacy-document-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const filePath = path.join(tempRoot, 'legacy.doc');
  fs.writeFileSync(filePath, 'legacy');
  const authorization = await filesystemRouter.request('http://localhost/authorize-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
  });
  const token = (await authorization.json() as { accessToken: string }).accessToken;
  const response = await filesystemRouter.request(`http://localhost/read?path=${encodeURIComponent(filePath)}&accessToken=${token}`);
  const body = await response.json() as { error: string; code: string };
  assert.equal(response.status, 400);
  assert.equal(body.code, 'DOCUMENT_FORMAT_UNSUPPORTED');
  assert.match(body.error, /下载后查看/);
});

test('文档 DTO 校验失败转换为稳定错误且不泄露派生内容', () => {
  const secretSheetName = '机密工作表名称不应该出现在错误响应中的超长内容';
  assert.throws(
    () => presentDocumentPreviewResult({ type: 'spreadsheet', sheets: [{ name: secretSheetName }] }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DOCUMENT_INVALID'
      && !error.message.includes(secretSheetName)
      && !error.message.includes('Zod'),
  );
  assert.throws(
    () => presentSpreadsheetSheetResult({ sheet: { name: secretSheetName } }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'DOCUMENT_INVALID'
      && !error.message.includes(secretSheetName)
      && !error.message.includes('Zod'),
  );
});

test('允许项目根目录及其子路径', () => {
  const root = path.resolve('G:\\AI\\relay');
  assert.equal(isPathInsideRoots(root, [root]), true);
  assert.equal(isPathInsideRoots(path.join(root, 'server', 'src', 'index.ts'), [root]), true);
});

test('拒绝相邻目录和使用 .. 逃逸项目根目录', () => {
  const root = path.resolve('G:\\AI\\relay');
  assert.equal(isPathInsideRoots(path.resolve(root, '..', 'secret.txt'), [root]), false);
  assert.equal(isPathInsideRoots(path.resolve('G:\\AI\\relay-other'), [root]), false);
});

test('目录名称只允许单级合法名称', () => {
  assert.equal(validateDirectoryName('新项目'), '新项目');
  assert.equal(validateDirectoryName('  demo  '), 'demo');

  for (const invalidName of ['', '.', '..', 'a/b', 'a\\b', 'CON', 'demo.']) {
    assert.throws(() => validateDirectoryName(invalidName));
  }
});

test('创建子目录后返回规范路径并拒绝重名', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-directory-'));

  try {
    const createdPath = createChildDirectory(tempRoot, '新项目');
    assert.equal(createdPath, fs.realpathSync(path.join(tempRoot, '新项目')));
    assert.equal(fs.statSync(createdPath).isDirectory(), true);
    assert.throws(() => createChildDirectory(tempRoot, '新项目'), /已存在/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('创建目录接口返回新目录路径', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-directory-route-'));

  try {
    const response = await filesystemRouter.request('http://localhost/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath: tempRoot, name: '接口创建' }),
    });
    const body = await response.json() as { path: string };

    assert.equal(response.status, 200);
    assert.equal(body.path, fs.realpathSync(path.join(tempRoot, '接口创建')));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('目录浏览接口返回子目录最后修改时间', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-directory-browse-'));
  try {
    fs.mkdirSync(path.join(tempRoot, 'folder'));
    const response = await filesystemRouter.request(`http://localhost/browse?path=${encodeURIComponent(tempRoot)}`);
    const body = await response.json() as { entries: Array<{ name: string; modifiedAt: number | null }> };

    assert.equal(response.status, 200);
    assert.equal(body.entries[0]?.name, 'folder');
    assert.equal(typeof body.entries[0]?.modifiedAt, 'number');
    assert.ok(Number.isFinite(body.entries[0]?.modifiedAt));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('目录浏览接口区分无法访问与空目录', async () => {
  const missing = path.join(os.tmpdir(), `relay-missing-directory-${Date.now()}`);
  const response = await filesystemRouter.request(`http://localhost/browse?path=${encodeURIComponent(missing)}`);
  assert.equal(response.status, 403);
  assert.match((await response.json() as { error: string }).error, /无法访问此目录/);
});

test('主机文件浏览返回目录优先并过滤点号隐藏项', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-files-'));
  try {
    fs.mkdirSync(path.join(tempRoot, 'folder'));
    fs.writeFileSync(path.join(tempRoot, 'b.txt'), 'bb');
    fs.writeFileSync(path.join(tempRoot, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tempRoot, '.secret'), 'hidden');
    assert.deepEqual(listHostFileEntries(tempRoot).map((entry) => [entry.name, entry.kind, entry.size]), [
      ['folder', 'directory', null],
      ['a.txt', 'file', 1],
      ['b.txt', 'file', 2],
    ]);
    assert.ok(listHostFileEntries(tempRoot).every((entry) => typeof entry.modifiedAt === 'number' && Number.isFinite(entry.modifiedAt)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('主机文件浏览过滤 Windows Hidden 属性名称', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-hidden-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'visible.txt'), 'visible');
    fs.writeFileSync(path.join(tempRoot, 'system.ini'), 'hidden');
    assert.deepEqual(
      listHostFileEntries(tempRoot, new Set(['system.ini'])).map((entry) => entry.name),
      ['visible.txt'],
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Windows attrib 输出只提取带 Hidden 标记的文件名', () => {
  const hidden = parseWindowsHiddenAttribOutput([
    'A   H                G:\\资料\\隐藏文件.txt',
    'A                    G:\\资料\\普通文件.txt',
    '    H                G:\\资料\\隐藏目录',
  ].join('\r\n'));
  assert.deepEqual([...hidden], ['隐藏文件.txt', '隐藏目录']);
});

test('Windows Hidden 属性读取区分超时与普通执行失败', () => {
  assert.throws(
    () => assertWindowsHiddenAttribSucceeded({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }),
    /读取 Windows 文件隐藏属性超时/,
  );
  assert.throws(
    () => assertWindowsHiddenAttribSucceeded({ status: 1 }),
    /无法读取 Windows 文件隐藏属性/,
  );
});

test('Windows 主机文件浏览真实过滤 Hidden 属性文件', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-hidden-attribute-'));
  const hiddenPath = path.join(tempRoot, '系统隐藏.txt');
  try {
    fs.writeFileSync(hiddenPath, 'hidden');
    const hiddenResult = spawnSync('attrib.exe', ['+H', hiddenPath], { windowsHide: true });
    assert.equal(hiddenResult.status, 0);
    assert.deepEqual(listHostFileEntries(tempRoot), []);
  } finally {
    spawnSync('attrib.exe', ['-H', hiddenPath], { windowsHide: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('主机文件浏览接口区分无法访问与空目录', async () => {
  const missing = path.join(os.tmpdir(), `relay-missing-${Date.now()}`);
  const response = await filesystemRouter.request(`http://localhost/browse-files?path=${encodeURIComponent(missing)}`);
  assert.equal(response.status, 403);
  assert.match((await response.json() as { error: string }).error, /无法访问此目录/);
});

test('批量主机文件授权解析真实路径并拒绝目录和重复文件', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-authorize-'));
  const filePath = path.join(tempRoot, 'report.txt');
  try {
    fs.writeFileSync(filePath, 'report');
    const response = await filesystemRouter.request('http://localhost/authorize-host-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [filePath] }),
    });
    const body = await response.json() as { attachments: Array<Record<string, unknown>> };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.attachments[0].path, fs.realpathSync(filePath));
    assert.equal(body.attachments[0].name, 'report.txt');
    assert.equal(body.attachments[0].size, 6);
    assert.equal(typeof body.attachments[0].accessToken, 'string');

    const directoryResponse = await filesystemRouter.request('http://localhost/authorize-host-files', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [tempRoot] }),
    });
    assert.equal(directoryResponse.status, 400);

    const duplicateResponse = await filesystemRouter.request('http://localhost/authorize-host-files', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [filePath, filePath] }),
    });
    assert.equal(duplicateResponse.status, 400);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('单文件授权令牌不能跨账号使用或撤销', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-file-owner-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const filePath = path.join(tempRoot, 'private.txt');
  fs.writeFileSync(filePath, 'private');
  const app = new Hono<RelayEnv>();
  app.use('*', async (c, next) => {
    c.set('relayActor', { userId: c.req.header('x-user') ?? 'member-a', role: 'member' });
    return next();
  });
  app.route('/', rawFilesystemRouter);
  const authorized = await app.request('/authorize-file', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'member-a' }, body: JSON.stringify({ path: filePath }),
  });
  const token = (await authorized.json() as { accessToken: string }).accessToken;

  assert.equal((await app.request(`/metadata?path=${encodeURIComponent(filePath)}&accessToken=${token}`, { headers: { 'x-user': 'member-b' } })).status, 403);
  await app.request('/revoke-file', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'member-b' }, body: JSON.stringify({ accessToken: token }) });
  assert.equal((await app.request(`/metadata?path=${encodeURIComponent(filePath)}&accessToken=${token}`, { headers: { 'x-user': 'member-a' } })).status, 200);
});
