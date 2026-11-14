export const PREVIEW_CHUNK_CHARACTERS = 32 * 1024;

export interface PreviewFrameScheduler {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
}

export function startProgressiveTextPreview(
  content: string,
  appendChunk: (chunk: string) => void,
  scheduler: PreviewFrameScheduler,
): () => void {
  let offset = 0;
  let frameId: number | null = null;
  let cancelled = false;

  const appendNextChunk = () => {
    frameId = null;
    if (cancelled) return;
    const nextOffset = Math.min(offset + PREVIEW_CHUNK_CHARACTERS, content.length);
    appendChunk(content.slice(offset, nextOffset));
    offset = nextOffset;
    if (offset < content.length) frameId = scheduler.request(appendNextChunk);
  };

  frameId = scheduler.request(appendNextChunk);
  return () => {
    cancelled = true;
    if (frameId !== null) scheduler.cancel(frameId);
  };
}
