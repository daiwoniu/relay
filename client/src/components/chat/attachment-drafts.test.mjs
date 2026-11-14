import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAttachmentDraftKey,
  hasUnreadyAttachments,
  mergeHostAttachmentDrafts,
  readAttachmentDrafts,
  selectUploadFiles,
  writeAttachmentDrafts,
} from './attachment-drafts.ts';
import { newestAttachmentsFirst } from './attachment-display-order.ts';
import {
  getHostFileDirectoryKey,
  readHostFileDirectory,
  rememberHostFileDirectory,
} from './host-file-directory-memory.ts';

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('附件草稿只持久化主机与已上传 ready 状态', () => {
  const storage = memoryStorage();
  const key = getAttachmentDraftKey('chat');
  writeAttachmentDrafts(storage, key, [
    { id: '1', kind: 'host_file', name: 'a.txt', path: 'C:\\a.txt', size: 1, status: 'ready' },
    { id: '2', kind: 'uploaded_file', messageId: 'm', uploadId: 'u', projectId: 'p', name: 'b.jpg', path: 'C:\\b.jpg', size: 2, mimeType: 'image/jpeg', status: 'ready', previewUrl: 'blob:x' },
    { id: '3', kind: 'uploaded_file', messageId: 'm', uploadId: 'u2', name: 'c.jpg', size: 3, mimeType: 'image/jpeg', status: 'failed', progress: 0, file: {} },
  ]);
  const restored = readAttachmentDrafts(storage, key);
  assert.equal(restored.length, 2);
  assert.equal(restored.every((entry) => entry.status === 'ready'), true);
  assert.equal(JSON.stringify(restored).includes('blob:x'), false);
});

test('附件总数、单文件 50MB、消息上传 200MB 和重复选择均受限', () => {
  const files = [
    { name: 'large.bin', size: 51 * 1024 * 1024 },
    { name: 'ok.bin', size: 40 * 1024 * 1024 },
    { name: 'ok.bin', size: 40 * 1024 * 1024 },
  ];
  const result = selectUploadFiles([], files);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejectedLarge, 1);
  assert.equal(result.rejectedDuplicate, 1);
  assert.equal(hasUnreadyAttachments([{ id: 'x', kind: 'uploaded_file', messageId: 'm', uploadId: 'u', name: 'x', size: 1, mimeType: 'x', status: 'uploading', progress: 1, file: {} }]), true);
});

test('主机附件与上传附件共用 10 个总上限', () => {
  const current = Array.from({ length: 9 }, (_, index) => ({ id: String(index), kind: 'uploaded_file', messageId: 'm', uploadId: `u${index}`, projectId: 'p', name: `${index}.txt`, path: `${index}`, size: 1, mimeType: 'text/plain', status: 'ready' }));
  const merged = mergeHostAttachmentDrafts(current, [
    { id: 'h1', kind: 'host_file', name: 'a', path: 'C:\\a', size: 1 },
    { id: 'h2', kind: 'host_file', name: 'b', path: 'C:\\b', size: 1 },
  ]);
  assert.equal(merged.attachments.length, 10);
  assert.equal(merged.overflowCount, 1);
});

test('附件展示按最新在左、最早在右排序且不修改发送顺序', () => {
  const attachments = [{ id: 'oldest' }, { id: 'middle' }, { id: 'newest' }];
  assert.deepEqual(newestAttachmentsFirst(attachments).map((entry) => entry.id), ['newest', 'middle', 'oldest']);
  assert.deepEqual(attachments.map((entry) => entry.id), ['oldest', 'middle', 'newest']);
});

test('主机文件目录按会话草稿隔离并只记住成功进入的具体目录', () => {
  const storage = memoryStorage();
  const firstKey = getHostFileDirectoryKey('relay:chat-draft:session:first');
  const secondKey = getHostFileDirectoryKey('relay:chat-draft:session:second');
  rememberHostFileDirectory(storage, firstKey, 'C:\\Users\\demo\\docs');
  rememberHostFileDirectory(storage, secondKey, '/workspace/files');
  rememberHostFileDirectory(storage, firstKey, '');
  assert.equal(readHostFileDirectory(storage, firstKey), 'C:\\Users\\demo\\docs');
  assert.equal(readHostFileDirectory(storage, secondKey), '/workspace/files');
});
