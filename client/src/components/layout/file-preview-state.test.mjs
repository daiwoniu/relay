import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForceAccessFailureUpdate } from './file-preview-failure.ts';

test('临时授权成功但预览失败时保留令牌并切换为下载状态', () => {
  assert.deepEqual(buildForceAccessFailureUpdate(new Error('请下载后查看'), 'access-token'), {
    isImage: false,
    imageUrl: undefined,
    language: undefined,
    documentPreview: undefined,
    mediaPreview: undefined,
    compressedPreviewAvailable: false,
    content: '请下载后查看',
    previewError: '请下载后查看',
    loading: false,
    forceAccessAvailable: false,
    fileAccessToken: 'access-token',
  });
});

test('授权本身失败时保留强制访问入口', () => {
  assert.deepEqual(buildForceAccessFailureUpdate(new Error('没有权限')), {
    isImage: false,
    imageUrl: undefined,
    language: undefined,
    documentPreview: undefined,
    mediaPreview: undefined,
    compressedPreviewAvailable: false,
    content: '强制访问失败：没有权限',
    previewError: '强制访问失败：没有权限',
    loading: false,
    forceAccessAvailable: true,
    fileAccessToken: undefined,
  });
});
