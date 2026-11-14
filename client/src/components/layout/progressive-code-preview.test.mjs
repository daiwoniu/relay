import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PREVIEW_CHUNK_CHARACTERS,
  startProgressiveTextPreview,
} from './progressive-code-preview.ts';

function createFrameScheduler() {
  let nextId = 1;
  const callbacks = new Map();
  const cancelled = [];
  return {
    scheduler: {
      request(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id) {
        cancelled.push(id);
        callbacks.delete(id);
      },
    },
    cancelled,
    runNext() {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, '应存在下一帧');
      const [id, callback] = entry;
      callbacks.delete(id);
      callback();
    },
    pendingCount() {
      return callbacks.size;
    },
  };
}

test('渐进预览每帧只追加一个定长块并最终保留完整内容', () => {
  const frames = createFrameScheduler();
  const chunks = [];
  const content = 'x'.repeat(PREVIEW_CHUNK_CHARACTERS * 2 + 7);

  startProgressiveTextPreview(content, (chunk) => chunks.push(chunk), frames.scheduler);
  assert.equal(frames.pendingCount(), 1);
  frames.runNext();
  assert.deepEqual(chunks.map((chunk) => chunk.length), [PREVIEW_CHUNK_CHARACTERS]);
  frames.runNext();
  frames.runNext();

  assert.equal(chunks.join(''), content);
  assert.equal(frames.pendingCount(), 0);
});

test('取消渐进预览会移除尚未执行的下一帧', () => {
  const frames = createFrameScheduler();
  const chunks = [];
  const cancel = startProgressiveTextPreview('x'.repeat(PREVIEW_CHUNK_CHARACTERS + 1), (chunk) => chunks.push(chunk), frames.scheduler);

  frames.runNext();
  assert.equal(frames.pendingCount(), 1);
  cancel();

  assert.equal(frames.pendingCount(), 0);
  assert.equal(frames.cancelled.length, 1);
  assert.equal(chunks.length, 1);
});
