import assert from 'node:assert/strict';
import test from 'node:test';
import { FilePreviewRequestManager } from './file-preview-request-manager.ts';

test('同一标签重新加载会取消旧 generation', () => {
  const manager = new FilePreviewRequestManager();
  const first = manager.begin('tab-1');
  const second = manager.begin('tab-1');
  assert.equal(first.signal.aborted, true);
  assert.equal(manager.isCurrent('tab-1', first.generation), false);
  assert.equal(manager.isCurrent('tab-1', second.generation), true);
});

test('关闭标签释放令牌、Blob URL 与进行中请求', () => {
  const tokens = [];
  const urls = [];
  const manager = new FilePreviewRequestManager((token) => tokens.push(token), (url) => urls.push(url));
  const request = manager.begin('tab-1');
  assert.equal(manager.trackAccessToken('tab-1', request.generation, 'token-1'), true);
  assert.equal(manager.trackObjectUrl('tab-1', request.generation, 'blob:preview-1'), true);
  manager.dispose('tab-1');
  assert.equal(request.signal.aborted, true);
  assert.deepEqual(tokens, ['token-1']);
  assert.deepEqual(urls, ['blob:preview-1']);
});

test('旧 generation 不能登记新资源', () => {
  const manager = new FilePreviewRequestManager();
  const first = manager.begin('tab-1');
  manager.begin('tab-1');
  assert.equal(manager.trackAccessToken('tab-1', first.generation, 'stale-token'), false);
  assert.equal(manager.trackObjectUrl('tab-1', first.generation, 'blob:stale'), false);
});

test('标签 dispose 后复用仍提升 generation', () => {
  const manager = new FilePreviewRequestManager();
  const first = manager.begin('tab-1');
  manager.dispose('tab-1');
  const second = manager.begin('tab-1');
  assert.equal(second.generation, first.generation + 1);
  assert.equal(manager.isCurrent('tab-1', first.generation), false);
});
