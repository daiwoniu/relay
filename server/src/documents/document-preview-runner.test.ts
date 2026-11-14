import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDocumentPreviewTask } from './document-preview-runner.js';
import { createPdfBuffer } from './test-documents.js';

test('文档预览 Worker 返回 PDF 元数据并复验文件状态', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-document-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'sample.pdf');
  fs.writeFileSync(filePath, await createPdfBuffer(2));
  const realPath = fs.realpathSync(filePath);
  const stat = fs.statSync(realPath);
  const result = await runDocumentPreviewTask({
    kind: 'pdf-metadata',
    filePath: realPath,
    expectedSize: stat.size,
    expectedMtimeMs: stat.mtimeMs,
  });
  assert.ok('type' in result && result.type === 'pdf-document');
  if ('type' in result && result.type === 'pdf-document') assert.equal(result.totalPages, 2);
});
test('文档预览 Worker 拒绝已变化的文件', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-document-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'sample.pdf');
  fs.writeFileSync(filePath, await createPdfBuffer(1));
  const realPath = fs.realpathSync(filePath);
  const stat = fs.statSync(realPath);
  await assert.rejects(() => runDocumentPreviewTask({
    kind: 'pdf-metadata',
    filePath: realPath,
    expectedSize: stat.size + 1,
    expectedMtimeMs: stat.mtimeMs,
  }), { code: 'DOCUMENT_CHANGED' });
});

test('文档预览 Worker 超时后终止', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-document-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'sample.pdf');
  fs.writeFileSync(filePath, await createPdfBuffer(1));
  const realPath = fs.realpathSync(filePath);
  const stat = fs.statSync(realPath);
  await assert.rejects(() => runDocumentPreviewTask({
    kind: 'pdf-metadata',
    filePath: realPath,
    expectedSize: stat.size,
    expectedMtimeMs: stat.mtimeMs,
  }, 0), { code: 'DOCUMENT_TIMEOUT' });
});

test('旧 Worker 退出不会误伤超时后的新任务', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-document-worker-race-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'sample.pdf');
  fs.writeFileSync(filePath, await createPdfBuffer(1));
  const realPath = fs.realpathSync(filePath);
  const stat = fs.statSync(realPath);
  const task = {
    kind: 'pdf-metadata' as const,
    filePath: realPath,
    expectedSize: stat.size,
    expectedMtimeMs: stat.mtimeMs,
  };

  const timedOut = await Promise.allSettled([
    runDocumentPreviewTask(task, 0),
    runDocumentPreviewTask(task, 0),
  ]);
  assert.ok(timedOut.every((result) => result.status === 'rejected'
    && result.reason instanceof Error
    && 'code' in result.reason
    && result.reason.code === 'DOCUMENT_TIMEOUT'));

  const recovered = await Promise.all([
    runDocumentPreviewTask(task),
    runDocumentPreviewTask(task),
  ]);
  assert.ok(recovered.every((result) => 'type' in result && result.type === 'pdf-document'));
});
