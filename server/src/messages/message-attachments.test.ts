import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { v4 as uuid } from 'uuid';
import { ProjectUploadStore } from '../uploads/project-uploads.js';
import { fileAccessGrants } from '../file-access.js';
import { composeMessageCodexInput, prepareMessageAttachments } from './message-attachments.js';

async function* body(value: Buffer) { yield value; }

test('设备上传附件归档后统一加入 Codex 绝对路径输入', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-upload-'));
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const messageId = uuid();
    const draft = await store.writeUpload({
      projectId, projectPath: root, userId, messageId, uploadId: uuid(), name: 'note.txt', mimeType: 'text/plain',
      declaredSize: 4, body: body(Buffer.from('test')),
    });
    const prepared = prepareMessageAttachments({ attachments: [draft], projectId, projectPath: root, userId, messageId, uploadStore: store });
    assert.equal(prepared.attachments[0].kind, 'uploaded_file');
    assert.match(prepared.codexInput('请分析'), /^请分析\n\n附件文件（Relay 主机绝对路径）：\n- /);
    assert.equal(prepared.codexInput('').includes(prepared.attachments[0].path), true);
    prepared.rollback();
    assert.equal(fs.existsSync(draft.path), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('统一 Codex 输入保留附件顺序', () => {
  const result = composeMessageCodexInput('', [
    { id: uuid(), kind: 'host_file', name: 'a', path: 'C:\\a', size: 1 },
    { id: uuid(), kind: 'uploaded_file', name: 'b', path: 'C:\\b', size: 1, mimeType: 'text/plain', available: true },
  ]);
  assert.match(result, /C:\\a\n- C:\\b$/);
});

test('混合附件验证和归档后仍保留用户选择顺序', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-message-order-'));
  try {
    const hostPath = path.join(root, 'host.txt');
    fs.writeFileSync(hostPath, 'host');
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const messageId = uuid();
    const uploaded = await store.writeUpload({
      projectId, projectPath: root, userId, messageId, uploadId: uuid(), name: 'upload.txt', mimeType: 'text/plain',
      declaredSize: 6, body: body(Buffer.from('upload')),
    });
    const accessToken = fileAccessGrants.grant(fs.realpathSync(hostPath));
    const host = { id: uuid(), kind: 'host_file' as const, name: 'host.txt', path: hostPath, size: 4, accessToken };
    const prepared = prepareMessageAttachments({ attachments: [uploaded, host], projectId, projectPath: root, userId, messageId, uploadStore: store });
    assert.deepEqual(prepared.attachments.map((attachment) => attachment.kind), ['uploaded_file', 'host_file']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
