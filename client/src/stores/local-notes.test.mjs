import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_NOTES_LIMIT,
  LOCAL_NOTE_MAX_LENGTH,
  addLocalNote,
  appendNoteToDraft,
  deleteLocalNote,
  pruneEmptyLocalNotes,
  readStoredLocalNotes,
  restoreDeletedLocalNote,
  updateLocalNoteContent,
  writeStoredLocalNotes,
} from './local-notes.ts';

function createStorage(initialValue = null) {
  const values = new Map();
  if (initialValue !== null) values.set('relay.local-notes.v1', initialValue);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('安全读取版本化便签并忽略损坏、空白和超量数据', () => {
  const validNotes = Array.from({ length: 12 }, (_, index) => ({
    id: `note-${index}`,
    content: index === 1 ? '   ' : String(index).repeat(600),
    createdAt: 100 + index,
    updatedAt: 200 + index,
  }));
  const storage = createStorage(JSON.stringify({ version: 1, notes: validNotes }));
  const notes = readStoredLocalNotes(storage);

  assert.equal(notes.length, LOCAL_NOTES_LIMIT);
  assert.equal(notes.some((note) => note.id === 'note-1'), false);
  assert.equal(notes[0].content.length, LOCAL_NOTE_MAX_LENGTH);
  assert.deepEqual(readStoredLocalNotes(createStorage('{bad json')), []);
  assert.deepEqual(readStoredLocalNotes(createStorage(JSON.stringify({ version: 2, notes: validNotes }))), []);
});

test('新增便签遵守最多十条限制并固定放在列表顶部', () => {
  const first = addLocalNote([], 'note-a', 100);
  assert.deepEqual(first, [{ id: 'note-a', content: '', createdAt: 100, updatedAt: 100 }]);

  const full = Array.from({ length: LOCAL_NOTES_LIMIT }, (_, index) => ({
    id: `note-${index}`,
    content: `${index}`,
    createdAt: index,
    updatedAt: index,
  }));
  assert.equal(addLocalNote(full, 'overflow', 999), full);
});

test('编辑内容实时限制为五百字且不改变原列表顺序', () => {
  const notes = [
    { id: 'a', content: 'A', createdAt: 1, updatedAt: 1 },
    { id: 'b', content: 'B', createdAt: 2, updatedAt: 2 },
  ];
  const updated = updateLocalNoteContent(notes, 'b', '新'.repeat(600), 10);

  assert.deepEqual(updated.map((note) => note.id), ['a', 'b']);
  assert.equal(updated[1].content.length, LOCAL_NOTE_MAX_LENGTH);
  assert.equal(updated[1].updatedAt, 10);
});

test('删除后可以恢复原位置，空白便签可统一清理', () => {
  const notes = [
    { id: 'a', content: 'A', createdAt: 1, updatedAt: 1 },
    { id: 'b', content: 'B', createdAt: 2, updatedAt: 2 },
    { id: 'c', content: ' ', createdAt: 3, updatedAt: 3 },
  ];
  const deleted = deleteLocalNote(notes, 'b');

  assert.deepEqual(deleted.notes.map((note) => note.id), ['a', 'c']);
  assert.deepEqual(restoreDeletedLocalNote(deleted.notes, deleted.deleted).map((note) => note.id), ['a', 'b', 'c']);
  assert.deepEqual(pruneEmptyLocalNotes(notes).map((note) => note.id), ['a', 'b']);
});

test('便签内容按空行追加到当前输入草稿且不自动改变空内容', () => {
  assert.equal(appendNoteToDraft('', '  临时想法  '), '临时想法');
  assert.equal(appendNoteToDraft('已有问题', '临时想法'), '已有问题\n\n临时想法');
  assert.equal(appendNoteToDraft('已有问题', '   '), '已有问题');
});

test('写入 localStorage 返回明确成功或失败结果', () => {
  const storage = createStorage();
  const notes = [{ id: 'a', content: '内容', createdAt: 1, updatedAt: 1 }];

  assert.equal(writeStoredLocalNotes(notes, storage), true);
  assert.deepEqual(JSON.parse(storage.values.get('relay.local-notes.v1')), { version: 1, notes });
  assert.equal(writeStoredLocalNotes(notes, { getItem: () => null, setItem: () => { throw new Error('quota'); } }), false);
});
