import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { getEffectivePreviewPreferences, usePreviewPreferences } from '../../stores/preview-preferences';
import { PREVIEW_CAPACITY_PRESETS, PREVIEW_IMAGE_PRESETS, type PreviewPreferences } from '../../generated/relay-contracts';
import { formControlClassName } from '../ui/FormControls';

type Preset = PreviewPreferences['capacityPreset'];
const labels: Record<Preset, string> = { default: '默认', enhanced: '增强', higher: '更高', custom: '自定义' };
function NumericSetting({ label, value, min, max, unit, disabled, onCommit }: { label: string; value: number; min: number; max: number; unit: string; disabled: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(String(value)); setError(''); }, [value]);
  const commit = () => {
    const next = Number(draft);
    if (!draft.trim() || !Number.isInteger(next) || next < min || next > max) { setError(`请输入 ${min}～${max} 的整数`); return; }
    setError('');
    if (next !== value && !disabled) onCommit(next);
  };
  return <label className="preview-setting-number"><span>{label} <small>（{unit}）</small></span><input type="number" aria-label={label} aria-invalid={Boolean(error)} min={min} max={max} step={1} value={draft} disabled={disabled} className={formControlClassName} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} /><small className={error ? 'preview-setting-error' : ''}>{error || `${min}～${max} ${unit}`}</small></label>;
}
export default function PreviewSettings({ onClose, surface = 'settings' }: { onClose?: () => void; surface?: 'settings' | 'preview_toolbar' }) {
  const { user } = useAuth();
  const state = usePreviewPreferences();
  const admin = user?.role === 'admin';
  useEffect(() => {
    state.configure(user?.id ?? null, admin);
    if (user) void usePreviewPreferences.getState().load();
  }, [user?.id, admin]);
  const disabled = state.saving || state.loading || !state.loaded || state.userId !== user?.id;
  const { capacity, image } = getEffectivePreviewPreferences();
  const p = state.preferences;
  const save = (changes: Partial<PreviewPreferences>) => state.save(changes, surface);
  const choose = (group: 'capacity' | 'image', preset: Preset) => {
    const changes: Partial<PreviewPreferences> = group === 'capacity' ? { capacityPreset: preset } : { imagePreset: preset };
    if (preset === 'custom') {
      if (group === 'capacity') changes.customCapacity = { ...capacity };
      else changes.customImage = { ...image };
    }
    void save(changes);
  };
  const presets = (group: 'capacity' | 'image') => <div className="preview-setting-presets" role="group" aria-label={group === 'capacity' ? '预览容量档位' : '图片清晰度档位'}>{(['default', 'enhanced', 'higher', ...(admin ? ['custom'] : [])] as Preset[]).map(preset => <button key={preset} type="button" aria-pressed={(group === 'capacity' ? p.capacityPreset : p.imagePreset) === preset} disabled={disabled} onClick={() => choose(group, preset)}>{labels[preset]}</button>)}</div>;
  return <section className="preview-settings" aria-label="预览设置" aria-busy={state.saving}>
    <header><div><h3>预览设置</h3><p>仅对你的账号生效</p></div>{onClose && <button type="button" aria-label="关闭预览设置" onClick={onClose}>×</button>}</header>
    <fieldset disabled={disabled}><legend>预览容量</legend>{presets('capacity')}
      {p.capacityPreset === 'custom' && admin ? <div className="preview-setting-fields">
        <NumericSetting label="文件大小上限" unit="MB" value={capacity.fileSizeMb} min={3} max={20} disabled={disabled} onCommit={value => void save({ customCapacity: { ...capacity, fileSizeMb: value } })} />
        <NumericSetting label="PDF / Word展示范围" unit="页或内容块" value={capacity.documentItems} min={50} max={500} disabled={disabled} onCommit={value => void save({ customCapacity: { ...capacity, documentItems: value } })} />
        <NumericSetting label="Excel行数" unit="行" value={capacity.spreadsheetRows} min={50} max={1000} disabled={disabled} onCommit={value => void save({ customCapacity: { ...capacity, spreadsheetRows: value } })} />
        <NumericSetting label="Excel列数" unit="列" value={capacity.spreadsheetColumns} min={100} max={300} disabled={disabled} onCommit={value => void save({ customCapacity: { ...capacity, spreadsheetColumns: value } })} />
      </div> : <dl><dt>文件大小</dt><dd>≤{capacity.fileSizeMb} MB</dd><dt>PDF / Word</dt><dd>前{capacity.documentItems}页或内容块</dd><dt>Excel</dt><dd>{capacity.spreadsheetRows}行 × {capacity.spreadsheetColumns}列</dd></dl>}
      <p className="preview-setting-hint">Word无可靠分页时按内容块展示；文本超限仅显示开头，音视频超限需调整容量或下载查看。复杂文档仍受解析资源限制。</p>
    </fieldset>
    <fieldset disabled={disabled}><legend>图片清晰度</legend>{presets('image')}
      {p.imagePreset === 'custom' && admin ? <div className="preview-setting-fields">
        <NumericSetting label="原图直出上限" unit="MB" value={image.directSizeMb} min={5} max={20} disabled={disabled} onCommit={value => void save({ customImage: { ...image, directSizeMb: value } })} />
        <NumericSetting label="压缩最长边" unit="px" value={image.maxDimension} min={2048} max={8192} disabled={disabled} onCommit={value => void save({ customImage: { ...image, maxDimension: value } })} />
        <NumericSetting label="压缩质量" unit="%" value={image.qualityPercent} min={82} max={100} disabled={disabled} onCommit={value => void save({ customImage: { ...image, qualityPercent: value } })} />
      </div> : <dl><dt>原图直出</dt><dd>≤{image.directSizeMb} MB</dd>{image.directSizeMb < 20 && <><dt>压缩最长边</dt><dd>{image.maxDimension} px</dd><dt>压缩质量</dt><dd>{image.qualityPercent}%</dd></>}</dl>}
      <p className="preview-setting-hint">超过直出上限自动压缩；超过20 MB的图片需下载查看。</p>
    </fieldset>
    {state.error && <div role="alert" className="preview-setting-error">{state.error}{!state.loaded && <button type="button" disabled={state.loading} onClick={() => void state.load()}>重试</button>}</div>}
    <footer><span role="status">{state.loading ? '正在加载…' : state.saving ? '保存中…' : state.error ? '尚未保存' : state.loaded ? '已保存' : ''}</span><button type="button" disabled={disabled} onClick={() => void save({ capacityPreset: 'default', imagePreset: 'default', ...(admin ? { customCapacity: { ...PREVIEW_CAPACITY_PRESETS.default }, customImage: { ...PREVIEW_IMAGE_PRESETS.default } } : {}) })}>恢复默认</button></footer>
  </section>;
}
