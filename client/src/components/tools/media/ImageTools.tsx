import { useEffect, useMemo, useState } from 'react';
import { localAction } from '../../../analytics/features';
import { createQrSvg } from '../qr-code';
import { ToolError } from '../tool-ui';
import { AssetList, CanvasPreview, ImageExport, ImagePicker } from './image-ui';
import { drawFitted, drawText, loadImage, sizeOf, type CanvasDesign, type Fit, type ImageAsset, type ImageFormat } from './image-render';
import { Choice, ColorField, Details, Field, NumberField, Preview, Workspace, mediaButton, mediaInput, useMediaPreset } from './media-ui';
import { fileSize } from './media-files';

const fits = [['cover', '裁切填满'], ['contain', '完整保留（可留白）']] as const;
const fitHint = '填满会裁掉边缘，完整保留会在边上留空。切换后可以看预览。';
const ratios = [['free', '自定义'], ['original', '原图比例'], ['square', '1:1 方图'], ['wide', '16:9 横图'], ['portrait', '3:4 竖图']] as const;
type Ratio = typeof ratios[number][0];
const imageDefaults = { fit: 'cover' as Fit, ratio: 'original' as Ratio, format: 'image/webp' as ImageFormat, maxEdge: 4096 };

function readImagePreset(input: unknown) {
  const value = input as Partial<typeof imageDefaults> | null;
  return {
    fit: value?.fit === 'contain' ? 'contain' as const : imageDefaults.fit,
    ratio: ratios.some(([key]) => key === value?.ratio) ? value!.ratio! : imageDefaults.ratio,
    format: value?.format === 'image/png' || value?.format === 'image/jpeg' ? value.format : imageDefaults.format,
    maxEdge: typeof value?.maxEdge === 'number' && value.maxEdge >= 64 && value.maxEdge <= 4096 ? Math.round(value.maxEdge) : imageDefaults.maxEdge,
  };
}

function ratioHeight(ratio: Ratio, width: number, height: number, original: number) {
  return Math.max(1, Math.round(ratio === 'square' ? width : ratio === 'wide' ? width * 9 / 16 : ratio === 'portrait' ? width * 4 / 3 : ratio === 'original' ? width / original : height));
}

