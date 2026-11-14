import { Worker } from 'node:worker_threads';
import { DOCUMENT_PREVIEW_TIMEOUT_MS } from './document-preview-limits.js';
import { DocumentPreviewError } from './document-preview-error.js';
import type {
  DocumentPreviewTask,
  DocumentPreviewTaskResult,
  DocumentPreviewWorkerMessage,
  DocumentPreviewWorkerRequest,
} from './document-preview-types.js';

const WORKER_COUNT = 2;
const MAX_QUEUED_DOCUMENT_TASKS = 8;

type PendingTask = {
  id: number;
  task: DocumentPreviewTask;
  timeoutMs: number;
  resolve: (result: DocumentPreviewTaskResult) => void;
  reject: (error: unknown) => void;
};

type WorkerSlot = {
  worker: Worker;
  current: PendingTask | null;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number | null;
};

let nextTaskId = 1;
const queue: PendingTask[] = [];
const slots: WorkerSlot[] = [];

function createWorker(): Worker {
  const worker = new Worker(new URL('./document-preview-worker.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
  });
  return worker;
}

function replaceWorker(slot: WorkerSlot): void {
  const previousWorker = slot.worker;
  const replacementWorker = createWorker();
  slot.worker = replacementWorker;
  bindWorker(slot, replacementWorker);
  replacementWorker.unref();
  void previousWorker.terminate();
}

function finishCurrent(slot: WorkerSlot, callback: (task: PendingTask) => void, shouldDispatch = true): void {
  const current = slot.current;
  if (!current) return;
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  slot.deadline = null;
  slot.current = null;
  callback(current);
  if (shouldDispatch) dispatch();
}

function timeoutCurrent(slot: WorkerSlot): void {
  if (!slot.current) return;
  finishCurrent(slot, (current) => current.reject(new DocumentPreviewError('DOCUMENT_TIMEOUT', '文档解析超时，请下载后查看')), false);
  replaceWorker(slot);
  dispatch();
}

function bindWorker(slot: WorkerSlot, worker: Worker): void {
  worker.on('message', (message: DocumentPreviewWorkerMessage) => {
    if (slot.worker !== worker) return;
    if (!slot.current || message.id !== slot.current.id) return;
    if (slot.deadline !== null && performance.now() >= slot.deadline) {
      timeoutCurrent(slot);
      return;
    }
    finishCurrent(slot, (current) => {
      if (message.ok) current.resolve(message.result);
      else current.reject(new DocumentPreviewError(message.code, message.message));
    });
  });
  worker.on('error', () => {
    if (slot.worker !== worker) return;
    finishCurrent(slot, (current) => current.reject(new DocumentPreviewError('DOCUMENT_INVALID', '文档解析进程异常，无法预览，请下载后查看')), false);
    replaceWorker(slot);
    dispatch();
  });
  worker.on('exit', (code) => {
    if (slot.worker !== worker) return;
    if (code === 0 || !slot.current) return;
    finishCurrent(slot, (current) => current.reject(new DocumentPreviewError('DOCUMENT_INVALID', '文档解析进程异常，无法预览，请下载后查看')), false);
    replaceWorker(slot);
    dispatch();
  });
}

function dispatch(): void {
  for (const slot of slots) {
    if (slot.current || queue.length === 0) continue;
    const pending = queue.shift();
    if (!pending) return;
    slot.current = pending;
    slot.deadline = performance.now() + pending.timeoutMs;
    slot.timer = setTimeout(() => {
      timeoutCurrent(slot);
    }, pending.timeoutMs);
    slot.timer.unref();
    slot.worker.postMessage({ id: pending.id, task: pending.task } satisfies DocumentPreviewWorkerRequest);
  }
}

for (let index = 0; index < WORKER_COUNT; index += 1) {
  const slot: WorkerSlot = { worker: createWorker(), current: null, timer: null, deadline: null };
  slots.push(slot);
  bindWorker(slot, slot.worker);
  slot.worker.unref();
}

export function runDocumentPreviewTask(
  task: DocumentPreviewTask,
  timeoutMs = DOCUMENT_PREVIEW_TIMEOUT_MS,
): Promise<DocumentPreviewTaskResult> {
  if (queue.length >= MAX_QUEUED_DOCUMENT_TASKS && slots.every((slot) => slot.current !== null)) {
    return Promise.reject(new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', '文档预览任务过多，请稍后重试'));
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: nextTaskId++, task, timeoutMs, resolve, reject });
    dispatch();
  });
}
