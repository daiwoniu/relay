export function serviceTierLabel(id: string, fallback?: string) {
  const label = ({ default: '标准', priority: '快速', fast: '快速', ultrafast: '极速' } as Record<string, string>)[id] || fallback || id;
  return label === id ? id : `${label}（${id}）`;
}

export function getServiceTierChoices(model: { serviceTiers?: readonly { id: string; label: string }[] } | undefined) {
  if (!model?.serviceTiers?.length) return [];
  const choices = new Map([['default', { id: 'default', label: serviceTierLabel('default') }]]);
  for (const tier of model.serviceTiers) {
    if (!choices.has(tier.id)) choices.set(tier.id, { id: tier.id, label: serviceTierLabel(tier.id, tier.label) });
  }
  return [...choices.values()];
}

export function reasoningEffortToChinese(value: string, fallbackLabel?: string): string {
  return ({ low: '低', medium: '中等', high: '高', xhigh: '超高', max: '最高', ultra: '极致' } as Record<string, string>)[value.toLowerCase()] || fallbackLabel || value;
}
