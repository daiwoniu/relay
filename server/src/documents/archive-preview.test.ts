import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { parseArchivePreview } from './archive-preview.js';

async function archive(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('ZIP lists Chinese paths, directories, sizes and times without inflating payloads', async () => {
  const buffer = await archive({ '资料/说明.txt': '中文说明'.repeat(100), 'nested.zip': 'opaque', 'empty.txt': '' });
  // Damage the first file payload: metadata should still work because content/CRC is never read.
  const local = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
  const payload = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  buffer[payload] ^= 0xff;
  const result = await parseArchivePreview(buffer);
  assert.equal(result.type, 'archive');
  assert.equal(result.totalFiles, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.size, buffer.length);
  assert.equal(result.entries.find(entry => entry.path === '资料')?.directory, true);
  const file = result.entries.find(entry => entry.path === '资料/说明.txt');
  assert.equal(file?.size, Buffer.byteLength('中文说明'.repeat(100)));
  assert.ok(file!.compressedSize < file!.size);
  assert.ok(file!.modifiedAt! > 0);
  assert.equal(result.totalSize, Buffer.byteLength('中文说明'.repeat(100)) + 6);
});

test('empty ZIP returns an empty directory', async () => {
  const result = await parseArchivePreview(await archive({}));
  assert.equal(result.totalEntries, 0);
  assert.equal(result.totalFiles, 0);
  assert.deepEqual(result.entries, []);
});

test('compressed empty files retain their central-directory compressed size', async () => {
  const source = await archive({ 'empty.txt': '' });
  const central = source.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  // A valid raw-DEFLATE empty stream occupies two bytes.
  const buffer = Buffer.concat([source.subarray(0, central), Buffer.from([3, 0]), source.subarray(central)]);
  const nextCentral = central + 2;
  buffer.writeUInt16LE(8, 8); buffer.writeUInt32LE(2, 18);
  buffer.writeUInt16LE(8, nextCentral + 10); buffer.writeUInt32LE(2, nextCentral + 20);
  buffer.writeUInt32LE(nextCentral, buffer.length - 22 + 16);
  const result = await parseArchivePreview(buffer);
  assert.equal(result.entries[0].compressedSize, 2);
  assert.equal(result.totalCompressedSize, 2);
});

test('directory listing uses central filenames rather than local extraction filenames', async () => {
  const buffer = await archive({ 'central.txt': 'content' });
  Buffer.from('altered.txt').copy(buffer, 30);
  assert.equal((await parseArchivePreview(buffer)).entries[0].path, 'central.txt');
});

test('legacy Chinese filenames decode without a UTF-8 flag', async () => {
  const buffer = await archive({ 'aaaa.txt': 'one' });
  const name = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74]);
  name.copy(buffer, 30);
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  name.copy(buffer, central + 46);
  assert.equal((await parseArchivePreview(buffer)).entries[0].path, '中文.txt');
});

test('Unicode filename extras are used only when their raw-name CRC matches', async () => {
  const zip = new JSZip(); zip.file('中文.txt', 'one');
  const buffer = await zip.generateAsync({ type: 'nodebuffer', encodeFileName: name => name.replace(/[^\x00-\x7f]/g, '_') });
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.equal(buffer.readUInt16LE(central + 8) & 0x800, 0);
  assert.equal((await parseArchivePreview(buffer)).entries[0].path, '中文.txt');
  const extra = central + 46 + buffer.readUInt16LE(central + 28);
  buffer.writeUInt32LE(0, extra + 5);
  assert.equal((await parseArchivePreview(buffer)).entries[0].path, '__.txt');
});

test('uncompressed sizes are unsigned metadata, invalid timestamps are omitted', async () => {
  const buffer = await archive({ 'large.dat': 'metadata only' });
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buffer.writeUInt32LE(0x80000000, central + 24);
  buffer.writeUInt16LE(0, central + 14);
  const result = await parseArchivePreview(buffer);
  assert.equal(result.totalSize, 2147483648);
  assert.equal(result.entries[0].size, 2147483648);
  assert.equal(result.entries[0].modifiedAt, null);
});

