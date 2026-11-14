import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getHostFileDraftKey,
  mergeHostFileDrafts,
  readHostFileDrafts,
  writeHostFileDrafts,
} from './host-file-drafts.ts';

function attachment(id, path, size = 1) {
  return { id, kind: 'host_file', name: path.split(/[\\/]/).pop(), path, size };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('主机附件草稿按聊天草稿键隔离并可安全持久化', () => {
  const storage = memoryStorage();
  const key = getHostFileDraftKey('relay:chat-draft:session%3A1');
  const attachments = [attachment('11111111-1111-4111-8111-111111111111', 'C:\\work\\a.txt')];
  writeHostFileDrafts(storage, key, attachments);
  assert.deepEqual(readHostFileDrafts(storage, key), attachments);
  writeHostFileDrafts(storage, key, []);
  assert.deepEqual(readHostFileDrafts(storage, key), []);
});

test('主机附件草稿过滤损坏数据并在 Windows 路径上忽略大小写重复', () => {
  const storage = memoryStorage();
  storage.setItem('broken', '{broken');
  assert.deepEqual(readHostFileDrafts(storage, 'broken'), []);
  const result = mergeHostFileDrafts(
    [attachment('11111111-1111-4111-8111-111111111111', 'C:\\Work\\A.txt')],
    [attachment('22222222-2222-4222-8222-222222222222', 'c:\\work\\a.txt')],
  );
  assert.equal(result.attachments.length, 1);
  assert.equal(result.duplicateCount, 1);
});

test('主机附件草稿严格限制每条消息最多 10 个', () => {
  const incoming = Array.from({ length: 12 }, (_, index) => attachment(
    `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    `C:\\work\\${index}.txt`,
  ));
  const result = mergeHostFileDrafts([], incoming);
  assert.equal(result.attachments.length, 10);
  assert.equal(result.overflowCount, 2);
});
