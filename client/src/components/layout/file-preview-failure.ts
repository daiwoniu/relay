export function buildForceAccessFailureUpdate(error: unknown, accessToken?: string) {
  const detail = error instanceof Error ? error.message : '未知错误';
  return {
    isImage: false,
    imageUrl: undefined,
    language: undefined,
    documentPreview: undefined,
    compressedPreviewAvailable: false,
    content: accessToken ? detail : `强制访问失败：${detail}`,
    previewError: accessToken ? detail : `强制访问失败：${detail}`,
    loading: false,
    forceAccessAvailable: !accessToken,
    fileAccessToken: accessToken,
  };
}
