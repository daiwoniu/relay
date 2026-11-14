import type { EngineModelDto } from '../../generated/relay-contracts';

export interface ModelChoice {
  id: string | null;
  label: string;
  isDefault: boolean;
  model?: EngineModelDto;
}

export function buildModelChoices(models: EngineModelDto[]): ModelChoice[] {
  const defaultModel = models.find((model) => model.isDefault);
  const duplicateNames = new Set(models
    .filter((model, index) => models.findIndex((candidate) => candidate.displayName === model.displayName) !== index)
    .map((model) => model.displayName));
  const getLabel = (model: EngineModelDto) => duplicateNames.has(model.displayName)
    ? `${model.displayName} · ${model.id}`
    : model.displayName;
  return [
    {
      id: null,
      label: defaultModel ? `跟随默认 · ${getLabel(defaultModel)}` : '跟随引擎默认',
      isDefault: true,
      model: defaultModel,
    },
    ...models.map((model) => ({ id: model.id, label: getLabel(model), isDefault: model.isDefault, model })),
  ];
}

export function formatContextWindow(value?: number): string | null {
  if (!value) return null;
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M 上下文`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K 上下文`;
  return `${value} 上下文`;
}

export function reconcileReasoningEffort(model: EngineModelDto | undefined, value: string | null) {
  if (value === null) return { value: null, changed: false };
  if (!model || !model.reasoning.supported || model.reasoning.options.length === 0) {
    return { value: null, changed: value !== null };
  }
  if (value && model.reasoning.options.some((option) => option.id === value)) {
    return { value, changed: false };
  }
  return { value: null, changed: true };
}

export function getFastServiceTier(model: EngineModelDto | undefined) {
  const fastTiers = model?.serviceTiers?.filter((tier) => tier.id === 'priority' || tier.id === 'fast') ?? [];
  return fastTiers.find((tier) => tier.id === model?.defaultServiceTier) ?? fastTiers[0] ?? null;
}

export function isFastServiceTier(model: EngineModelDto | undefined, value: string | null) {
  return Boolean(value && model?.serviceTiers?.some((tier) => tier.id === value && (tier.id === 'priority' || tier.id === 'fast')));
}

export function reconcileServiceTier(model: EngineModelDto | undefined, value: string | null) {
  if (value === null) return { value: null, changed: false };
  const fastTier = getFastServiceTier(model);
  if (fastTier && (value === 'default' || isFastServiceTier(model, value))) return { value, changed: false };
  return { value: null, changed: true };
}

export function getModelPreferenceLabel(modelId: string | null, reasoningEffort: string | null, models: EngineModelDto[]) {
  const model = modelId ? models.find((item) => item.id === modelId) : undefined;
  const defaultModel = models.find((item) => item.isDefault);
  const effectiveModel = model ?? (modelId ? undefined : defaultModel);
  const modelLabel = model?.displayName || (modelId ? modelId : defaultModel ? `${defaultModel.displayName}（默认）` : '引擎默认');
  const reasoningOption = effectiveModel?.reasoning.options.find((option) => option.id === reasoningEffort);
  const reasoningLabel = reasoningEffort ? reasoningEffortToChinese(reasoningEffort, reasoningOption?.label) : null;
  return reasoningLabel ? `${modelLabel} · ${reasoningLabel}` : modelLabel;
}

export function formatReasoningEffortLabel(value: string, fallbackLabel?: string): string {
  const normalized = value.toLowerCase();
  const chinese = reasoningEffortToChinese(normalized);
  if (chinese !== normalized) return `${chinese} (${normalized})`;
  if (fallbackLabel && fallbackLabel !== value) return `${fallbackLabel} (${value})`;
  return fallbackLabel || value;
}

export function reasoningEffortToChinese(value: string, fallbackLabel?: string): string {
  return ({ low: '低', medium: '中等', high: '高', xhigh: '超高', max: '最高', ultra: '极致' } as Record<string, string>)[value.toLowerCase()] || fallbackLabel || value;
}
