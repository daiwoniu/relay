import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AttachmentProbe } from './attachment-probe.js';
import { fixture } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';
import { StorageWorkerClient } from './worker-client.js';

const principal = { kind: 'user' as const, userId: 'owner', authSessionHash: 'auth-owner' };
const sessionId = '22222222-2222-4222-8222-222222222222';
const page = { principal, sessionId, limit: 50, before: null, knownRevision: null };
function preparedFixture() {
  const f = fixture();
  f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,status,message_revision,engine,engine_bound) VALUES('${sessionId}','owner','project','idle',2,'codex',1);
    UPDATE messages SET session_id='${sessionId}'`);
  return f;
}
function attachment(filename: string) {
  return { kind: 'uploaded_file', id: '33333333-3333-4333-8333-333333333333', name: 'test.txt', path: filename,
    mimeType: 'text/plain', size: 5, available: true };
}
function setAttachment(f: ReturnType<typeof fixture>, filename: string) {
  const metadata = JSON.stringify({ attachments: [attachment(filename)] }).replaceAll("'", "''");
  f.mutate(`UPDATE messages SET metadata='${metadata}' WHERE id='m2'`);
}
test('file probes preserve regular/missing/directory semantics, deduplicate and stay off the main thread', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-probes-')), probe = new AttachmentProbe();
  const filename = path.join(directory, 'file.txt'); fs.writeFileSync(filename, 'hello');
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try {
    assert.deepEqual(await probe.check([filename, filename, directory, path.join(directory, 'absent')]),
      [[filename, true], [directory, false], [path.join(directory, 'absent'), false]]);
    assert.ok(ticks > 0); assert.equal(fs.readFileSync(filename, 'utf8'), 'hello');
  } finally { clearInterval(timer); await probe.dispose(); fs.rmSync(directory, { recursive: true }); }
});
test('probe admission, deadline and shutdown are bounded; timeouts do not become false availability', async () => {
  const probe = new AttachmentProbe(1);
  try {
    await assert.rejects(probe.check(Array(4097).fill('file')), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(probe.check(['bad\0path']), { code: 'INVALID_ARGUMENT' });
    const jobs = Promise.allSettled([probe.check(['missing-a']), probe.check(['missing-b'])]);
    await assert.rejects(probe.check(['missing-c']), { code: 'OVERLOADED' });
    assert.ok((await jobs).every((result) => result.status === 'rejected' && result.reason.code === 'STORAGE_UNAVAILABLE'));
  } finally { await probe.dispose(); }
  await assert.rejects(probe.check([]), { code: 'STORAGE_UNAVAILABLE' });
});
test('database preparation never stats files; completion checks fresh authorization and rejects new unprobed paths', () => {
  const f = preparedFixture(); setAttachment(f, path.join(os.tmpdir(), 'synthetic-probe-file'));
  const store = new NativeStore(f.filename, 'store', 1, true), original = fs.lstatSync;
  try {
    fs.lstatSync = (() => { throw new Error('DB_THREAD_FILE_IO'); }) as typeof fs.lstatSync;
    const prepared = store.prepareMessageRead({ type: 'readMessagePage', request: page });
    assert.equal(prepared.value, null); assert.equal(prepared.paths.length, 1);
    const input = { type: 'readMessagePage', request: page, availability: [[prepared.paths[0], true]] };
    const result = store.completeMessageRead(input) as any;
    assert.equal(result.page.messages.find((m: any) => m.id === 'm2').attachments[0].available, true);
    setAttachment(f, path.join(os.tmpdir(), 'another-synthetic-probe-file'));
    assert.throws(() => store.completeMessageRead(input), { code: 'CONFLICT' });
    f.mutate("DELETE FROM auth_sessions WHERE token_hash='auth-owner'");
    assert.throws(() => store.completeMessageRead(input), { code: 'FORBIDDEN' });
  } finally { fs.lstatSync = original; store.close(); f.cleanup(); }
});
test('actual Worker reads keep required availability booleans in page and offset DTOs', async () => {
  const f = preparedFixture(), filename = path.join(path.dirname(f.filename), 'file.txt'); fs.writeFileSync(filename, 'hello'); setAttachment(f, filename);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const result = await port.readMessagePage(page); assert.equal(result.unchanged, false);
    if (!result.unchanged) assert.equal(result.page.messages.find((m) => m.id === 'm2')?.attachments?.[0].kind === 'uploaded_file'
      && (result.page.messages.find((m) => m.id === 'm2')?.attachments?.[0] as any).available, true);
    fs.unlinkSync(filename);
    const offset = await port.readMessagesOffset({ principal, sessionId, limit: 50, offset: 0, includeDetails: true });
    assert.equal((offset.find((m) => m.id === 'm2')?.attachments?.[0] as any).available, false);
  } finally { await port.close(); f.cleanup(); }
});
test('waiting on file I/O leaves the DB queue usable and final response cannot cross revoked auth', async () => {
  const f = preparedFixture(); setAttachment(f, path.join(os.tmpdir(), 'synthetic-probe-file'));
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  (port as any).attachmentProbe.check = async (paths: string[]) => { entered(); await gate; return paths.map((filename) => [filename, true]); };
  try {
    const outcome = port.readMessagePage(page).then((value) => ({ value }), (error) => ({ error }));
    await Promise.race([started, outcome.then(() => { throw new Error('Read settled before file probe'); })]);
    assert.equal((await port.readPublicUser({ principal, userId: 'owner' }))?.id, 'owner');
    f.mutate("DELETE FROM auth_sessions WHERE token_hash='auth-owner'"); release();
    const result = await outcome; assert.ok('error' in result); assert.equal(result.error.code, 'FORBIDDEN');
  } finally { release(); await port.close(); f.cleanup(); }
});
