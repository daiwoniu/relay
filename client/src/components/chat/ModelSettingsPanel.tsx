import FailureNotice from '../ui/FailureNotice';
import { useId } from 'react';
import type { EngineId, EngineModelDto } from '../../generated/relay-contracts';
import { buildModelChoices, formatContextWindow, formatReasoningEffortLabel, getServiceTierChoices } from './model-settings-presentation';
import ServiceTierIcon from './ServiceTierIcon';

interface Props {
  embedded?: boolean;
  deferSubmission?: boolean;
  allowAutomaticModel?: boolean;
  models: EngineModelDto[];
  modelId: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  applyDisabled?: boolean;
  submitting?: boolean;
  notice?: string | null;
  error?: string | null;
  engineId?: EngineId | null;
  onModelChange: (modelId: string | null) => void;
  onReasoningChange: (reasoningEffort: string | null) => void;
  onServiceTierChange: (serviceTier: string | null) => void;
  onCancel?: () => void;
  onApply?: () => void;
}

function getReasoningTone(id: string | null): string {
  const normalized = id?.toLowerCase() ?? '';
  if (normalized === 'low' || normalized === 'minimal' || normalized === 'none') return 'low';
  if (normalized === 'medium' || normalized === 'enabled') return 'medium';
  if (normalized === 'high') return 'high';
  if (normalized === 'xhigh') return 'xhigh';
  if (normalized === 'max') return 'max';
  if (normalized === 'ultra') return 'ultra';
  return 'default';
}

