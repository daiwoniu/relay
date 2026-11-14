import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_DOCUMENT_PREVIEW_SIZE } from './document-preview-limits.js';
import { DocumentPreviewError, normalizeDocumentPreviewError } from './document-preview-error.js';
import type { DocumentPreviewTask, DocumentPreviewTaskResult, DocumentPreviewWorkerMessage, DocumentPreviewWorkerRequest } from './document-preview-types.js';
import { createPdfPreview, inspectPdf } from './pdf-preview.js';
import { parseSpreadsheetPreview } from './spreadsheet-preview.js';
import { parseWordPreview } from './word-preview.js';

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function readStableFile(task: DocumentPreviewTask): Buffer {
  const beforeRealPath = fs.realpathSync(task.filePath);
  const beforeLstat = fs.lstatSync(task.filePath);
  const beforeStat = fs.statSync(beforeRealPath);
  if (beforeLstat.isSymbolicLink() || !beforeStat.isFile() || comparablePath(beforeRealPath) !== comparablePath(task.filePath)) {
    throw new DocumentPreviewError('DOCUMENT_CHANGED', '文件在预览期间发生变化，请重新打开');
  }
  if (beforeStat.size !== task.expectedSize || beforeStat.mtimeMs !== task.expectedMtimeMs) {
    throw new DocumentPreviewError('DOCUMENT_CHANGED', '文件在预览期间发生变化，请重新打开');
  }
  if (beforeStat.size > MAX_DOCUMENT_PREVIEW_SIZE) {
    throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', '文档超过 3 MB 预览上限，请下载后查看');
  }
  const buffer = fs.readFileSync(beforeRealPath);
  const afterRealPath = fs.realpathSync(task.filePath);
  const afterStat = fs.statSync(afterRealPath);
  if (
    comparablePath(afterRealPath) !== comparablePath(beforeRealPath)
    || afterStat.size !== beforeStat.size
    || afterStat.mtimeMs !== beforeStat.mtimeMs
  ) {
    throw new DocumentPreviewError('DOCUMENT_CHANGED', '文件在预览期间发生变化，请重新打开');
  }
  return buffer;
}

async function execute(task: DocumentPreviewTask): Promise<DocumentPreviewTaskResult> {
  const buffer = readStableFile(task);
  if (task.kind === 'pdf-metadata') return { ...(await inspectPdf(buffer)), size: buffer.length };
  if (task.kind === 'pdf-source') return { type: 'pdf-source', ...(await createPdfPreview(buffer)) };
  if (task.kind === 'word') return { ...(await parseWordPreview(buffer)), size: buffer.length };
  const preview = await parseSpreadsheetPreview(buffer, task.sheetName);
  return 'type' in preview ? { ...preview, size: buffer.length } : preview;
}

const port = parentPort;
if (!port) throw new Error('文档预览 Worker 缺少父线程');

port.on('message', (request: DocumentPreviewWorkerRequest) => {
  void execute(request.task).then(
    (result) => port.postMessage({ id: request.id, ok: true, result } satisfies DocumentPreviewWorkerMessage),
    (error) => {
      const normalized = normalizeDocumentPreviewError(error);
      port.postMessage({ id: request.id, ok: false, code: normalized.code, message: normalized.message } satisfies DocumentPreviewWorkerMessage);
    },
  );
});
