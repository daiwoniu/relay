import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { AccountThemeSettingsDto, ThemePreference, ThemeProfileDto } from '../../generated/relay-contracts';
import { deleteThemeAsset, uploadThemeAsset } from '../../api/theme-settings';
import {featureAction} from '../../analytics/features';
import { useTheme } from '../../hooks/useTheme';
import { copyThemeProfile, createDefaultThemeSettings, getUnusedPendingThemeAssetIds, setLinkedThemeProfiles, setThemeProfile, type ThemeDevice } from '../../theme/theme-model';
import { createThemeImageVariants } from '../../theme/theme-image';
import { getRemoteThemeDraftAction } from '../../theme/theme-draft';
import { applyRecommendedThemeBackground } from '../../theme/theme-background-recommendations';
import { THEME_BACKGROUND_PRESETS } from '../../theme/theme-presets.ts';
import {
  FormFeedback,
  formActionsClassName,
  formCheckboxClassName,
  formColorClassName,
  formRangeClassName,
  formSegmentedClassName,
  formSegmentedOptionClassName,
  formSelectClassName,
  primaryFormButtonClassName,
  secondaryFormButtonClassName,
} from '../ui/FormControls';
import Modal from '../ui/Modal';
import IconActionButton from '../ui/IconActionButton';
import { ClosePanelIcon } from '../ui/MinimizedPanelBar';
import Tooltip from '../ui/Tooltip';
import ThemePreviewBar from './ThemePreviewBar';

function FieldName({ label, hint, htmlFor }: { label: string; hint: string; htmlFor: string }) {
  return <span className="inline-flex items-center gap-1.5"><label htmlFor={htmlFor}>{label}</label><Tooltip coexist content={hint} placement="top"><button type="button" aria-label={`${label}调整说明`} className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--color-border)] text-[10px] font-semibold leading-none text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-text-tertiary)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">?</button></Tooltip></span>;
}