export function ImageEdit({ storageKey }: { storageKey: string }) {
  const preset = useMediaPreset(`${storageKey}:image-edit:v1`, imageDefaults, readImagePreset);
  const { fit, format, ratio, maxEdge } = preset.value;
  const [asset, setAsset] = useState<ImageAsset | null>(null);
  const [rotation, setRotation] = useState(0);
  const [flip, setFlip] = useState(false);
  const [width, setWidth] = useState(1200);
  const [height, setHeight] = useState(1200);
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [clear, setClear] = useState(true);
  const [background, setBackground] = useState('#ffffff');
  const [original, setOriginal] = useState(false);
  const swapped = rotation % 180 !== 0;
  const sourceRatio = asset ? swapped ? asset.image.naturalHeight / asset.image.naturalWidth : asset.image.naturalWidth / asset.image.naturalHeight : 1;
  const outputWidth = Math.max(1, Math.round(width));
  const outputHeight = ratioHeight(ratio, outputWidth, height, sourceRatio);
  const source = useMemo<CanvasDesign | null>(() => asset ? {
    ...sizeOf(asset.image), paint: (ctx) => ctx.drawImage(asset.image, 0, 0),
  } : null, [asset]);
  const design = useMemo<CanvasDesign | null>(() => asset ? {
    width: outputWidth, height: outputHeight,
    paint(ctx) {
      if (!clear) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, outputWidth, outputHeight);
      }
      ctx.translate(outputWidth / 2, outputHeight / 2);
      ctx.scale(flip ? -1 : 1, 1);
      ctx.rotate(rotation * Math.PI / 180);
      const target = { width: swapped ? outputHeight : outputWidth, height: swapped ? outputWidth : outputHeight };
      const anchor = flip ? 100 - x : x;
      const point = rotation === 90 ? [y, 100 - anchor] : rotation === 180 ? [100 - anchor, 100 - y] : rotation === 270 ? [100 - y, anchor] : [anchor, y];
      drawFitted(ctx, asset.image, sizeOf(asset.image), target, fit, -target.width / 2, -target.height / 2, point[0], point[1]);
    },
  } : null, [asset, outputWidth, outputHeight, clear, background, flip, rotation, swapped, fit, x, y]);
  function chooseAsset(next: ImageAsset) {
    setAsset(next);
    setRotation(0);
    setFlip(false);
    setX(50);
    setY(50);
    setOriginal(false);
    const scale = Math.min(1, maxEdge / Math.max(next.image.naturalWidth, next.image.naturalHeight));
    setWidth(Math.max(1, Math.round(next.image.naturalWidth * scale)));
    setHeight(Math.max(1, Math.round(next.image.naturalHeight * scale)));
  }
  const live = original ? source : design;
  return <Workspace widePreview preview={<Preview title="图片预览" empty="选择一张图片，预览会随设置更新。">{live && <>
    <div className="media-actions">
      <button className={mediaButton} type="button" aria-pressed={!original} onClick={() => setOriginal(false)}>处理效果</button>
      <button className={mediaButton} type="button" aria-pressed={original} onClick={() => setOriginal(true)}>原图</button>
    </div>
    <CanvasPreview design={live} label={original ? '原图' : '图片编辑效果'} white={!original && format === 'image/jpeg'} />
    <p className="media-hint">{original ? '原图' : '输出尺寸'} {live.width} × {live.height} 像素{asset && ` · 原文件 ${fileSize(asset.bytes)}`}</p>
  </>}</Preview>}>
    <ImagePicker label={asset ? `更换图片（${asset.name}）` : '选择图片'} onImage={chooseAsset} />
    {asset && <>
      <div className="media-actions">
        <button className={mediaButton} type="button" onClick={() => {
          if (ratio === 'original') setWidth(outputHeight);
          setRotation((rotation + 90) % 360);
        }}>顺时针旋转 90°</button>
        <button className={mediaButton} type="button" aria-pressed={flip} onClick={() => setFlip(!flip)}>水平翻转</button>
      </div>
      <div className="media-fields">
        <Choice label="改成什么形状（比例）" value={ratio} options={ratios} onChange={(value) => preset.setValue({ ...preset.value, ratio: value })} />
        <Choice label="照片怎么放" hint={fitHint} value={fit} options={fits} onChange={(value) => preset.setValue({ ...preset.value, fit: value })} />
        <NumberField label="图片宽度（像素）" value={width} min={1} max={8192} onChange={setWidth} />
        {ratio === 'free' && <NumberField label="图片高度（像素）" value={height} min={1} max={8192} onChange={setHeight} />}
      </div>
      <Details title="裁切位置和背景">
        <Field label="保留偏左还是偏右"><input type="range" value={x} onChange={(event) => setX(Number(event.target.value))} /></Field>
        <Field label="保留偏上还是偏下"><input type="range" value={y} onChange={(event) => setY(Number(event.target.value))} /></Field>
        <Field label="透明背景"><input type="checkbox" checked={clear} onChange={(event) => setClear(event.target.checked)} /></Field>
        {!clear && <ColorField label="背景颜色" value={background} onChange={setBackground} />}
      </Details>
    </>}
    <ImageExport design={design} format={format} setFormat={(value) => preset.setValue({ ...preset.value, format: value })}
      defaultName={asset ? `${asset.name.replace(/\.[^.]+$/, '')}-编辑` : '图片'} />
    <Details title="默认设置">
      <NumberField label="新选图片最长边上限（像素）" value={maxEdge} min={64} max={4096} onChange={(value) => preset.setValue({ ...preset.value, maxEdge: value })} />
      <button type="button" className={mediaButton} onClick={preset.save}>保存格式、比例和适配</button>
      <span className="media-hint" role="status">{preset.notice}</span>
    </Details>
  </Workspace>;
}

