import {ApiError} from '../../api/client.ts';
import type {AnalyticsFeatureProperties} from '../../../../server/src/analytics/registry';

export function filePreviewFailureReason(error:unknown):NonNullable<AnalyticsFeatureProperties['reasonCode']>{
  if(!(error instanceof ApiError))return 'LOAD_FAILED';
  switch(error.data?.code){
    case 'FILE_PREVIEW_TOO_LARGE': case 'IMAGE_PREVIEW_TOO_LARGE': case 'DOCUMENT_LIMIT_EXCEEDED': return 'LIMIT_REACHED';
    case 'FILE_PREVIEW_UNSUPPORTED': case 'DOCUMENT_FORMAT_UNSUPPORTED': return 'UNSUPPORTED';
    case 'DOCUMENT_TIMEOUT': return 'TIMEOUT';
    case 'DOCUMENT_INVALID': return 'DOCUMENT_INVALID';
    case 'DOCUMENT_ENCRYPTED': return 'DOCUMENT_ENCRYPTED';
    case 'DOCUMENT_CHANGED': return 'DOCUMENT_CHANGED';
  }
  switch(error.status){
    case 0: return 'NETWORK_ERROR';
    case 401: case 403: return 'PERMISSION_DENIED';
    case 404: return 'NOT_FOUND';
    case 408: case 504: return 'TIMEOUT';
    case 429: return 'RATE_LIMITED';
    case 503: return 'UNAVAILABLE';
    default: return 'LOAD_FAILED';
  }
}

export function buildForceAccessFailureUpdate(error: unknown, accessToken?: string) {
  const detail = error instanceof Error ? error.message : '未知错误';
  return {
    isImage: false,
    imageUrl: undefined,
    language: undefined,
    documentPreview: undefined,
    mediaPreview: undefined,
    compressedPreviewAvailable: false,
    content: accessToken ? detail : `强制访问失败：${detail}`,
    previewError: accessToken ? detail : `强制访问失败：${detail}`,
    loading: false,
    forceAccessAvailable: !accessToken,
    fileAccessToken: accessToken,
  };
}