function RangeField({ label, hint, value, min, max, step, suffix = '', onChange }: { label: string; hint: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  const inputId = useId();
  return <div className="grid gap-1.5"><div className="flex items-center justify-between text-xs text-[var(--color-text-secondary)]"><FieldName label={label} hint={hint} htmlFor={inputId} /><span className="tabular-nums text-[var(--color-text-tertiary)]">{Math.round(value * (suffix === '%' ? 100 : 1))}{suffix}</span></div><input id={inputId} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className={formRangeClassName} /></div>;
}

export interface ThemeSettingsDialogHandle {
  discardChanges: () => void;
  minimize: () => void;
}

interface ThemeSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  mobile?: boolean;
  embedded?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onMinimizedChange?: (minimized: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}

const ThemeSettingsDialog = forwardRef<ThemeSettingsDialogHandle, ThemeSettingsDialogProps>(function ThemeSettingsDialog({ open, onClose, mobile = false, embedded = false, onDirtyChange, onMinimizedChange, onBusyChange }, ref) {
  const theme = useTheme();
  const [draft, setDraft] = useState<AccountThemeSettingsDto>(theme.settings);
  const [editingDevice, setEditingDevice] = useState<ThemeDevice>(theme.device);
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState('');
  const [remoteConflict, setRemoteConflict] = useState(false);
  const pendingAssetIdsRef = useRef<string[]>([]);
  const [minimized, setMinimized] = useState(false);
  const openRef = useRef(open);
  const lifecycleRef = useRef(0);
  const baseUpdatedAtRef = useRef(theme.settings.updatedAt);
  const dirtyRef = useRef(false);

  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [onDirtyChange]);

  const setPreviewMinimized = useCallback((next: boolean) => {
    setMinimized(next);
    onMinimizedChange?.(next);
  }, [onMinimizedChange]);

  const replacePendingAssets = useCallback((assetIds: string[]) => {
    pendingAssetIdsRef.current = assetIds;
  }, []);

  useEffect(() => {
    if (!open) {
      setPreviewMinimized(false);
      return;
    }
    setPreviewMinimized(false);
    setDraft(structuredClone(theme.settings));
    setEditingDevice(theme.device);
    setLocalError('');
    setRemoteConflict(false);
    replacePendingAssets([]);
    baseUpdatedAtRef.current = theme.settings.updatedAt;
    setDirty(false);
  }, [open, replacePendingAssets, setDirty, setPreviewMinimized]);

  useEffect(() => () => {
    theme.preview(null);
    for (const assetId of pendingAssetIdsRef.current) void deleteThemeAsset(assetId).catch(() => {});
    pendingAssetIdsRef.current = [];
  }, [theme.preview]);

  useEffect(() => {
    onBusyChange?.(theme.saving || theme.loading || uploading);
  }, [onBusyChange, theme.loading, theme.saving, uploading]);

  useEffect(() => {
    openRef.current = open;
    lifecycleRef.current += 1;
  }, [open]);

  useEffect(() => {
    if (!open) {
      theme.preview(null);
      return;
    }
    const frame = requestAnimationFrame(() => theme.preview(draft));
    return () => cancelAnimationFrame(frame);
  }, [draft, open, theme.preview, theme.settings.updatedAt]);

  useEffect(() => {
    if (!open) return;
    const action = getRemoteThemeDraftAction(baseUpdatedAtRef.current, dirtyRef.current, theme.settings.updatedAt);
    if (action === 'unchanged') return;
    if (action === 'replace') {
      setDraft(structuredClone(theme.settings));
      baseUpdatedAtRef.current = theme.settings.updatedAt;
      setRemoteConflict(false);
      return;
    }
    setRemoteConflict(true);
  }, [open, theme.settings]);

  const updateDraft = (updater: (current: AccountThemeSettingsDto) => AccountThemeSettingsDto) => {if(!dirtyRef.current)featureAction('settings','preview_theme','settings');
    setDirty(true);
    setDraft(updater);
  };

  const profile = draft.linkedProfiles ? draft.desktop : draft[editingDevice];
  const updateProfile = (updates: Partial<ThemeProfileDto>) => updateDraft((current) => setThemeProfile(current, editingDevice, { ...(current.linkedProfiles ? current.desktop : current[editingDevice]), ...updates }));
  const profileLabel = editingDevice === 'desktop' ? '桌面端' : '移动端';
  const backgroundSelection = `${profile.backgroundKind}:${profile.backgroundValue ?? ''}`;
  const selectBackground = (backgroundKind: ThemeProfileDto['backgroundKind'], backgroundValue: string | null) => {
    if (backgroundSelection === `${backgroundKind}:${backgroundValue ?? ''}`) return;
    updateDraft((current) => {
      const currentProfile = current.linkedProfiles ? current.desktop : current[editingDevice];
      return setThemeProfile(current, editingDevice, applyRecommendedThemeBackground(currentProfile, backgroundKind, backgroundValue));
    });
  };
  const overlayColorId = useId();
  const backgroundFitId = useId();
  const backgroundPositionId = useId();

  const deleteAssets = (assetIds: readonly string[]) => {
    for (const assetId of assetIds) void deleteThemeAsset(assetId).catch(() => {});
  };

  const discardChanges = useCallback(() => {
    openRef.current = false;
    lifecycleRef.current += 1;
    theme.preview(null);
    deleteAssets(pendingAssetIdsRef.current);
    replacePendingAssets([]);
    setDirty(false);
  }, [replacePendingAssets, setDirty, theme.preview]);

  const closeAndRollback = useCallback(() => {
    if (theme.saving) return;
    discardChanges();
    onClose();
  }, [discardChanges, onClose, theme.saving]);

  useImperativeHandle(ref, () => ({
    discardChanges,
    minimize: () => {
      if (!theme.saving && !theme.loading && !uploading) setPreviewMinimized(true);
    },
  }), [discardChanges, setPreviewMinimized, theme.loading, theme.saving, uploading]);

  useEffect(() => {
    if (!open || !minimized) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAndRollback();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeAndRollback, minimized, open]);

  const loadLatestSettings = () => {
    deleteAssets(pendingAssetIdsRef.current);
    replacePendingAssets([]);
    setDraft(structuredClone(theme.settings));
    baseUpdatedAtRef.current = theme.settings.updatedAt;
    setDirty(false);
    setRemoteConflict(false);
    setLocalError('');
  };

  const save = async () => {
    if (remoteConflict || theme.loading) return;
    try {
      const saved = await theme.save(draft);
      deleteAssets(getUnusedPendingThemeAssetIds(pendingAssetIdsRef.current, saved));
      replacePendingAssets([]);
      setDirty(false);
      openRef.current = false;
      lifecycleRef.current += 1;
      onClose();
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : '保存主题设置失败');
      setPreviewMinimized(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const lifecycle = lifecycleRef.current;
    setUploading(true);
    setLocalError('');
    try {
      const variants = await createThemeImageVariants(file);
      const { assetId } = await uploadThemeAsset(variants.desktop, variants.mobile);
      if (!openRef.current || lifecycle !== lifecycleRef.current) {
        deleteAssets([assetId]);
        return;
      }
      replacePendingAssets([...pendingAssetIdsRef.current, assetId]);
      selectBackground('asset', assetId);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : '上传背景失败');
    } finally {
      setUploading(false);
    }
  };

  const contentClass = mobile
    ? 'theme-surface fixed inset-x-0 bottom-0 flex max-h-[94dvh] flex-col rounded-t-2xl border border-b-0 border-[var(--color-border)] bg-[var(--color-overlay-surface)] shadow-[var(--color-overlay-shadow)]'
    : 'theme-surface flex max-h-[88vh] w-[min(760px,calc(100vw-2rem))] flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-overlay-surface)] shadow-[var(--color-overlay-shadow)]';

  const presetCards = useMemo(() => THEME_BACKGROUND_PRESETS.map((preset) => ({ ...preset, selected: backgroundSelection === `preset:${preset.id}` })), [backgroundSelection]);

  const content = <>
      {!embedded && <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3.5 sm:px-5">
        <div><h2 id="theme-settings-title" className="text-base font-semibold text-[var(--color-text)]">主题与外观</h2><p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">背景营造氛围，面板始终保证消息清晰可读</p></div>
        <div className="flex items-center gap-1">
          <Tooltip coexist content="收起设置面板，在完整页面中查看当前未保存的主题效果"><button type="button" onClick={() => setPreviewMinimized(true)} disabled={theme.saving || theme.loading || uploading} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:opacity-50" aria-label="最小化主题预览"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button></Tooltip>
          <IconActionButton label="关闭主题设置" variant="neutral" tooltip={false} className="h-8 w-8" onClick={closeAndRollback} disabled={theme.saving}><ClosePanelIcon /></IconActionButton>
        </div>
      </div>}

    <div className={`min-h-0 flex-1 overflow-y-auto px-4 py-3.5 sm:px-5 ${theme.loading ? 'pointer-events-none opacity-60' : ''}`}>
      <section className="space-y-3">
        <div><div className="text-xs font-semibold tracking-wide text-[var(--color-text)]">全局外观</div><div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">应用到当前账号的所有设备</div></div>
        <div className="space-y-2"><div className="text-[11px] font-medium text-[var(--color-text-secondary)]">明暗模式</div><div className={`${formSegmentedClassName} ui-form-segmented--fill`}>
          {(['system', 'light', 'dark'] as ThemePreference[]).map((preference) => <button key={preference} type="button" aria-pressed={draft.basePreference === preference} onClick={() => updateDraft((current) => ({ ...current, basePreference: preference }))} className={`${formSegmentedOptionClassName} ${draft.basePreference === preference ? 'is-selected' : ''}`.trim()}>{preference === 'system' ? '跟随系统' : preference === 'light' ? '浅色' : '暗色'}</button>)}
        </div></div>
        <div className="space-y-2"><div className="text-[11px] font-medium text-[var(--color-text-secondary)]">色彩风格</div><div className="grid grid-cols-2 gap-2">
          {([['neutral', '中性', '克制清晰'], ['aurora', '极光', '柔和灵动']] as const).map(([style, label, description]) => <button key={style} type="button" aria-pressed={draft.colorStyle === style} onClick={() => updateDraft((current) => ({ ...current, colorStyle: style }))} className={`theme-style-option ${draft.colorStyle === style ? 'is-selected' : ''}`.trim()}><span className={`theme-style-option__swatch theme-style-option__swatch--${style}`} aria-hidden="true" /><span><span className="block text-xs font-medium text-[var(--color-text)]">{label}</span><span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">{description}</span></span></button>)}
        </div></div>
        <div className="space-y-2"><div><div className="text-[11px] font-medium text-[var(--color-text-secondary)]">内容字号</div><div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">调整消息、过程详情和文件预览，控件尺寸保持不变</div></div><div className={`${formSegmentedClassName} ui-form-segmented--fill`}>
          {([['compact', '紧凑'], ['standard', '标准'], ['large', '大号']] as const).map(([scale, label]) => <button key={scale} type="button" aria-pressed={draft.textScale === scale} onClick={() => updateDraft((current) => ({ ...current, textScale: scale }))} className={`${formSegmentedOptionClassName} ${draft.textScale === scale ? 'is-selected' : ''}`.trim()}>{label}</button>)}
        </div></div>
      </section>

      <section className="mt-4 space-y-3 border-t border-[var(--color-border)] pt-3.5">
        <div><div className="text-xs font-semibold tracking-wide text-[var(--color-text)]">设备外观</div><div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">背景与面板效果可以按设备设置</div></div>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-[11px] font-medium text-[var(--color-text-secondary)]">设备同步</div><div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">设置会随账号同步</div></div><label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]"><input type="checkbox" checked={draft.linkedProfiles} onChange={(event) => updateDraft((current) => setLinkedThemeProfiles(current, event.target.checked))} className={formCheckboxClassName} />桌面与移动保持同步</label></div>
        {!draft.linkedProfiles && <div className="flex flex-wrap gap-2"><div className={formSegmentedClassName}>{(['desktop', 'mobile'] as ThemeDevice[]).map((device) => <button key={device} type="button" aria-pressed={editingDevice === device} onClick={() => setEditingDevice(device)} className={`${formSegmentedOptionClassName} ${editingDevice === device ? 'is-selected' : ''}`.trim()}>{device === 'desktop' ? '桌面端' : '移动端'}</button>)}</div><button type="button" className={secondaryFormButtonClassName} onClick={() => updateDraft((current) => copyThemeProfile(current, editingDevice))}>复制{profileLabel}设置到{editingDevice === 'desktop' ? '移动端' : '桌面端'}</button></div>}
      </section>

      <section className="mt-4 space-y-3 border-t border-[var(--color-border)] pt-3.5">
        <div className="flex items-center justify-between"><div><div className="text-xs font-semibold tracking-wide text-[var(--color-text)]">背景样式</div><div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">{draft.linkedProfiles ? '桌面与移动同步' : `正在编辑${profileLabel}`}</div></div><span className="text-[11px] text-[var(--color-text-tertiary)]">实时预览</span></div>
        <div className="space-y-2"><div className="text-[11px] font-medium text-[var(--color-text-secondary)]">内置背景</div><div className="grid grid-cols-3 gap-2 sm:grid-cols-5"><button type="button" onClick={() => selectBackground('none', null)} className={`h-[60px] rounded-xl border text-xs ${backgroundSelection === 'none:' ? 'border-[var(--color-brand-mark)] ring-2 ring-[var(--color-brand-mark)]/20' : 'border-[var(--color-border)]'} bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]`}>无背景</button>{presetCards.map((preset) => <Tooltip key={preset.id} content={`${preset.label} · 点击应用推荐效果`} asChild><button type="button" aria-label={preset.label} onClick={() => selectBackground('preset', preset.id)} className={`relative h-[60px] overflow-hidden rounded-xl border ${preset.selected ? 'border-[var(--color-brand-mark)] ring-2 ring-[var(--color-brand-mark)]/20' : 'border-[var(--color-border)]'}`} style={{ background: preset.background }}><span className="absolute inset-x-1 bottom-1 rounded-md bg-black/35 px-1 py-0.5 text-[10px] text-white backdrop-blur-sm">{preset.label}</span></button></Tooltip>)}</div></div>
        <div className="space-y-2"><div className="text-[11px] font-medium text-[var(--color-text-secondary)]">自定义图片</div><label className={`${secondaryFormButtonClassName} ui-form-file-button ${profile.backgroundKind === 'asset' ? 'is-selected' : ''} ${uploading ? 'pointer-events-none opacity-60' : ''}`.trim()}><span className="text-lg">＋</span><span>{uploading ? '处理中' : profile.backgroundKind === 'asset' ? '更换图片背景' : '上传图片背景'}</span><span className="text-[10px] font-normal text-[var(--color-text-tertiary)]">自动应用推荐效果</span><input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={uploading} onChange={(event) => void upload(event.target.files?.[0])} /></label></div>
      </section>

      <details className="theme-advanced-settings mt-4 border-t border-[var(--color-border)] pt-3.5">
        <summary className="cursor-pointer text-xs font-semibold tracking-wide text-[var(--color-text)]">高级效果</summary>
        <div className="mt-3 grid gap-5 sm:grid-cols-2">
          <div className="space-y-2.5"><div className="text-xs font-semibold text-[var(--color-text)]">背景处理</div><RangeField label="背景模糊" hint="模糊铺在整个应用底层的背景图片；左侧栏、消息区、右侧预览和输入区都会看到变化，文字与面板本身不会被模糊。" value={profile.blur} min={0} max={24} step={1} suffix="px" onChange={(blur) => updateProfile({ blur })} /><RangeField label="遮罩强度" hint="调整覆盖在全局背景图片上的颜色浓度；数值越高，背景越沉稳，前景文字通常越容易辨认。" value={profile.overlayOpacity} min={0} max={0.75} step={0.01} suffix="%" onChange={(overlayOpacity) => updateProfile({ overlayOpacity })} /><div className="flex items-center justify-between text-xs text-[var(--color-text-secondary)]"><FieldName label="遮罩颜色" hint="改变全局背景图片上方的遮罩色调；它会影响所有透明面板后方的整体氛围，不改变文字颜色。" htmlFor={overlayColorId} /><input id={overlayColorId} type="color" value={profile.overlayColor} onChange={(event) => updateProfile({ overlayColor: event.target.value })} className={formColorClassName} /></div>{profile.backgroundKind === 'asset' && <div className="grid grid-cols-2 gap-2"><div className="grid gap-1.5 text-xs text-[var(--color-text-secondary)]"><FieldName label="背景适配" hint="仅对自定义图片背景生效；控制图片如何铺满整个应用，填满区域可能裁切边缘，完整显示会保留整张图片但可能出现留白。" htmlFor={backgroundFitId} /><select id={backgroundFitId} value={profile.fit} onChange={(event) => updateProfile({ fit: event.target.value as ThemeProfileDto['fit'] })} className={formSelectClassName}><option value="cover">填满区域</option><option value="contain">完整显示</option></select></div><div className="grid gap-1.5 text-xs text-[var(--color-text-secondary)]"><FieldName label="背景位置" hint="仅对自定义图片背景生效；调整图片被裁切时保留的视觉重点，可选择顶部、底部或左右位置。" htmlFor={backgroundPositionId} /><select id={backgroundPositionId} value={profile.position} onChange={(event) => updateProfile({ position: event.target.value as ThemeProfileDto['position'] })} className={formSelectClassName}><option value="center">居中</option><option value="top">顶部</option><option value="bottom">底部</option><option value="left">左侧</option><option value="right">右侧</option></select></div></div>}</div>
          <div className="space-y-2.5"><div className="flex items-center gap-1.5"><div className="text-xs font-semibold text-[var(--color-text)]">面板效果</div><Tooltip coexist content="移动端会将面板不透明度限制为最低 50%，并限制毛玻璃强度，兼顾背景效果、滚动性能和文字辨识度；消息气泡、菜单与弹窗仍保留额外对比度保护。" placement="top"><button type="button" aria-label="面板效果说明" className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--color-border)] text-[10px] font-semibold leading-none text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-text-tertiary)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">?</button></Tooltip></div><RangeField label="面板不透明度" hint="同时调整左侧栏、会话标题与消息区、右侧预览、底部输入区的底色浓度；最低可降到 35%，数值越低，背景越明显。消息气泡、菜单和弹窗会自动保留较高不透明度，保证文字清晰。" value={profile.panelOpacity} min={0.35} max={1} step={0.01} suffix="%" onChange={(panelOpacity) => updateProfile({ panelOpacity })} /><RangeField label="毛玻璃强度" hint="同时模糊左侧栏、中央会话区、右侧预览和底部输入区后方的背景；只处理面板后面的背景，不模糊文字、图标或消息内容。" value={profile.glassBlur} min={0} max={24} step={1} suffix="px" onChange={(glassBlur) => updateProfile({ glassBlur })} /><RangeField label="边框清晰度" hint="统一增强左侧栏分隔线、会话标题和输入区边界、右侧预览边界及内容卡片边框；高档位不仅加深颜色，还会增加约 1px 的视觉厚度。" value={profile.borderStrength} min={0} max={1} step={0.01} suffix="%" onChange={(borderStrength) => updateProfile({ borderStrength })} /></div>
        </div>
      </details>

      {(localError || theme.error) && <FormFeedback message={localError || theme.error} error className="mt-4" />}
      {remoteConflict && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-status-warning)]/35 bg-[var(--color-warning-hover)] px-3 py-2 text-xs text-[var(--color-text-secondary)]"><span>其他设备已更新主题，请先加载最新设置再继续编辑。</span><button type="button" className={secondaryFormButtonClassName} onClick={loadLatestSettings}>加载最新设置</button></div>}
    </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] px-4 py-3 sm:px-5"><Tooltip coexist content="将明暗模式恢复为跟随系统、色彩风格恢复为中性、内容字号恢复为标准，清除桌面和移动端的背景与面板效果，并恢复两端同步；当前只更新预览草稿，保存后才会生效。"><button type="button" className={secondaryFormButtonClassName} disabled={theme.loading} onClick={() => updateDraft(() => createDefaultThemeSettings())}>恢复默认</button></Tooltip><div className={formActionsClassName}><button type="button" className={secondaryFormButtonClassName} disabled={theme.saving} onClick={closeAndRollback}>取消</button><button type="button" className={primaryFormButtonClassName} disabled={theme.saving || uploading || theme.loading || remoteConflict} onClick={() => void save()}>{theme.saving ? '保存中…' : '保存主题'}</button></div></div>
  </>;

  return <>
    {embedded
      ? <div className="theme-surface flex h-full min-h-0 flex-col">{content}</div>
      : <Modal open={open && !minimized} onClose={closeAndRollback} labelledBy="theme-settings-title" contentClassName={contentClass} containerClassName={mobile ? 'items-end p-0' : ''}>{content}</Modal>}
    <ThemePreviewBar open={open && minimized} mobile={mobile} saving={theme.saving} saveDisabled={theme.loading || remoteConflict} conflict={remoteConflict} onRestore={() => setPreviewMinimized(false)} onSave={() => void save()} onCancel={closeAndRollback} />
  </>;
});

export default ThemeSettingsDialog;