export function ImageStitch() {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [mode, setMode] = useState<'vertical' | 'horizontal' | 'grid'>('vertical');
  const [edge, setEdge] = useState(600);
  const [gap, setGap] = useState(8);
  const [columns, setColumns] = useState(2);
  const [labels, setLabels] = useState<'none' | 'number' | 'file'>('none');
  const [gridFit, setGridFit] = useState<Fit>('contain');
  const [background, setBackground] = useState('#ffffff');
  const [format, setFormat] = useState<ImageFormat>('image/png');
  const design = useMemo<CanvasDesign | null>(() => {
    if (!assets.length) return null;
    const cell = Math.round(edge);
    const space = Math.round(gap);
    const labelSpace = labels === 'none' ? 0 : Math.max(22, Math.round(cell / 18));
    const parts = assets.map((asset) => {
      const { width, height } = sizeOf(asset.image);
      return { asset, width: mode === 'horizontal' ? Math.max(1, Math.round(cell * width / height)) : cell,
        height: mode === 'vertical' ? Math.max(1, Math.round(cell * height / width)) : cell };
    });
    const count = mode === 'grid' ? Math.min(assets.length, Math.round(columns)) : mode === 'horizontal' ? assets.length : 1;
    const rows = Math.ceil(assets.length / count);
    const width = (mode === 'horizontal' ? parts.reduce((sum, part) => sum + part.width, 0) : count * cell) + (count + 1) * space;
    const height = (mode === 'vertical' ? parts.reduce((sum, part) => sum + part.height + labelSpace, 0) : rows * (cell + labelSpace)) + (rows + 1) * space;
    return { width, height, paint(ctx) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      let left = space, top = space;
      for (const [index, part] of parts.entries()) {
        if (mode === 'grid') {
          left = space + (index % count) * (cell + space);
          top = space + Math.floor(index / count) * (cell + labelSpace + space);
        }
        drawFitted(ctx, part.asset.image, sizeOf(part.asset.image), part, mode === 'grid' ? gridFit : 'contain', left, top);
        if (labelSpace) {
          ctx.fillStyle = '#161616cc';
          ctx.fillRect(left, top + part.height, part.width, labelSpace);
          ctx.save();
          ctx.beginPath(); ctx.rect(left, top + part.height, part.width, labelSpace); ctx.clip();
          drawText(ctx, labels === 'number' ? String(index + 1) : part.asset.name, left + 4, top + part.height + 3,
            Math.max(1, part.width - 8), Math.floor(labelSpace * 0.65), '#ffffff');
          ctx.restore();
        }
        if (mode === 'vertical') top += part.height + labelSpace + space;
        if (mode === 'horizontal') left += part.width + space;
      }
    } };
  }, [assets, mode, edge, gap, columns, labels, background, gridFit]);
  return <Workspace widePreview preview={<Preview title="拼接预览" empty="选择多张截图或照片，查看合成后的效果。">
    {design && <><CanvasPreview design={design} label="拼接效果" /><p className="media-hint">{assets.length} 张 · {design.width} × {design.height} 像素</p></>}
  </Preview>}>
    <ImagePicker label="选择要拼接的图片（可多选，重选替换）" onImages={setAssets} />
    <AssetList assets={assets} setAssets={setAssets} />
    <div className="media-fields">
      <Choice label="图片怎么排" value={mode} onChange={setMode} options={ [['vertical', '从上往下'], ['horizontal', '从左往右'], ['grid', '排成几行（网格）']] } />
      <NumberField label={mode === 'vertical' ? '单张宽度（像素）' : mode === 'horizontal' ? '单张高度（像素）' : '网格边长（像素）'} value={edge} min={100} max={2400} onChange={setEdge} />
      {mode === 'grid' && <NumberField label="每行放几张" value={columns} min={1} max={6} onChange={setColumns} />}
    </div>
    <Details title="间距、背景和图片标签">
      <NumberField label="间距（像素）" value={gap} max={120} onChange={setGap} />
      <ColorField label="背景" value={background} onChange={setBackground} />
      {mode === 'grid' && <Choice label="每格里的照片怎么放" hint={fitHint} options={fits} value={gridFit} onChange={setGridFit} />}
      <Choice label="图片标签" value={labels} onChange={setLabels} options={ [['none', '无'], ['number', '编号'], ['file', '文件名']] } />
    </Details>
    <ImageExport design={design} format={format} setFormat={setFormat} defaultName="图片拼接" />
  </Workspace>;
}

