import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForceAccessFailureUpdate, filePreviewFailureReason } from './file-preview-failure.ts';
import { ApiError } from '../../api/client.ts';

test('预览失败只上报结构化原因，对话正文、文件路径和原始错误不进入原因码',()=>{
  assert.equal(filePreviewFailureReason(new ApiError(403,{error:'PRIVATE_SENTINEL',code:'PATH_NOT_ALLOWED'})),'PERMISSION_DENIED');
  assert.equal(filePreviewFailureReason(new ApiError(404,{error:'PRIVATE_SENTINEL'})),'NOT_FOUND');
  assert.equal(filePreviewFailureReason(new ApiError(400,{error:'PRIVATE_SENTINEL',code:'FILE_PREVIEW_TOO_LARGE'})),'LIMIT_REACHED');
  assert.equal(filePreviewFailureReason(new ApiError(408,{error:'PRIVATE_SENTINEL',code:'DOCUMENT_TIMEOUT'})),'TIMEOUT');
  assert.equal(filePreviewFailureReason(new ApiError(400,{error:'PRIVATE_SENTINEL',code:'DOCUMENT_INVALID'})),'DOCUMENT_INVALID');
  assert.equal(filePreviewFailureReason(new Error('PRIVATE_SENTINEL')),'LOAD_FAILED');
});

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
