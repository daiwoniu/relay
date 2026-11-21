import Tooltip from '../ui/Tooltip';
import {featureAction} from '../../analytics/features';
import { useRef, useState } from 'react';
import type { EngineId, EngineModelDto } from '../../generated/relay-contracts';
import Popover from '../ui/Popover';
import ModelSettingsPanel from './ModelSettingsPanel';
import { getModelPreferenceLabel, isAcceleratedServiceTier, serviceTierLabel, reconcileReasoningEffort, reconcileServiceTier } from './model-settings-presentation';
import ServiceTierIcon from './ServiceTierIcon';

interface Props {
  models: EngineModelDto[];
  modelId: string | null;
  reasoningEffort: string | null;
  serviceTier?: string | null;
  loading?: boolean;
  catalogError?: string;
  applyDisabled: boolean;
  isMobile: boolean;
  engineId?: EngineId | null;
  onOpen: () => void;
  onApply: (value: { modelId: string | null; reasoningEffort: string | null; serviceTier: string | null }) => Promise<void>;
}

export default function ModelSettingsControl({ models, modelId, reasoningEffort, serviceTier = null, loading = false, catalogError, applyDisabled, isMobile, engineId, onOpen, onApply }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [open, setOpen] = useState(false);
  const [draftModelId, setDraftModelId] = useState(modelId);
  const [draftReasoning, setDraftReasoning] = useState(reasoningEffort);
  const [draftServiceTier, setDraftServiceTier] = useState(serviceTier);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const label = getModelPreferenceLabel(modelId, reasoningEffort, models);
  const selectedModel = models.find((model) => model.id === modelId) ?? models.find((model) => model.isDefault);
  const effectiveServiceTier = serviceTier ?? selectedModel?.defaultServiceTier ?? 'default';
  const isFast = isAcceleratedServiceTier(selectedModel, effectiveServiceTier);
  const speedLabel = serviceTierLabel(effectiveServiceTier, selectedModel?.serviceTiers?.find((tier) => tier.id === effectiveServiceTier)?.label);

  const close = () => { if (!submitting) setOpen(false); };
  const show = () => {featureAction('composer','open_model_settings','composer');
    setDraftModelId(modelId); setDraftReasoning(reasoningEffort); setDraftServiceTier(serviceTier); setNotice(null); setError(null);
    setAnchor(buttonRef.current?.getBoundingClientRect() ?? null); setOpen(true); onOpen();
  };
  const changeModel = (nextModelId: string | null) => {
    if (nextModelId === null) {
      setDraftModelId(null); setDraftReasoning(null);
      const defaultModel = models.find((item) => item.isDefault);
      setDraftServiceTier(reconcileServiceTier(defaultModel, draftServiceTier).value);
      setNotice(null);
      return;
    }
    const model = models.find((item) => item.id === nextModelId) ?? models.find((item) => item.isDefault);
    const next = reconcileReasoningEffort(model, draftReasoning);
    const nextTier = reconcileServiceTier(model, draftServiceTier);
    setDraftModelId(nextModelId); setDraftReasoning(next.value);
    setDraftServiceTier(nextTier.value);
    setNotice(next.changed ? '该模型不支持原推理强度，已恢复为模型默认值。'
      : nextTier.changed ? '该模型不支持原速度，已恢复为模型默认值。' : null);
  };
  const apply = async () => {
    setSubmitting(true); setError(null);
    try { await onApply({ modelId: draftModelId, reasoningEffort: draftReasoning, serviceTier: draftServiceTier }); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '模型设置保存失败'); }
    finally { setSubmitting(false); }
  };
  const panel = <ModelSettingsPanel models={models} modelId={draftModelId} reasoningEffort={draftReasoning} serviceTier={draftServiceTier} applyDisabled={applyDisabled} submitting={submitting} notice={notice} error={error || catalogError} engineId={engineId} onModelChange={changeModel} onReasoningChange={setDraftReasoning} onServiceTierChange={setDraftServiceTier} onCancel={close} onApply={apply} />;

  return (
    <>
      <button ref={buttonRef} type="button" onClick={show} aria-haspopup="dialog" aria-expanded={open} aria-label={`切换模型，当前${label}${isFast ? `，${speedLabel}模式` : ''}`} className="composer-compact-trigger model-settings-trigger group">
        <span className="min-w-0 truncate whitespace-nowrap font-medium">{loading && !models.length ? '模型加载中…' : label}</span>
        {isFast && <Tooltip content={speedLabel} asChild><span className="model-settings-speed-indicator" aria-hidden="true"><ServiceTierIcon tier={effectiveServiceTier} /></span></Tooltip>}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="model-settings-chevron" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Popover open={open} anchorRect={anchor} onClose={close} placement="top" mobile={isMobile} mobilePresentation="sheet" label="模型设置" className={isMobile ? '' : 'model-settings-popover'} desktopStyle={{ maxHeight: 'min(36rem, calc(100vh - 1rem))' }}>{panel}</Popover>
    </>
  );
}
