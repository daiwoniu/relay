import type { MessageModelInfoDto } from '../../generated/relay-contracts';
import { reasoningEffortToChinese, serviceTierLabel } from '../chat/model-settings-presentation.ts';

export function modelDetailRows(modelInfo: MessageModelInfoDto) {
  const effort = modelInfo.effective.reasoningEffort;
  const tier = modelInfo.resolvedServiceTier || modelInfo.serviceTier;
  const speed = modelInfo.engineId !== 'codex' ? '未提供'
    : modelInfo.resolvedServiceTier === null ? '未提供'
      : !tier ? '未记录'
      : serviceTierLabel(tier);
  return [
    { label: '模型', value: modelInfo.effective.displayName || modelInfo.effective.id },
    { label: '推理强度', value: effort ? reasoningEffortToChinese(effort) || effort : '未提供' },
    { label: '速度', value: speed },
  ];
}
