import assert from 'node:assert/strict';
import test from 'node:test';
import { FilePreviewRequestManager } from './file-preview-request-manager.ts';
import { completePreviewOperation, currentPreviewOperationTab } from './preview-operation-state.ts';

test('refresh invalidates a compression/authorization busy marker immediately, even before its promise settles', () => {
  const manager = new FilePreviewRequestManager();
  const first = manager.begin('a');
  const busy = { a: first.generation };
  const current = (id, generation) => manager.isCurrent(id, generation);
  assert.equal(currentPreviewOperationTab(busy, 'a', current), 'a');
  manager.begin('a', { retainAccessToken: true });
  assert.equal(currentPreviewOperationTab(busy, 'a', current), null);
  assert.deepEqual(completePreviewOperation(busy, 'a', first.generation), {});
});

test('late completion cannot clear a newer operation or operations on other files', () => {
  const busy = { a: 3, b: 1 };
  assert.equal(completePreviewOperation(busy, 'a', 2), busy);
  assert.deepEqual(completePreviewOperation(busy, 'a', 3), { b: 1 });
  assert.deepEqual(busy, { a: 3, b: 1 });
  assert.deepEqual(completePreviewOperation(busy, 'b'), { a: 3 });
});

test('closed files and inactive files cannot appear busy; each tab keeps its own operation', () => {
  const manager = new FilePreviewRequestManager();
  const a = manager.begin('a');
  const b = manager.begin('b');
  const busy = { a: a.generation, b: b.generation };
  const current = (id, generation) => manager.isCurrent(id, generation);
  assert.equal(currentPreviewOperationTab(busy, 'a', current), 'a');
  assert.equal(currentPreviewOperationTab(busy, 'b', current), 'b');
  assert.equal(currentPreviewOperationTab(busy, null, current), null);
  manager.dispose('a');
  assert.equal(currentPreviewOperationTab(busy, 'a', current), null);
  assert.equal(currentPreviewOperationTab(busy, 'b', current), 'b');
});
