import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessageCopyText } from './user-message-copy.ts';

const attachments = [
  { id: '1', kind: 'host_file', name: 'report.txt', path: 'G:\\report.txt', size: 10 },
  { id: '2', kind: 'host_file', name: 'screen.png', path: 'G:\\screen.png', size: 20 },
];

test('复制用户消息时保留正文并追加附件名称', () => {
  assert.equal(
    createUserMessageCopyText('请分析', attachments),
    '请分析\n\n附件：report.txt\n附件：screen.png',
  );
});

test('仅附件消息复制可读的附件列表', () => {
  assert.equal(
    createUserMessageCopyText('', attachments),
    '附件：report.txt\n附件：screen.png',
  );
});
