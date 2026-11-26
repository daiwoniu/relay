import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFeishuReplyPreviewPath } from './feishu-reply-preview-path.ts';

test('Feishu reply file references resolve against the reply project', () => {
  assert.equal(resolveFeishuReplyPreviewPath('/D:/Work/out/file%20name.csv:12:3', 'd:\\work'), 'D:/Work/out/file name.csv');
  assert.equal(resolveFeishuReplyPreviewPath('out/report.csv', 'D:/work'), 'D:/work\\out\\report.csv');
  assert.equal(resolveFeishuReplyPreviewPath('file:///work/out/report.csv#preview', '/work'), '/work/out/report.csv');
});

test('Feishu reply previews require a permitted project and retain its boundary', () => {
  for (const value of ['../outside.csv', '/work-else/a.csv', '/work/../a.csv', '/work/%2e%2e/a.csv',
    'https://example.com/a.csv', 'javascript:run.csv', 'file://another-host/work/a.csv']) {
    assert.equal(resolveFeishuReplyPreviewPath(value, '/work'), undefined, value);
  }
  assert.equal(resolveFeishuReplyPreviewPath('/work/a.csv'), undefined);
});
