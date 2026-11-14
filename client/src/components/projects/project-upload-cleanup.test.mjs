import assert from 'node:assert/strict';
import test from 'node:test';
import { getProjectUploadCleanupStats } from './project-upload-cleanup.ts';

const files = [
  { id: 'available-a', size: 100, available: true },
  { id: 'missing-b', size: 240, available: false },
  { id: 'available-c', size: 60, available: true },
];

test('全部清理只把真实可用文件计入可释放空间', () => {
  assert.deepEqual(getProjectUploadCleanupStats(files), {
    recordCount: 3,
    availableCount: 2,
    unavailableCount: 1,
    releasableBytes: 160,
  });
});

test('选中清理保留记录数量但排除已清理文件的历史大小', () => {
  assert.deepEqual(getProjectUploadCleanupStats(files, new Set(['available-a', 'missing-b'])), {
    recordCount: 2,
    availableCount: 1,
    unavailableCount: 1,
    releasableBytes: 100,
  });
});

test('空选择不会报告可释放空间', () => {
  assert.deepEqual(getProjectUploadCleanupStats(files, new Set()), {
    recordCount: 0,
    availableCount: 0,
    unavailableCount: 0,
    releasableBytes: 0,
  });
});
