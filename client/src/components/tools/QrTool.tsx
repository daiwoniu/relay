import { useEffect, useState } from 'react';
import { createQrSvg } from './qr-code';
import { ToolError, toolButton, toolInput } from './tool-ui';

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function QrTool() {
  const [text, setText] = useState('');
  const [svg, setSvg] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!svg) { setUrl(''); return; }
    const next = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setUrl(next); return () => URL.revokeObjectURL(next);
  }, [svg]);
  async function savePng() {
    setSaving(true);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('图片生成失败，请重试。')); image.src = url; });
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = image.naturalWidth;
      const context = canvas.getContext('2d'); if (!context) throw new Error('当前浏览器不支持生成 PNG。');
      context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 导出失败。')), 'image/png'));
      download(blob, 'relay-qr.png'); setError('');
    } catch (error) { setError(error instanceof Error ? error.message : '导出失败，请重试。'); }
    finally { setSaving(false); }
  }
  return <div className="space-y-4"><label className="block space-y-2 text-sm"><span>文本或链接</span><textarea className={`${toolInput} min-h-28`} maxLength={1500} value={text} placeholder="输入文字或粘贴链接" onChange={(event) => { setText(event.target.value); setSvg(''); setError(''); }}  enterKeyHint="done" /></label>
    <button type="button" className={toolButton} onClick={() => { try { setSvg(createQrSvg(text)); setError(''); } catch (error) { setSvg(''); setError(error instanceof Error ? error.message : '二维码生成失败。'); } }}>生成二维码</button><ToolError message={error} />
    {url && <div className="space-y-4"><img src={url} alt="生成的二维码" className="mx-auto h-auto w-64 max-w-full rounded-xl bg-white" /><div className="flex flex-wrap justify-center gap-2"><button type="button" className={toolButton} disabled={saving} onClick={() => void savePng()}>{saving ? '正在导出…' : '下载 PNG'}</button><button type="button" className={toolButton} onClick={() => download(new Blob([svg], { type: 'image/svg+xml' }), 'relay-qr.svg')}>下载 SVG</button></div></div>}
  </div>;
}
