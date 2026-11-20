import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttachmentTransferQueue, createAttachmentUploadQueue } from './attachment-upload-queue.ts';
import { selectUploadFiles } from './attachment-drafts.ts';

test('多文件与重试共用实际传输队列，等待响应结束才启动下一请求', async () => {
  const queue = createAttachmentTransferQueue();
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = queue.enqueue(() => ({ promise: (async () => {
    events.push('first'); await gate; throw new Error('upload failed');
  })(), abort() {} }));
  const failed = assert.rejects(first.promise, /upload failed/);
  const second = queue.enqueue(() => { events.push('second'); return { promise: Promise.resolve('second'), abort() {} }; });
  const retry = queue.enqueue(() => { events.push('retry'); return { promise: Promise.resolve('retry'), abort() {} }; });
  await Promise.resolve();
  assert.deepEqual(events, ['first']);
  release();
  await failed;
  assert.deepEqual(await Promise.all([second.promise, retry.promise]), ['second', 'retry']);
  assert.deepEqual(events, ['first', 'second', 'retry']);
});

test('取消排队文件不会发起请求，取消正在上传的文件会中止请求并释放队列', async () => {
  const queue = createAttachmentTransferQueue();
  let abortActive, started = 0;
  const first = queue.enqueue(() => ({
    promise: new Promise((_, reject) => { abortActive = () => reject(new DOMException('cancel', 'AbortError')); }),
    abort: () => abortActive(),
  }));
  const cancelled = queue.enqueue(() => { started++; throw new Error('cancelled request started'); });
  const firstRejected = assert.rejects(first.promise, { name: 'AbortError' });
  const cancelledRejected = assert.rejects(cancelled.promise, { name: 'AbortError' });
  const last = queue.enqueue(() => { started++; return { promise: Promise.resolve('done'), abort() {} }; });
  await Promise.resolve();
  cancelled.abort(); first.abort();
  await Promise.all([firstRejected, cancelledRejected]);
  assert.equal(await last.promise, 'done');
  assert.equal(started, 1);
});

test('附件批次严格串行，后一批只在前一批完成后开始', async () => {
  const queue = createAttachmentUploadQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.enqueue(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
  });
  const second = queue.enqueue(async () => { events.push('second:start'); });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('前一批失败不会阻塞后续附件批次', async () => {
  const queue = createAttachmentUploadQueue();
  const first = queue.enqueue(async () => { throw new Error('failed'); });
  const second = queue.enqueue(async () => 'continued');

  await assert.rejects(first, /failed/);
  assert.equal(await second, 'continued');
});

test('连续批次基于前批最新快照判限，不会突破十个附件', async () => {
  const queue = createAttachmentUploadQueue();
  let current = [];
  const admit = async (prefix) => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      name: `${prefix}-${index}.txt`, size: 1,
    }));
    const selected = selectUploadFiles(current, files);
    current = [...current, ...selected.accepted.map((file) => ({
      kind: 'uploaded_file', status: 'uploading', name: file.name, size: file.size,
    }))];
    return selected;
  };

  const [first, second] = await Promise.all([
    queue.enqueue(() => admit('first')),
    queue.enqueue(() => admit('second')),
  ]);
  assert.equal(first.accepted.length, 8);
  assert.equal(second.accepted.length, 2);
  assert.equal(second.rejectedOverflow, 6);
  assert.equal(current.length, 10);
});
