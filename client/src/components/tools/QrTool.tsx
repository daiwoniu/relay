import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createQrSvg, QR_PNG_SIZES, QR_THEMES, qrPngLayout } from './qr-code';
import { ToolError, toolButton, toolInput } from './tool-ui';
import { QR_STICKERS, QR_STICKER_CATEGORIES, qrStickerSvg, type QrStickerId } from './qr-stickers';
import { readQrPreferences, serializeQrPreferences } from './qr-preferences';
import { isQrColor } from './qr-colors';
import QrColors, { QR_CONNECTED_BORDER, QrExpansionBridge } from './QrColors';

const pngLabels: Record<number, string> = {
  1024: '清晰',
  2048: '高清（推荐）',
  4096: '超清',
};

import { trackToolAction,captureToolAction } from '../../analytics/tracker';
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function QrTool({ storageKey }: { storageKey: string }) {
  const customId = useId();
  const [customOpen, setCustomOpen] = useState(false);
  const themeRowRef = useRef<HTMLDivElement>(null);
  const customButtonRef = useRef<HTMLButtonElement>(null);
  const [customEdges, setCustomEdges] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    if (!customOpen) return;
    const row = themeRowRef.current, button = customButtonRef.current;
    if (!row || !button) return;
    const measure = () => {
      const outer = row.getBoundingClientRect(), inner = button.getBoundingClientRect();
      const left = inner.left - outer.left <= 1, right = outer.right - inner.right <= 1;
      setCustomEdges((previous) => previous.left === left && previous.right === right ? previous : { left, right });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(row); observer.observe(button);
    return () => observer.disconnect();
  }, [customOpen]);
  const preferencesKey = `${storageKey}:qr-style`;
  const [initialStyle] = useState(() => {
    try { return readQrPreferences(localStorage.getItem(preferencesKey)); }
    catch { return readQrPreferences(null); }
  });
  const [rememberError, setRememberError] = useState(false);
  const [text, setText] = useState('');
  const [foreground, setForeground] = useState(initialStyle.foreground);
  const [background, setBackground] = useState(initialStyle.background);
  const [shape, setShape] = useState(initialStyle.shape);
  const [center, setCenter] = useState<'none' | 'image' | 'text' | 'sticker'>(initialStyle.center);
  const [stickerId, setStickerId] = useState<QrStickerId>(initialStyle.stickerId);
  const [stickerCategory, setStickerCategory] = useState<typeof QR_STICKER_CATEGORIES[number]>(() => QR_STICKERS.find((item) => item.id === initialStyle.stickerId)!.category);
  const [centerText, setCenterText] = useState('');
  const [centerImage, setCenterImage] = useState('');
  const [uploading, setUploading] = useState(false);
  const uploadVersion = useRef(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pngSize, setPngSize] = useState(initialStyle.pngSize);
  const isSample = !text.trim();
  const result = useMemo(() => {
    try { return { svg: createQrSvg(text.trim() ? text : 'Relay 二维码样例', { foreground, background, shape, centerText: center === 'text' ? centerText : '', centerImage: center === 'image' ? centerImage : '', centerSticker: center === 'sticker' ? stickerId : undefined }), error: '' }; }
    catch (error) { return { svg: '', error: error instanceof Error ? error.message : '二维码生成失败。' }; }
  }, [text, foreground, background, shape, center, centerText, centerImage, stickerId]);
  useEffect(() => {
    if (![foreground, background].every(isQrColor)) return;
    try {
      localStorage.setItem(preferencesKey, serializeQrPreferences({ foreground, background, shape, center, stickerId, pngSize }));
      setRememberError(false);
    } catch { setRememberError(true); }
  }, [preferencesKey, foreground, background, shape, center, stickerId, pngSize]);
  const { svg } = result;
  const url = useMemo(() => svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : '', [svg]);
  useEffect(() => () => { uploadVersion.current++; }, []);
  async function uploadIcon(file: File) {
    const version = ++uploadVersion.current;
    setError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('请选择 5 MB 以内的 PNG、JPG 或 WebP 图片。'); return;
    }
    setUploading(true);
    const source = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('无法读取这张图片，请换一张。')); image.src = source; });
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const context = canvas.getContext('2d'); if (!context) throw new Error('当前浏览器不支持处理图片。');
      const scale = Math.min(256 / image.naturalWidth, 256 / image.naturalHeight);
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
      context.drawImage(image, (256 - width) / 2, (256 - height) / 2, width, height);
      if (version === uploadVersion.current) setCenterImage(canvas.toDataURL('image/png'));
    } catch (error) { if (version === uploadVersion.current) setError(error instanceof Error ? error.message : '图标读取失败。'); }
    finally { URL.revokeObjectURL(source); if (version === uploadVersion.current) setUploading(false); }
  }
  async function savePng() {
    const report=captureToolAction('qr','export_png');
    setSaving(true);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('图片生成失败，请重试。')); image.src = url; });
      const layout = qrPngLayout(image.naturalWidth, pngSize);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = pngSize;
      const context = canvas.getContext('2d'); if (!context) throw new Error('当前浏览器不支持生成 PNG。');
      context.fillStyle = background;
      context.fillRect(0, 0, pngSize, pngSize);
      context.imageSmoothingEnabled = false;
      context.drawImage(image, layout.offset, layout.offset, layout.size, layout.size);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 导出失败。')), 'image/png'));
      download(blob, 'relay-qr.png'); setError('');report();
    } catch (error) { setError(error instanceof Error ? error.message : '导出失败，请重试。');report('error'); }
    finally { setSaving(false); }
  }
  function saveSvg(){
    try{download(new Blob([svg],{type:'image/svg+xml'}),'relay-qr.svg');trackToolAction('qr','export_svg');}
    catch{setError('导出失败，请重试。');trackToolAction('qr','export_svg','error');}
  }
  return <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)]"><div className="min-w-0 space-y-4"><label className="block space-y-2 text-sm"><span>文本或链接</span><textarea className={`${toolInput} min-h-28`} maxLength={1500} value={text} placeholder="输入文字或粘贴链接，自动生成" onChange={(event) => { setText(event.target.value); setError(''); }} enterKeyHint="done" /></label>
    <fieldset disabled={saving} className="space-y-3"><legend className="mb-2 text-sm">样式主题</legend>
      <div ref={themeRowRef} className="flex flex-wrap gap-2">{QR_THEMES.map((theme) => {
        const selected = foreground === theme.foreground && background === theme.background && shape === (theme.shape ?? 'square') && (theme.centerSticker ? center === 'sticker' && stickerId === theme.centerSticker : center === 'none');
        return <button key={theme.name} type="button" className={`${toolButton} ${selected ? 'ring-2 ring-[var(--color-primary)]' : ''}`} aria-pressed={selected} onClick={() => { setCustomOpen(false); setError(''); setForeground(theme.foreground); setBackground(theme.background); setShape(theme.shape ?? 'square'); setCenter(theme.centerSticker ? 'sticker' : 'none'); if (theme.centerSticker) { setStickerId(theme.centerSticker); setStickerCategory(QR_STICKERS.find((item) => item.id === theme.centerSticker)!.category); } }}><span aria-hidden="true" className="mr-2 inline-block h-3 w-3 rounded-full" style={{ background: theme.foreground }} />{theme.name}</button>;
      })}<button ref={customButtonRef} type="button" className={`${toolButton} relative ${customOpen ? 'z-[1]' : ''}`} style={customOpen ? { borderColor: QR_CONNECTED_BORDER, borderBottomColor: 'transparent', borderBottomLeftRadius: 0, borderBottomRightRadius: 0, background: 'var(--color-bg)' } : undefined} aria-expanded={customOpen} aria-controls={customId} onClick={() => setCustomOpen((open) => !open)}>自定义{customOpen && <QrExpansionBridge leftEdge={customEdges.left} rightEdge={customEdges.right} />}</button></div>
      {customOpen && <div id={customId} role="region" aria-label="二维码自定义配置" style={{ borderColor: QR_CONNECTED_BORDER, borderTopLeftRadius: customEdges.left ? 0 : undefined, borderTopRightRadius: customEdges.right ? 0 : undefined }} className="space-y-4 rounded-xl border bg-[var(--color-bg)] p-3 sm:p-4">
      <QrColors foreground={foreground} background={background} onForeground={setForeground} onBackground={setBackground} />
      <div className="flex flex-wrap items-center gap-3 text-sm"><span>形状</span><div className="flex gap-2" role="group" aria-label="二维码形状">{([{ value: 'square', label: '方块' }, { value: 'dots', label: '圆点' }] as const).map((option) => <button key={option.value} type="button" aria-pressed={shape === option.value} onClick={() => setShape(option.value)} className={`${toolButton} ${shape === option.value ? 'border-[var(--color-primary)] bg-[var(--color-bg-tertiary)] text-[var(--color-primary)]' : ''}`}>{option.label}</button>)}</div></div>
      <label className="flex flex-wrap items-center gap-2 text-sm">中心内容<select className={`${toolInput} !w-auto`} value={center} onChange={(event) => { setCenter(event.target.value as typeof center); setError(''); }}><option value="none">无</option><option value="sticker">预设图标</option><option value="image">上传图标</option><option value="text">文字</option></select></label>
      {center === 'sticker' && <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="图标分类">{QR_STICKER_CATEGORIES.map((category) => <button key={category} type="button" aria-pressed={stickerCategory === category} className={`min-h-10 rounded-lg px-3 py-2 text-sm transition-colors ${stickerCategory === category ? 'bg-[var(--color-bg-tertiary)] font-medium text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'}`} onClick={() => setStickerCategory(category)}>{category}</button>)}</div>
        <div className="grid grid-cols-4 gap-2" role="group" aria-label={`${stickerCategory}图标`}>{QR_STICKERS.filter((item) => item.category === stickerCategory).map((item) => <button key={item.id} type="button" aria-pressed={stickerId === item.id} aria-label={`选择${item.name}`} onClick={() => setStickerId(item.id)} className={`flex min-w-0 flex-col items-center gap-1 rounded-xl border p-2 transition-colors hover:bg-[var(--color-bg-tertiary)] ${stickerId === item.id ? 'border-[var(--color-primary)] bg-[var(--color-bg-tertiary)] ring-1 ring-[var(--color-primary)]' : 'border-[var(--color-border)]'}`}><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrStickerSvg(item.id))}`} alt="" className="h-10 w-10" /><span className="text-xs">{item.name}</span></button>)}</div>
      </div>}
      {center === 'text' && <input aria-label="中心文字" className={toolInput} value={centerText} onChange={(event) => setCenterText(Array.from(event.target.value).slice(0, 4).join(''))} placeholder="最多 4 个字" />}
      {center === 'image' && <label className="block space-y-2 text-sm"><span>{uploading ? '正在读取图标…' : '选择图标（PNG / JPG / WebP，最大 5 MB）'}</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadIcon(file); }} /></label>}
      <p className="text-xs text-[var(--color-text-secondary)]">{rememberError ? '当前浏览器无法记住样式，本次调整仍然有效。' : '自动记住样式，不保存二维码正文、文字内容或上传图片。'}</p>
      </div>}
    </fieldset>
    <ToolError message={result.error || error} />
    </div>
    <div className="min-w-0 space-y-4 rounded-2xl border border-[var(--color-border)] p-4 lg:sticky lg:top-4" aria-label="二维码实时预览">
      <p className="text-center text-sm font-medium">{isSample ? '样例二维码' : '二维码预览'}</p>
      {isSample && <p className="text-center text-xs text-[var(--color-text-secondary)]">扫码显示“Relay 二维码样例”；输入内容后即可下载。</p>}
      {url ? <img src={url} alt={isSample ? '样例二维码' : '生成的二维码'} className="mx-auto h-auto w-64 max-w-full rounded-xl bg-white" /> : <div className="mx-auto flex aspect-square w-64 max-w-full items-center justify-center rounded-xl bg-[var(--color-bg-tertiary)] px-4 text-center text-sm text-[var(--color-text-secondary)]">请调整配置以显示二维码</div>}
      <label className="mx-auto block max-w-sm space-y-2 text-sm"><span>PNG 清晰度</span><select className={toolInput} value={pngSize} disabled={saving} onChange={(event) => setPngSize(Number(event.target.value))}>{QR_PNG_SIZES.map((size) => <option key={size} value={size}>{pngLabels[size]} · {size} × {size}</option>)}</select></label>
      <p className="text-center text-xs text-[var(--color-text-secondary)]">默认高清适合分享与排版；SVG 可任意放大。</p>
      <div className="flex flex-wrap justify-center gap-2"><button type="button" className={toolButton} disabled={!url || isSample || saving || uploading} onClick={() => void savePng()}>{saving ? '正在导出…' : '下载 PNG'}</button><button type="button" className={toolButton} disabled={!url || isSample || saving || uploading} onClick={saveSvg}>下载 SVG</button></div></div>
  </div>;
}