export default function ModelSettingsPanel({ embedded = false, deferSubmission = false, allowAutomaticModel = true, models, modelId, reasoningEffort, serviceTier, applyDisabled, submitting, notice, error, engineId, onModelChange, onReasoningChange, onServiceTierChange, onCancel, onApply }: Props) {
  const modelSelectId = useId();
  const isAutomaticModel = modelId === null;
  const selectedModel = models.find((model) => model.id === modelId)
    ?? (isAutomaticModel ? models.find((model) => model.isDefault) : undefined);
  const reasoningOptions = selectedModel?.reasoning.supported ? selectedModel.reasoning.options : [];
  const defaultReasoningId = selectedModel?.reasoning.defaultOptionId;
  const serviceTierChoices = getServiceTierChoices(selectedModel);
  const selectedServiceTier = serviceTier ?? selectedModel?.defaultServiceTier ?? 'default';
  const knownDefaultReasoningIndex = reasoningOptions.findIndex((option) => option.id === defaultReasoningId);
  const reasoningSteps: Array<{ id: string | null; label: string }> = [
    ...(knownDefaultReasoningIndex >= 0 ? [] : [{ id: null, label: '模型默认' }]),
    ...reasoningOptions.map((option) => ({
      ...option,
      label: formatReasoningEffortLabel(option.id, option.label),
    })),
  ];
  const selectedReasoningIndex = reasoningEffort === null
    ? (knownDefaultReasoningIndex >= 0 ? knownDefaultReasoningIndex : 0)
    : Math.max(0, reasoningSteps.findIndex((option) => option.id === reasoningEffort));
  const selectedReasoning = reasoningSteps[selectedReasoningIndex];
  const selectedReasoningTone = getReasoningTone(selectedReasoning?.id ?? null);
  const getReasoningPosition = (index: number) => {
    if (reasoningSteps.length === 1) return '50%';
    const ratio = index / (reasoningSteps.length - 1);
    return `calc(${ratio * 100}% + ${13 - ratio * 26}px)`;
  };

  return (
    <div className={`model-settings-panel${embedded ? ' model-settings-panel--embedded' : ''}`}>
      {!embedded && <div className="model-settings-header sticky top-0">
        <div><div className="font-medium">模型设置</div><small>可先调整，待会话空闲后应用，不影响之前的回复。</small></div>
        <button type="button" onClick={onCancel} aria-label="关闭模型设置">×</button>
      </div>}

      <div className="model-settings-body overflow-y-auto">
        <div className="model-settings-field">
          <label htmlFor={modelSelectId}><b>模型选择</b></label>
          <select id={modelSelectId} aria-label="模型选择" value={modelId ?? ''} onChange={(event) => onModelChange(event.target.value || null)}>
            {modelId && !models.some(model => model.id === modelId) && <option value={modelId} disabled>不可用 · {modelId}</option>}
            {!allowAutomaticModel && !modelId && <option value="" disabled>选择模型</option>}
            {buildModelChoices(models).filter(choice => allowAutomaticModel || choice.id !== null).map((choice) => (
              <option key={choice.id ?? 'default'} value={choice.id ?? ''}>
                {choice.label}{choice.id !== null && choice.isDefault ? '（默认）' : ''}
              </option>
            ))}
          </select>
          {selectedModel && (selectedModel.contextWindow || selectedModel.costLabel) && <small className="model-settings-facts">
            {[formatContextWindow(selectedModel.contextWindow), selectedModel.costLabel].filter(Boolean).join(' · ')}
          </small>}
        </div>

        <div className="model-settings-reasoning">
          <div className="model-settings-reasoning-heading">
            <b>推理强度</b>
            {isAutomaticModel
              ? <span>跟随模型默认</span>
              : selectedReasoning && <span>{selectedReasoning.label}{reasoningEffort === null && <small>模型默认</small>}</span>}
          </div>
          {isAutomaticModel ? <div className="model-settings-reasoning-auto">
            自动选择具体模型时，将使用该模型的默认推理强度。
          </div> : reasoningOptions.length ? <>
            <div className={`model-settings-reasoning-control is-${selectedReasoningTone}`}>
              <div className="model-settings-reasoning-track" aria-hidden="true" />
              <div
                className="model-settings-reasoning-fill"
                aria-hidden="true"
                style={{ width: getReasoningPosition(selectedReasoningIndex) }}
              />
              <div className="model-settings-reasoning-dots" aria-hidden="true">
                {reasoningSteps.map((option, index) => (
                  <i
                    key={option.id ?? 'default'}
                    className={index <= selectedReasoningIndex ? 'is-reached' : undefined}
                    style={{ left: getReasoningPosition(index) }}
                  />
                ))}
              </div>
              <input
                type="range"
                aria-label="推理强度"
                aria-valuetext={`${selectedReasoning?.label ?? ''}${reasoningEffort === null ? '，模型默认' : ''}`}
                min={0}
                max={reasoningSteps.length - 1}
                step={1}
                value={selectedReasoningIndex}
                onChange={(event) => {
                  const nextId = reasoningSteps[Number(event.target.value)]?.id;
                  onReasoningChange(nextId === defaultReasoningId ? null : nextId ?? null);
                }}
              />
            </div>
            <div className="model-settings-reasoning-marks" aria-hidden="true">
              {reasoningSteps.map((option) => {
                const isDefault = option.id === null || option.id === defaultReasoningId;
                return <span key={option.id ?? 'default'} className={isDefault ? 'is-default' : undefined}>{option.label}{isDefault && option.id !== null && <small>默认</small>}</span>;
              })}
            </div>
          </> : <small>当前模型不提供推理强度选项</small>}
        </div>
        {serviceTierChoices.length > 0 && <div className="model-settings-speed">
          <div className="model-settings-speed-heading"><b>速度</b><span>快速模式会增加用量</span></div>
          <div className="model-settings-speed-options" role="group" aria-label="速度">
            {serviceTierChoices.map((tier) => <button key={tier.id} type="button" aria-pressed={selectedServiceTier === tier.id} onClick={() => onServiceTierChange(tier.id)}>
              <ServiceTierIcon tier={tier.id} />{tier.id !== 'default' ? ' ' : ''}{tier.label}
            </button>)}
          </div>
        </div>}
        {notice && <small role="status">{notice}</small>}
        {error && <small role="alert"><FailureNotice error={error} /></small>}
        {error && engineId === 'zcode' && <small role="status">ZCode 模型列表加载失败：请确认 ZCode 桌面应用已启动，或在引擎维护中检查可用性后重试。</small>}
      </div>

      {!deferSubmission && <div className="model-settings-footer sticky bottom-0">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" onClick={onApply} disabled={applyDisabled || submitting}>{submitting ? '应用中…' : applyDisabled ? '任务进行中' : '应用'}</button>
      </div>}
    </div>
  );
}
