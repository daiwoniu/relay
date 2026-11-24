export function mediaError(error: unknown): string {
  return error instanceof Error ? error.message : '处理失败，请检查文件后重试。';
}

export function outputName(name: string, extension: string) {
  const stem = name.trim().replace(/\.(?:jpe?g|png|webp|wav|mp4|webm|srt|vtt)$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '');
  return `${stem || '导出'}.${extension}`;
}

export function fileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function seekMedia(media: HTMLMediaElement, time: number, abort: AbortSignal) {
  if (abort.aborted) return Promise.reject(abort.reason);
  if (Math.abs(media.currentTime - time) < 0.005 && media.readyState >= 2 && !media.seeking) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('定位超时，请换一个时间点或文件。')), 10000);
    const seeked = () => finish();
    const cancelled = () => finish(abort.reason);
    const failed = () => finish(new Error('当前文件无法定位或解码。'));
    function finish(error?: unknown) {
      clearTimeout(timer);
      media.removeEventListener('seeked', seeked);
      media.removeEventListener('error', failed);
      abort.removeEventListener('abort', cancelled);
      if (error) reject(error);
      else resolve();
    }
    media.addEventListener('seeked', seeked, { once: true });
    media.addEventListener('error', failed, { once: true });
    abort.addEventListener('abort', cancelled, { once: true });
    try { media.currentTime = time; } catch (error) { finish(error); }
  });
}