interface Layer {
  id: number; kind: 'text' | 'image' | 'qr' | 'shape'; x: number; y: number; width: number; height: number;
  text: string; color: string; font: string; fontSize: number; align: CanvasTextAlign; fit: Fit; asset?: ImageAsset;
}
const layerNames = { text: '文字', image: '图片', qr: '二维码', shape: '色块' };
let layerId = 0;

function makeLayer(kind: Layer['kind']): Layer {
  return { id: ++layerId, kind, x: 13, y: 13, width: kind === 'qr' ? 25 : 74, height: kind === 'text' ? 18 : 65,
    text: kind === 'text' ? '在这里输入标题' : '', color: kind === 'shape' ? '#d9e8f8' : '#172033',
    font: 'sans-serif', fontSize: 48, align: 'center', fit: 'contain' };
}

function useQrLayers(layers: Layer[]) {
  const [result, setResult] = useState<{ signature: string; images: Map<number, HTMLImageElement>; error: string } | null>(null);
  const signature = JSON.stringify(layers.filter((layer) => layer.kind === 'qr' && layer.text.trim()).map(({ id, text }) => ({ id, text })));
  useEffect(() => {
    let valid = true;
    const entries = JSON.parse(signature) as { id: number; text: string }[];
    void (async () => {
      const images = new Map<number, HTMLImageElement>();
      try {
        for (const entry of entries) {
          const svg = createQrSvg(entry.text);
          images.set(entry.id, await loadImage(new Blob([svg], { type: 'image/svg+xml' })));
          if (!valid) return;
        }
        if (valid) setResult({ signature, images, error: '' });
      } catch (error) { if (valid) setResult({ signature, images, error: error instanceof Error ? error.message : '二维码无法生成。' }); }
    })();
    return () => { valid = false; };
  }, [signature]);
  return result?.signature === signature ? result : null;
}

function loadLayout(key: string) {
  const fallback = { width: 1080, height: 1350, background: '#ffffff', layers: [makeLayer('text')] };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as typeof fallback | null;
    if (!value || !Array.isArray(value.layers) || value.layers.length > 12) return fallback;
    const bound = (number: number, min: number, max: number, defaultValue: number) => Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : defaultValue;
    const color = (input: string, defaultValue: string) => typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input) ? input : defaultValue;
    return { width: bound(value.width, 160, 3840, fallback.width), height: bound(value.height, 160, 3840, fallback.height),
      background: color(value.background, fallback.background), layers: value.layers.flatMap((data) => {
        if (!data || !Object.prototype.hasOwnProperty.call(layerNames, data.kind)) return [];
        const layer = makeLayer(data.kind);
        return [{ ...layer, x: bound(data.x, 0, 99, layer.x), y: bound(data.y, 0, 99, layer.y),
          width: bound(data.width, 1, 100, layer.width), height: bound(data.height, 1, 100, layer.height),
          fontSize: bound(data.fontSize, 8, 400, layer.fontSize), color: color(data.color, layer.color),
          font: ['sans-serif', 'serif', 'monospace'].includes(data.font) ? data.font : layer.font,
          align: (['left', 'right', 'center'] as const).find((item) => item === data.align) ?? layer.align,
          fit: data.fit === 'cover' ? 'cover' as const : layer.fit,
        }];
      }),
    };
  } catch { return fallback; }
}

