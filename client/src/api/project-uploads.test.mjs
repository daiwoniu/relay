import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./project-uploads.ts', import.meta.url), 'utf8');

test('设备文件使用 XHR 原始请求体并提供进度与取消能力', () => {
  assert.match(source, /new XMLHttpRequest\(\)/);
  assert.match(source, /request\.upload\.onprogress/);
  assert.match(source, /request\.send\(file\)/);
  assert.match(source, /abort: \(\) => request\.abort\(\)/);
  assert.match(source, /X-Relay-Upload-Id/);
  assert.match(source, /X-Relay-Message-Id/);
  assert.match(source, /X-Relay-File-Name/);
  assert.match(source, /X-Relay-File-Size/);
});

test('上传 API 处理认证失效和草稿清理', () => {
  assert.match(source, /request\.status === 401/);
  assert.match(source, /AUTH_REQUIRED_EVENT/);
  assert.match(source, /deleteUploadDraft/);
  assert.match(source, /clearProjectUploads/);
});
