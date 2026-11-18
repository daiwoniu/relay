import test from 'node:test';
import assert from 'node:assert/strict';
import { getArchiveRows, formatArchiveRatio } from './archive-directory.ts';
const entry = (path, directory = false) => ({ path, directory, size: 100, compressedSize: 40, modifiedAt: 1000 });

test('directory navigation infers missing parents and only returns immediate children', () => {
  const entries = [entry('资料/deep/说明.txt'), entry('资料/other.txt'), entry('root.txt'), entry('empty', true)];
  const root = getArchiveRows(entries, '', '');
  assert.deepEqual(new Set(root.slice(0, 2).map(row => row.name)), new Set(['empty', '资料']));
  assert.ok(root.slice(0, 2).every(row => row.directory));
  assert.equal(root.at(-1).name, 'root.txt');
  assert.equal(root.find(row => row.name === '资料').size, null);
  assert.deepEqual(getArchiveRows(entries, '资料', '').map(row => row.name), ['deep', 'other.txt']);
  assert.deepEqual(getArchiveRows(entries, '资料/deep', '').map(row => row.name), ['说明.txt']);
  assert.deepEqual(getArchiveRows(entries, 'empty', ''), []);
});

test('search spans loaded paths, ignores current directory and treats text literally', () => {
  const entries = [entry('Docs/ReadMe.md'), entry('资料/说明.txt'), entry('<script>.txt')];
  assert.deepEqual(getArchiveRows(entries, '资料', ' readME ').map(row => row.name), ['Docs/ReadMe.md']);
  assert.equal(getArchiveRows(entries, '', '资料/').length, 1);
  assert.equal(getArchiveRows(entries, '', '.*').length, 0);
  assert.equal(getArchiveRows(entries, '', '<script>')[0].name, '<script>.txt');
});

test('compression savings handle empty and expanded stored data', () => {
  assert.equal(formatArchiveRatio(100, 40), '60.0%');
  assert.equal(formatArchiveRatio(0, 0), '—');
  assert.equal(formatArchiveRatio(10, 12), '-20.0%');
});