test('comments do not change listing, malformed extra fields and payload ranges are rejected', async () => {
  const zip = new JSZip(); zip.file('a.txt', 'a');
  assert.equal((await parseArchivePreview(await zip.generateAsync({ type: 'nodebuffer', comment: 'a normal ZIP comment' }))).totalFiles, 1);
  const buffer = await archive({ '中文.txt': 'one' });
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const extra = central + 46 + buffer.readUInt16LE(central + 28);
  const malformed = Buffer.from(buffer); malformed.writeUInt16LE(0xffff, extra + 2);
  await assert.rejects(parseArchivePreview(malformed), /ZIP 目录损坏/);
  const overlapping = Buffer.from(buffer); overlapping.writeUInt32LE(central, central + 42);
  await assert.rejects(parseArchivePreview(overlapping), /ZIP 目录损坏/);
});

test('streamed ZIP entries with data descriptors retain central sizes', async () => {
  const zip = new JSZip(); zip.file('stream.txt', 'content'.repeat(100));
  const result = await parseArchivePreview(await zip.generateAsync({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }));
  assert.equal(result.entries[0].size, 700);
  assert.ok(result.entries[0].compressedSize > 0);
});

test('path output budget truncates long names before the entry count limit', async () => {
  const files = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`${'中'.repeat(990)}${index}.txt`, 'x']));
  const result = await parseArchivePreview(await archive(files));
  assert.equal(result.totalEntries, 200);
  assert.equal(result.totalSize, 200);
  assert.ok(result.entries.length < 200);
  assert.ok(result.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.path), 0) <= 512 * 1024);
  assert.equal(result.truncated, true);
});

test('display prefix is bounded but totals cover the complete directory', async () => {
  const files = Object.fromEntries(Array.from({ length: 1002 }, (_, index) => [`file-${index}.txt`, '123']));
  const result = await parseArchivePreview(await archive(files));
  assert.equal(result.entries.length, 1000);
  assert.equal(result.totalEntries, 1002);
  assert.equal(result.totalFiles, 1002);
  assert.equal(result.totalSize, 3006);
  assert.equal(result.truncated, true);
});

test('damaged, encrypted, ZIP64 and oversized directories fail with clear errors', async () => {
  const source = await archive({ 'one.txt': 'one' });
  await assert.rejects(parseArchivePreview(Buffer.from('invalid')), /ZIP 目录损坏/);
  const encrypted = Buffer.from(source);
  encrypted.writeUInt16LE(1, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
  await assert.rejects(parseArchivePreview(encrypted), /已加密/);
  const zip64 = Buffer.from(source); zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 12);
  await assert.rejects(parseArchivePreview(zip64), /ZIP64/);
  const excessive = Buffer.from(source);
  excessive.writeUInt16LE(5001, excessive.length - 22 + 8);
  excessive.writeUInt16LE(5001, excessive.length - 22 + 10);
  await assert.rejects(parseArchivePreview(excessive), /5000/);
  const damaged = Buffer.from(source); damaged.writeUInt32LE(0, damaged.length - 22 + 16);
  await assert.rejects(parseArchivePreview(damaged), /ZIP 目录损坏/);
});

test('unsafe and conflicting normalized paths are rejected rather than interpreted as host paths', async () => {
  await assert.rejects(parseArchivePreview(await archive({ '../outside.txt': 'no' })), /路径/);
  const directories = new JSZip(); directories.folder('../outside');
  await assert.rejects(parseArchivePreview(await directories.generateAsync({ type: 'nodebuffer' })), /路径/);
  await assert.rejects(parseArchivePreview(await archive({ 'a\\b.txt': 'one', 'a/b.txt': 'two' })), /冲突路径/);
  await assert.rejects(parseArchivePreview(await archive({ ['x/'.repeat(33) + 'file.txt']: 'deep' })), /路径/);
});
