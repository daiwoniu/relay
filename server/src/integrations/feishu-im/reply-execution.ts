import type { MessageModelInfoDto } from '../../contracts/dto.js';
import { ENGINE_DEFINITIONS } from '../../engine/definition.js';
import type { EngineModelCatalog } from '../../engine/models/types.js';
import { getServiceTierChoices } from '../../engine/models/presentation.js';
import type { FeishuEnginePreferences } from './inbound.js';

function executionLine(engine: string, model: string, compactionCount: number | null, effort?: string | null, tier?: string | null) {
  const singleLine = (value: string) => value.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return `引擎：${engine} · 模型：${singleLine(model)} · 强度：${effort ?? '未提供'} · 速度：${tier ?? '未提供'} · 压缩次数：${compactionCount === null ? '不适用' : compactionCount}`;
}

function ordinal(value: string | null | undefined, options: readonly string[]): string | undefined {
  if (!value) return undefined;
  const index = options.indexOf(value);
  return index < 0 ? '档位未知' : `${index + 1}/${options.length}`;
}

export function feishuEngineReplyLine(engineId: FeishuEnginePreferences['engineId'],
  preferences: Omit<FeishuEnginePreferences, 'engineId'> | undefined, compactionCount: number, modelInfo?: MessageModelInfoDto,
  catalog?: EngineModelCatalog) {
  const actual = modelInfo?.engineId === engineId ? modelInfo : undefined;
  const modelId = actual?.effective.id ?? preferences?.modelId;
  const model = actual?.effective.displayName || modelId || '引擎默认';
  const choices = catalog?.engineId === engineId ? catalog.models.find(item => item.id === modelId) : undefined;
  const effort = actual ? actual.effective.reasoningEffort : preferences?.reasoningEffort;
  const tier = actual?.resolvedServiceTier !== undefined ? actual.resolvedServiceTier
    : actual?.serviceTier !== undefined ? actual.serviceTier : preferences?.serviceTier;
  const efforts = choices?.reasoning.supported ? choices.reasoning.options.map(option => option.id) : [];
  const tiers = getServiceTierChoices(choices).map(option => option.id);
  return executionLine(ENGINE_DEFINITIONS[engineId].label, model, compactionCount, ordinal(effort, efforts), ordinal(tier, tiers));
}

export function feishuSummaryReplyLine(model: string) {
  return executionLine('OpenAI API', model, null);
}
