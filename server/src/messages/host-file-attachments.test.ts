import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileAccessGrants } from '../file-access.js';
import { composeCodexInput, validateHostFileAttachments } from './host-file-attachments.js';

test('主机附件以磁盘真实信息为权威并消费单文件授权', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-message-'));
  const filePath = path.join(tempRoot, 'actual.txt');
  try {
    fs.writeFileSync(filePath, 'hello');
    const realPath = fs.realpathSync(filePath);
    const accessToken = fileAccessGrants.grant(realPath);
    const [attachment] = validateHostFileAttachments([{
      id: randomUUID(), kind: 'host_file', name: 'fake.txt', path: filePath, size: 999, accessToken,
    }]);
    assert.equal(attachment.name, 'actual.txt');
    assert.equal(attachment.path, realPath);
    assert.equal(attachment.size, 5);
    assert.equal(fileAccessGrants.allows(realPath, accessToken), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('主机附件拒绝失效授权和重复真实路径', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-invalid-'));
  const filePath = path.join(tempRoot, 'same.txt');
  try {
    fs.writeFileSync(filePath, 'x');
    assert.throws(() => validateHostFileAttachments([{
      id: randomUUID(), kind: 'host_file', name: 'same.txt', path: filePath, size: 1, accessToken: randomUUID(),
    }]), /授权已失效/);
    const realPath = fs.realpathSync(filePath);
    const firstToken = fileAccessGrants.grant(realPath);
    const secondToken = fileAccessGrants.grant(realPath);
    assert.throws(() => validateHostFileAttachments([
      { id: randomUUID(), kind: 'host_file', name: 'same.txt', path: filePath, size: 1, accessToken: firstToken },
      { id: randomUUID(), kind: 'host_file', name: 'same.txt', path: filePath, size: 1, accessToken: secondToken },
    ]), /不能重复/);
    fileAccessGrants.revoke(firstToken);
    fileAccessGrants.revoke(secondToken);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('批次附件验证失败时撤销本批已签发令牌', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-revoke-failed-'));
  const firstPath = path.join(tempRoot, 'first.txt');
  try {
    fs.writeFileSync(firstPath, 'first');
    const realPath = fs.realpathSync(firstPath);
    const firstToken = fileAccessGrants.grant(realPath);
    const missingToken = randomUUID();

    assert.throws(() => validateHostFileAttachments([
      { id: randomUUID(), kind: 'host_file', name: 'first.txt', path: firstPath, size: 5, accessToken: firstToken },
      { id: randomUUID(), kind: 'host_file', name: 'missing.txt', path: path.join(tempRoot, 'missing.txt'), size: 0, accessToken: missingToken },
    ]), /不存在或不可访问/);
    assert.equal(fileAccessGrants.allows(realPath, firstToken), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Codex 输入保留用户正文并追加绝对路径，支持仅附件消息', () => {
  const attachments = [{ id: randomUUID(), kind: 'host_file' as const, name: 'a.txt', path: 'C:\\work\\a.txt', size: 1 }];
  assert.equal(composeCodexInput('请分析', attachments), '请分析\n\n附件文件（Relay 主机绝对路径）：\n- C:\\work\\a.txt');
  assert.equal(composeCodexInput('', attachments), '请查看以下附件文件（Relay 主机绝对路径）：\n- C:\\work\\a.txt');
});
