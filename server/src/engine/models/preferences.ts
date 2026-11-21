import type { EngineModelCatalog } from './types.js';
import { isSessionInProgress } from '../../services/session-runtime-status.js';

export type ModelPreferences = { modelId: string | null; reasoningEffort: string | null; serviceTier: string | null };
export function resolveModelPreferenceChange(current: ModelPreferences, next: { modelId: string | null; reasoningEffort?: string | null; serviceTier?: string | null }): ModelPreferences {
  const sameModel = current.modelId === next.modelId;
  return { modelId: next.modelId,
    reasoningEffort: next.reasoningEffort === undefined ? sameModel ? current.reasoningEffort : null : next.reasoningEffort,
    serviceTier: next.serviceTier === undefined ? sameModel ? current.serviceTier : null : next.serviceTier };
}

export function isEnginePreferencesLockedStatus(status: string): boolean {
  return isSessionInProgress(status);
}

export class EnginePreferencesValidationError extends Error {
  constructor(
    readonly code: 'ENGINE_MODEL_NOT_AVAILABLE' | 'ENGINE_REASONING_EFFORT_NOT_AVAILABLE' | 'ENGINE_SERVICE_TIER_NOT_AVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'EnginePreferencesValidationError';
  }
}

export function validateEnginePreferences(
  catalog: EngineModelCatalog,
  preferences: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null },
): void {
  if (preferences.modelId === null) {
    if (preferences.reasoningEffort !== null) {
      throw new EnginePreferencesValidationError(
        'ENGINE_REASONING_EFFORT_NOT_AVAILABLE',
        '自动选择模型时不能单独指定推理强度',
      );
    }
    if (preferences.serviceTier) {
      const defaultModel = catalog.models.find((candidate) => candidate.isDefault);
      if (!defaultModel?.serviceTiers?.length || (preferences.serviceTier !== 'default'
        && !defaultModel.serviceTiers.some((tier) => tier.id === preferences.serviceTier))) {
        throw new EnginePreferencesValidationError('ENGINE_SERVICE_TIER_NOT_AVAILABLE', '所选速度不适用于默认模型');
      }
    }
    return;
  }
  const model = catalog.models.find((candidate) => candidate.id === preferences.modelId);
  if (!model) throw new EnginePreferencesValidationError('ENGINE_MODEL_NOT_AVAILABLE', '所选模型已不可用');
  if (preferences.reasoningEffort !== null
    && !model.reasoning.options.some((option) => option.id === preferences.reasoningEffort)) {
    throw new EnginePreferencesValidationError(
      'ENGINE_REASONING_EFFORT_NOT_AVAILABLE',
      '所选推理强度不适用于该模型',
    );
  }
  if (preferences.serviceTier && (!model.serviceTiers?.length || (preferences.serviceTier !== 'default'
    && !model.serviceTiers.some((tier) => tier.id === preferences.serviceTier)))) {
    throw new EnginePreferencesValidationError('ENGINE_SERVICE_TIER_NOT_AVAILABLE', '所选速度不适用于该模型');
  }
}
