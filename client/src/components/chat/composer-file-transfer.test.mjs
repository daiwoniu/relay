import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTransferredFiles, hasTransferredFiles } from './composer-file-transfer.ts';

test('文件传输优先读取 items，避免和 files 中的同一文件重复', () => {
  const file = { name: 'report.txt' };
  const result = extractTransferredFiles({
    files: [file],
    items: [{ kind: 'file', getAsFile: () => file }],
  });
  assert.deepEqual(result, [file]);
});

test('拖入目录时不会把目录伪装成零字节文件上传', () => {
  const result = extractTransferredFiles({
    files: [{ name: 'folder', size: 0 }],
    items: [{
      kind: 'file',
      getAsFile: () => ({ name: 'folder', size: 0 }),
      webkitGetAsEntry: () => ({ isFile: false }),
    }],
  });
  assert.deepEqual(result, []);
});

test('截图粘贴可从 clipboard items 读取图片文件', () => {
  const screenshot = { name: 'image.png', type: 'image/png' };
  const result = extractTransferredFiles({
    files: [],
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => screenshot },
    ],
  });
  assert.deepEqual(result, [screenshot]);
});

test('拖拽阶段可通过类型或文件 item 识别附件载荷', () => {
  assert.equal(hasTransferredFiles({ types: ['Files'], items: [] }), true);
  assert.equal(hasTransferredFiles({ types: [], items: [{ kind: 'file' }] }), true);
  assert.equal(hasTransferredFiles({ types: ['text/plain'], items: [{ kind: 'string' }] }), false);
});
