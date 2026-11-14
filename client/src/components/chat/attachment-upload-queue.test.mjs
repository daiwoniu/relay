import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttachmentUploadQueue } from './attachment-upload-queue.ts';
import { selectUploadFiles } from './attachment-drafts.ts';

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
