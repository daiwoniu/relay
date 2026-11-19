import { useEffect, useRef, useState } from 'react';
import { featureAction } from '../../analytics/features';
import { tracker } from '../../analytics/tracker';
import { generateUUID } from '../../utils/uuid';
import type { RightPanelTab } from '../../stores/chat';
import PreviewState from './PreviewState';

export default function MediaFilePreview({ media, title, downloading, onDownload }: {
  media: NonNullable<RightPanelTab['mediaPreview']>;
  title: string;
  downloading?: boolean;
  onDownload: () => void;
}) {
  const player = useRef<HTMLMediaElement | null>(null);
  const disposing=useRef(false);
  const telemetryError=()=>{if(disposing.current)return;try{tracker.result({feature:'file_preview',action:'media_error',surface:'preview_content',operationId:generateUUID(),result:'error',fileKind:media.kind,reasonCode:'LOAD_FAILED'});}catch{/* Metrics must not affect playback. */}};
  const playback={onPlay:()=>{if(!disposing.current)featureAction('file_preview','play','preview_content');},onPause:()=>{if(!disposing.current&&!player.current?.ended)featureAction('file_preview','pause','preview_content');},onEnded:()=>{if(!disposing.current)featureAction('file_preview','ended','preview_content');}};
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    disposing.current=false;
    const element = player.current;
    if (element) element.src = media.previewUrl;
    return () => {
      disposing.current=true;
      if (!element) return;
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [media.previewUrl]);

  return (
    <div className="flex min-h-full min-w-0 flex-col items-center justify-center gap-4 p-4">
      {failed ? (
        <PreviewState tone="warning" title="无法播放此文件" description="当前浏览器可能不支持此格式或编码，或文件已损坏。可下载后使用本机播放器打开。"
          action={<button type="button" className="workspace-preview-state__button" disabled={downloading} onClick={onDownload}>{downloading ? '下载中…' : '下载文件'}</button>} />
      ) : media.kind === 'video' ? (
        <video {...playback} ref={element => { player.current = element; }} src={media.previewUrl} controls playsInline preload="metadata" aria-label={`视频：${title}`} className="w-full max-h-[70vh] rounded-lg bg-black" onError={() => {telemetryError();setFailed(true);}} />
      ) : (
        <audio {...playback} ref={element => { player.current = element; }} src={media.previewUrl} controls preload="metadata" aria-label={`音频：${title}`} className="w-full max-w-xl" onError={() => {telemetryError();setFailed(true);}} />
      )}
      <p className="text-center text-xs text-[var(--color-text-secondary)]">音视频需加载完整文件，大小上限跟随预览容量设置；播放兼容性取决于浏览器支持的格式与编码。</p>
    </div>
  );
}
