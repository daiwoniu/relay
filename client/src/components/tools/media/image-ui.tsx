import { useEffect, useRef, useState } from 'react';
import { ToolError } from '../tool-ui';
import { availableImageFormats, canvasBlob, imageAsset, renderDesign, type CanvasDesign, type ImageAsset, type ImageFormat } from './image-render';
import { outputName } from './media-files';
import { Choice, Details, Download, Field, FilePicker, JobStatus, NumberField, mediaButton, mediaInput, mediaPrimary, useMediaJob, type MediaResult } from './media-ui';

export function CanvasPreview({ design, label, white, onPlace }: {
  design: CanvasDesign; label: string; white?: boolean; onPlace?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    try {
      if (ref.current) renderDesign(ref.current, design, 1100, white ? '#ffffff' : undefined);
      setError('');
    } catch { setError('暂时无法绘制预览。'); }
  }, [design, white]);
  return <><canvas ref={ref} role="img" aria-label={label} className={onPlace ? 'cursor-crosshair' : undefined}
    onClick={onPlace ? (event) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      onPlace(Math.max(0, Math.min(99, Math.round((event.clientX - bounds.left) / bounds.width * 100))),
        Math.max(0, Math.min(99, Math.round((event.clientY - bounds.top) / bounds.height * 100))));
    } : undefined} /><ToolError message={error} /></>;
}

export function ImagePicker({ label, onImage, onImages, limit = 12 }: {
  label: string; onImage?: (image: ImageAsset) => void; onImages?: (images: ImageAsset[]) => void; limit?: number;
}) {
  const job = useMediaJob();
  return <><FilePicker label={label} accept="image/*" multiple={Boolean(onImages)} disabled={job.busy} onFiles={(files) => {
    void job.run(async (signal, progress) => {
      if (files.length > limit) throw new Error(`最多可以选 ${limit} 张图片。`);
      const images = [];
      let pixels = 0;
      for (const file of files) {
        const asset = await imageAsset(file);
        if (signal.aborted) return;
        pixels += asset.image.naturalWidth * asset.image.naturalHeight;
        if (images.length && pixels > 40_000_000) throw new Error('所选图片的总像素过多，请先缩小图片。');
        images.push(asset);
        progress(images.length / files.length);
      }
      if (onImages) onImages(images);
      else if (images[0]) onImage?.(images[0]);
    });
  }} /><JobStatus job={job} /></>;
}

function AssetThumbnail({ image }: { image: HTMLImageElement }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const scale = 64 / Math.max(image.naturalWidth, image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.drawImage(image, (64 - width) / 2, (64 - height) / 2, width, height);
  }, [image]);
  return <canvas ref={canvas} width={64} height={64} aria-hidden="true" className="media-asset-thumb" />;
}

export function AssetList({ assets, setAssets }: { assets: ImageAsset[]; setAssets: (assets: ImageAsset[]) => void }) {
  if (!assets.length) return null;
  function move(index: number, direction: number) {
    const result = [...assets];
    const target = index + direction;
    [result[index], result[target]] = [result[target]!, result[index]!];
    setAssets(result);
  }
  return <ol className="media-file-list" aria-label="图片顺序">{assets.map((item, index) => <li key={item.id}>
    <span className="media-asset-label"><AssetThumbnail image={item.image} />{index + 1}. {item.name}</span><div className="media-actions">
      <button className={mediaButton} type="button" aria-label={`上移 ${item.name}`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
      <button className={mediaButton} type="button" aria-label={`下移 ${item.name}`} disabled={index === assets.length - 1} onClick={() => move(index, 1)}>↓</button>
      <button className={mediaButton} type="button" aria-label={`移除 ${item.name}`} onClick={() => setAssets(assets.filter((asset) => asset.id !== item.id))}>移除</button>
    </div>
  </li>)}</ol>;
}

export function ImageExport({ design, defaultName, format: selectedFormat, setFormat }: {
  design: CanvasDesign | null; defaultName: string; format: ImageFormat; setFormat: (format: ImageFormat) => void;
}) {
  const [name, setName] = useState('');
  const [quality, setQuality] = useState(85);
  const formats = availableImageFormats();
  const format = formats.some(([value]) => value === selectedFormat) ? selectedFormat : 'image/png';
  const [result, setResult] = useState<{ output: MediaResult; design: CanvasDesign; format: ImageFormat; quality: number; name: string } | null>(null);
  const active = result?.design === design && result?.format === format && result?.quality === quality && result?.name === name ? result.output : null;
  const job = useMediaJob();
  const actualName = name || defaultName;
  return <>
    <div className="media-fields"><Choice label="保存成哪种图片" hint="照片和普通表单可选 JPG。想保留透明背景可选 PNG。WebP 通常能把文件做得更小。" options={formats} value={format} onChange={setFormat} />
      {format !== 'image/png' && <NumberField label="图片清晰度（质量 %）" hint="数字调小，文件通常更小，细节也可能变模糊。生成后可查看实际文件大小。" value={quality} min={1} onChange={setQuality} />}</div>
    <Details title="文件名"><Field label="输出文件名"><input className={mediaInput} value={name} placeholder={defaultName} maxLength={100} onChange={(event) => setName(event.target.value)} /></Field></Details>
    <button className={mediaPrimary} type="button" disabled={!design || job.busy} onClick={() => {
      if (!design) return;
      void job.run(async (signal) => {
        const canvas = document.createElement('canvas');
        try {
          renderDesign(canvas, design, undefined, format === 'image/jpeg' ? '#ffffff' : undefined);
          const blob = await canvasBlob(canvas, format, quality / 100);
          if (!signal.aborted) setResult({ output: {
            blob, name: outputName(actualName, format === 'image/jpeg' ? 'jpg' : format.split('/')[1]!),
            details: `${design.width} × ${design.height}`,
          }, design, format, quality, name });
        } finally { canvas.width = 0; canvas.height = 0; }
      }, 'generate_media');
    }}>生成图片</button>
    <JobStatus job={job} /><Download result={active} preview="image" stale={!!result && !active && !job.busy} />
  </>;
}
