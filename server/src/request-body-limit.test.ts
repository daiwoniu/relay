import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_API_REQUEST_BODY_LIMIT, getApiRequestBodyLimit, PROJECT_UPLOAD_REQUEST_BODY_LIMIT, THEME_ASSET_REQUEST_BODY_LIMIT } from './request-body-limit.js';

test('自定义主题上传允许两个 4 MiB 衍生文件且不放宽其他接口', () => {
  assert.ok(THEME_ASSET_REQUEST_BODY_LIMIT > 8 * 1024 * 1024);
  assert.equal(getApiRequestBodyLimit('POST', '/api/auth/theme-assets'), THEME_ASSET_REQUEST_BODY_LIMIT);
  assert.equal(getApiRequestBodyLimit('PUT', '/api/auth/theme-settings'), DEFAULT_API_REQUEST_BODY_LIMIT);
  assert.equal(getApiRequestBodyLimit('POST', '/api/filesystem/read'), DEFAULT_API_REQUEST_BODY_LIMIT);
});

test('仅设备上传 POST 端点放宽到单文件上限', () => {
  assert.ok(PROJECT_UPLOAD_REQUEST_BODY_LIMIT > 50 * 1024 * 1024);
  assert.equal(getApiRequestBodyLimit('POST', '/api/projects/11111111-1111-4111-8111-111111111111/uploads'), PROJECT_UPLOAD_REQUEST_BODY_LIMIT);
  assert.equal(getApiRequestBodyLimit('GET', '/api/projects/11111111-1111-4111-8111-111111111111/uploads'), DEFAULT_API_REQUEST_BODY_LIMIT);
  assert.equal(getApiRequestBodyLimit('POST', '/api/projects/not-an-id/uploads/extra'), DEFAULT_API_REQUEST_BODY_LIMIT);
});
