import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import PreviewState from './PreviewState';

const ORIGINAL_SCALE = 1;
const MAX_FIT_MULTIPLIER = 8;
const ZOOM_STEP = 1.25;
const SLIDER_MAX = 100;
const FRAME_PADDING = 16;

type Point = { x: number; y: number };

function maxImageScale(fit: number) {
  return Math.max(ORIGINAL_SCALE, fit * MAX_FIT_MULTIPLIER);
}

function applyImageScale(image: HTMLImageElement, scale: number) {
  image.style.setProperty('--preview-image-width', `${image.naturalWidth * scale}px`);
  image.style.setProperty('--preview-image-height', `${image.naturalHeight * scale}px`);
}

export default function ImageFilePreview({ src, title }: { src: string; title: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<(Point & { pointerId: number }) | null>(null);
  const selectedScale = useRef<number | null>(null);
  const [{ fitScale, scale }, setZoom] = useState({ fitScale: 0, scale: 0 });
  const [failed, setFailed] = useState(false);
  const maxScale = maxImageScale(fitScale);
  const sliderFactor = fitScale > 0 ? Math.log(maxScale / fitScale) : 0;
  const sliderValue = fitScale > 0 ? Math.round(Math.log(scale / fitScale) / sliderFactor * SLIDER_MAX) : 0;
  const percentage = `${Number((scale * 100).toPrecision(3))}%`;

  function fitImage() {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image || !image.naturalWidth || !image.naturalHeight) return;
    const width = Math.max(0, viewport.offsetWidth - FRAME_PADDING * 2);
    const height = Math.max(0, viewport.offsetHeight - FRAME_PADDING * 2);
    const fit = Math.min(ORIGINAL_SCALE, width / image.naturalWidth, height / image.naturalHeight);
    const nextScale = fit > 0 ? Math.max(fit, Math.min(maxImageScale(fit), selectedScale.current ?? fit)) : 0;
    applyImageScale(image, nextScale);
    setZoom((current) => current.fitScale === fit && current.scale === nextScale ? current : { fitScale: fit, scale: nextScale });
  }

  function zoomFromCenter(requestedScale: number | null) {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image || fitScale <= 0) return;
    selectedScale.current = requestedScale === null ? null : Math.min(maxScale, Math.max(fitScale, requestedScale));
    const nextScale = selectedScale.current ?? fitScale;
    if (nextScale === scale) return;
    const before = image.getBoundingClientRect();
    const { left, top } = viewport.getBoundingClientRect();
    const centerX = left + viewport.clientWidth / 2;
    const centerY = top + viewport.clientHeight / 2;
    applyImageScale(image, nextScale);
    setZoom({ fitScale, scale: nextScale });
    if (!before.width || !before.height) return;
    const anchorX = (centerX - before.left) / before.width;
    const anchorY = (centerY - before.top) / before.height;
    const after = image.getBoundingClientRect();
    viewport.scrollBy(after.left + anchorX * after.width - left - viewport.clientWidth / 2,
      after.top + anchorY * after.height - top - viewport.clientHeight / 2);
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) return;
    selectedScale.current = null;
    image.style.removeProperty('--preview-image-width');
    image.style.removeProperty('--preview-image-height');
    viewport.scrollTo(0, 0);
    drag.current = null;
    setZoom({ fitScale: 0, scale: 0 });
    setFailed(false);
    if (image.complete) fitImage();

    const observer = new ResizeObserver(fitImage);
    observer.observe(viewport, { box: 'border-box' });
    return () => observer.disconnect();
  }, [src]);

  function startPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse' || event.button !== 0 || scale <= fitScale) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    const previous = drag.current;
    if (previous?.pointerId !== event.pointerId) return;
    viewportRef.current?.scrollBy(previous.x - event.clientX, previous.y - event.clientY);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return (
    <div className="workspace-image-preview">
      {fitScale > 0 && !failed && (
        <div className="workspace-image-preview__controls" role="group" aria-label="图片缩放">
          <button type="button" aria-label="缩小" title="缩小" disabled={scale <= fitScale}
            onClick={() => zoomFromCenter(scale / ZOOM_STEP > fitScale ? scale / ZOOM_STEP : null)}>−</button>
          <input type="range" min={0} max={SLIDER_MAX} value={sliderValue}
            aria-label="图片缩放比例" aria-valuetext={percentage}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (value === SLIDER_MAX) zoomFromCenter(maxScale);
              else if (value === 0) zoomFromCenter(null);
              else zoomFromCenter(fitScale * Math.exp(sliderFactor * value / SLIDER_MAX));
            }} />
          <button type="button" aria-label="放大" title="放大" disabled={scale >= maxScale}
            onClick={() => zoomFromCenter(scale * ZOOM_STEP)}>+</button>
          <span className="workspace-image-preview__percentage" aria-hidden="true">{percentage}</span>
          <div className="workspace-image-preview__presets">
            <button type="button" aria-label="适应窗口" title="适应窗口" onClick={() => zoomFromCenter(null)}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3H3v3m11-3h3v3M3 14v3h3m11-3v3h-3" />
                <rect x="6" y="7" width="8" height="6" rx="1" />
              </svg>
            </button>
            <button type="button" aria-label="原始大小" title="原始大小" onClick={() => zoomFromCenter(ORIGINAL_SCALE)}>1:1</button>
          </div>
        </div>
      )}
      <div ref={viewportRef} className="workspace-image-preview__viewport workspace-preview-viewport" tabIndex={failed ? undefined : 0}
        aria-label="图片查看区" role="region" data-zoomed={scale > fitScale}>
        <div className="workspace-image-preview__stage" style={{ padding: FRAME_PADDING }} hidden={failed}
          onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer}
          onPointerCancel={endPointer} onLostPointerCapture={endPointer}>
          <img ref={imageRef} src={src} alt={title} draggable={false} onLoad={fitImage} onError={() => setFailed(true)} />
        </div>
        {failed && <PreviewState tone="danger" title="图片加载失败" description="文件可能已移动、损坏或当前格式无法显示。" />}
      </div>
    </div>
  );
}