export function ImageLayout({ storageKey }: { storageKey: string }) {
  const key = `${storageKey}:image-layout:v1`;
  const [saved] = useState(() => loadLayout(key));
  const [width, setWidth] = useState(saved.width);
  const [height, setHeight] = useState(saved.height);
  const [background, setBackground] = useState(saved.background);
  const [layers, setLayers] = useState<Layer[]>(saved.layers);
  const [selected, setSelected] = useState<number | null>(null);
  const [format, setFormat] = useState<ImageFormat>('image/png');
  const [place, setPlace] = useState(false);
  const [notice, setNotice] = useState('');
  const qr = useQrLayers(layers);
  const active = selected === null ? layers[layers.length - 1] : layers.find((layer) => layer.id === selected);
  function change(id: number, patch: Partial<Layer>) {
    setLayers((current) => current.map((layer) => layer.id === id ? { ...layer, ...patch } : layer));
  }
  function move(index: number, offset: number) {
    const next = [...layers];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    setLayers(next);
  }
  const design = useMemo<CanvasDesign>(() => ({
    width: Math.round(width), height: Math.round(height),
    paint(ctx) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      for (const layer of layers) {
        const left = width * layer.x / 100, top = height * layer.y / 100;
        const target = { width: width * layer.width / 100, height: height * layer.height / 100 };
        if (layer.kind === 'shape') {
          ctx.fillStyle = layer.color;
          ctx.fillRect(left, top, target.width, target.height);
        } else if (layer.kind === 'image' && layer.asset) {
          drawFitted(ctx, layer.asset.image, sizeOf(layer.asset.image), target, layer.fit, left, top);
        } else if (layer.kind === 'text') {
          drawText(ctx, layer.text, left, top, target.width, layer.fontSize, layer.color, layer.align, layer.font);
        } else if (layer.kind === 'qr') {
          const image = qr?.images.get(layer.id);
          if (image) {
            const side = Math.round(Math.min(target.width, height - top, width - left));
            if (side > 0) {
              ctx.save();
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(image, Math.round(left), Math.round(top), side, side);
              ctx.restore();
            }
          }
        }
      }
    },
  }), [width, height, background, layers, qr]);
  return <Workspace widePreview preview={<Preview title="排版预览">
    <CanvasPreview design={design} label="图片排版效果" onPlace={place && active ? (x, y) => {
      change(active.id, { x, y }); setPlace(false);
    } : undefined} />
    <p className="media-hint">画布 {width} × {height} 像素</p>
    <button type="button" className={mediaButton} disabled={!active} aria-pressed={place && Boolean(active)} onClick={() => setPlace(!place)}>
      {place && active ? '取消设置位置' : '在预览中放置所选图层'}
    </button>
    {place && active && <p className="media-hint" role="status">点预览画面，设置所选图层的左上角。</p>}
  </Preview>}>
    <Details title="画布尺寸与背景">
      <NumberField label="整张图的宽度（像素）" value={width} min={160} max={3840} onChange={setWidth} />
      <NumberField label="整张图的高度（像素）" value={height} min={160} max={3840} onChange={setHeight} />
      <ColorField label="整张图的背景色" value={background} onChange={setBackground} />
    </Details>
    <h3 className="font-semibold">图层</h3>
    <div className="media-actions">{(Object.keys(layerNames) as Layer['kind'][]).map((kind) => <button type="button" className={mediaButton}
      key={kind} disabled={layers.length >= 12} onClick={() => { const layer = makeLayer(kind); setLayers([...layers, layer]); setSelected(layer.id); }}>添加{layerNames[kind]}</button>)}</div>
    <ol className="media-file-list" aria-label="图层顺序">{layers.map((layer, index) => <li key={layer.id}>
      <button type="button" className={mediaButton} aria-pressed={active?.id === layer.id} onClick={() => setSelected(layer.id)}>{index + 1}. {layerNames[layer.kind]}</button>
      <div className="media-actions">
        <button type="button" className={mediaButton} disabled={index === 0} aria-label={`图层 ${index + 1} 后移`} onClick={() => move(index, -1)}>后移</button>
        <button type="button" className={mediaButton} disabled={index === layers.length - 1} aria-label={`图层 ${index + 1} 前移`} onClick={() => move(index, 1)}>前移</button>
        <button type="button" className={mediaButton} aria-label={`移除图层 ${index + 1}`} onClick={() => { setLayers(layers.filter((item) => item.id !== layer.id)); if (active?.id === layer.id) setSelected(null); }}>移除</button>
      </div>
    </li>)}</ol>
    {active && <fieldset className="media-controls" key={active.id}><legend className="media-hint">编辑{layerNames[active.kind]}图层</legend>
      {active.kind === 'text' && <>
        <Field label="文字内容"><textarea className={mediaInput} rows={2} maxLength={500} value={active.text} onChange={(event) => change(active.id, { text: event.target.value })} /></Field>
        <div className="media-fields">
          <NumberField label="字号（像素）" min={8} max={400} value={active.fontSize} onChange={(fontSize) => change(active.id, { fontSize })} />
          <Choice label="字体" value={active.font} onChange={(font) => change(active.id, { font })} options={ [['sans-serif', '无衬线'], ['serif', '衬线'], ['monospace', '等宽']] } />
          <Choice<CanvasTextAlign> label="对齐" value={active.align} onChange={(align) => change(active.id, { align })} options={ [['left', '左对齐'], ['center', '居中'], ['right', '右对齐']] } />
          <ColorField label="文字颜色" value={active.color} onChange={(color) => change(active.id, { color })} />
        </div>
      </>}
      {active.kind === 'image' && <><ImagePicker label={active.asset ? `更换 ${active.asset.name}` : '选择图层图片'} onImage={(asset) => change(active.id, { asset })} />
        <Choice label="照片怎么放" hint={fitHint} options={fits} value={active.fit} onChange={(fit) => change(active.id, { fit })} /></>}
      {active.kind === 'qr' && <Field label="二维码内容"><input className={mediaInput} value={active.text} maxLength={1500} onChange={(event) => change(active.id, { text: event.target.value })} /></Field>}
      {active.kind === 'shape' && <ColorField label="填充颜色" value={active.color} onChange={(color) => change(active.id, { color })} />}
      <Details title="调整所选内容的位置和大小">
        <NumberField label="距左侧（%）" value={active.x} max={99} onChange={(x) => change(active.id, { x })} />
        <NumberField label="距顶部（%）" value={active.y} max={99} onChange={(y) => change(active.id, { y })} />
        <NumberField label="宽度（%）" min={1} value={active.width} onChange={(value) => change(active.id, { width: value })} />
        {(active.kind === 'image' || active.kind === 'shape') && <NumberField label="高度（%）" min={1} value={active.height} onChange={(value) => change(active.id, { height: value })} />}
      </Details>
    </fieldset>}
    <ToolError message={qr?.error ?? ''} />
    <Details title="保存排版模板">
      <p className="media-hint">模板保存在当前设备，包含画布和图层样式。再次打开时可以填入新文字和图片。</p>
      <button type="button" className={mediaButton} onClick={() => {
        const report = localAction('tools', 'save_preset', 'tools', { toolId: 'image-layout' });
        try {
          const styles = layers.map(({ asset: _asset, text: _text, ...layer }) => layer);
          localStorage.setItem(key, JSON.stringify({ width, height, background, layers: styles }));
          setNotice('已保存模板。');
          report(true);
        } catch { setNotice('浏览器暂时无法保存模板。'); report(false); }
      }}>保存为默认模板</button>
      <span className="media-hint" role="status">{notice}</span>
    </Details>
    <ImageExport design={qr && !qr.error ? design : null} format={format} setFormat={setFormat} defaultName="图片排版" />
  </Workspace>;
}
