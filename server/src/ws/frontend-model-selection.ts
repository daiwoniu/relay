import type { SendCommand } from '../contracts/index.js';
import type { Session } from '../db/query-types.js';
import { defaultEngineSystem } from '../engine/default-system.js';
import { EnginePreferencesValidationError, validateEnginePreferences } from '../engine/models/preferences.js';
import type { EngineId } from '../engine/types.js';
import type { MessageMetadata } from '../message-metadata.js';
import { engineStatusService } from '../system/engine-status.js';
import { ensureCodexProcessReady } from '../system/codex-lifecycle.js';
import type { SessionRuntime } from '../engine/runtime.js';

export function resolveSendEnginePreferences(session: Session, message: SendCommand) {
  return session.engine_bound
    ? {
      modelId: session.selected_model_id ?? null,
      reasoningEffort: session.selected_reasoning_effort ?? null,
      serviceTier: session.selected_service_tier ?? null,
      expectedRevision: session.engine_preferences_revision ?? 0,
    }
    : {
      modelId: message.enginePreferences?.modelId ?? null,
      reasoningEffort: message.enginePreferences?.reasoningEffort ?? null,
      serviceTier: message.enginePreferences?.serviceTier ?? null,
      expectedRevision: message.enginePreferences?.revision ?? 0,
    };
}

export function getPersistedEnginePreferences(session?: Session) {
  return {
    modelId: session?.selected_model_id ?? null,
    reasoningEffort: session?.selected_reasoning_effort ?? null,
    serviceTier: session?.selected_service_tier ?? null,
  };
}

export async function loadTurnModelCatalogSnapshot(
  engineId: EngineId,
  preferences: ReturnType<typeof getPersistedEnginePreferences>,
  options: {validate?:boolean} = {},
): Promise<{
  displayNames: Record<string, string>;
  modelDefaults: Record<string, { reasoningEffort?: string; serviceTier?: string | null }>;
  defaultModelId: string | null;
}> {
  if (engineId !== 'codex' && !preferences.modelId) return { displayNames: {}, modelDefaults: {}, defaultModelId: null };
  const needsDefaults = engineId === 'codex' && (
    preferences.modelId === null || preferences.reasoningEffort === null || preferences.serviceTier === null
  );
  let catalog;
  try {
    catalog = await defaultEngineSystem.modelCatalog.get(engineId, { refresh: needsDefaults });
  } catch (error) {
    if(options.validate)throw new Error('无法确认本轮模型配置，请稍后重试',{cause:error});
    if (needsDefaults) throw new Error('无法确认本轮默认配置，请稍后重试', { cause: error });
    return { displayNames: {}, modelDefaults: {}, defaultModelId: null };
  }
  if (catalog.stale && needsDefaults) throw new Error('无法确认本轮默认配置，请稍后重试');
  if(options.validate)validateEnginePreferences(catalog,preferences);
  if (needsDefaults && catalog.configurationRead !== true) throw new Error('无法确认本轮默认配置，请稍后重试');
  const displayNames = Object.fromEntries(catalog.models.map((model) => [model.id, model.displayName]));
  if (engineId !== 'codex') return { displayNames, modelDefaults: {}, defaultModelId: null };
  const modelDefaults: Record<string, { reasoningEffort?: string; serviceTier?: string | null }> = Object.fromEntries(
    catalog.models.map((model) => [model.id, {
      ...(model.reasoning.defaultOptionId ? { reasoningEffort: model.reasoning.defaultOptionId } : {}),
      serviceTier: model.defaultServiceTier || (model.serviceTiers?.length ? 'default' : null),
    }]),
  );
  const configured = catalog.configuredDefaults;
  if (configured?.modelId && !modelDefaults[configured.modelId]) {
    modelDefaults[configured.modelId] = {
      ...(configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {}),
      serviceTier: configured.serviceTier ?? null,
    };
  }
  const defaultModelId = configured?.modelId ?? catalog.models.find((model) => model.isDefault)?.id ?? null;
  if (preferences.modelId === null && !defaultModelId) throw new Error('无法确认本轮默认模型，请稍后重试');
  return {
    displayNames,
    modelDefaults,
    defaultModelId,
  };
}

export async function validateSendEnginePreferences(
  engineId: EngineId,
  preferences: ReturnType<typeof resolveSendEnginePreferences>,
  requireAvailability: boolean,
): Promise<void> {
  if (engineId === 'codex') await ensureCodexProcessReady();
  if (requireAvailability) {
    const status = (await engineStatusService.getSnapshot()).engines.find((candidate) => candidate.id === engineId);
    if (!status?.available) throw new Error(status?.message || '所选 AI 引擎当前不可用');
  }
  if (preferences.modelId === null && preferences.reasoningEffort !== null) {
    throw new EnginePreferencesValidationError(
      'ENGINE_REASONING_EFFORT_NOT_AVAILABLE',
      '自动选择模型时不能单独指定推理强度',
    );
  }
  if (preferences.modelId !== null || preferences.serviceTier) {
    validateEnginePreferences(await defaultEngineSystem.modelCatalog.get(engineId), preferences);
  }
}

export function buildRuntimeMessageMetadata(
  runtime: SessionRuntime,
  metadata: Omit<MessageMetadata, 'modelInfo'>,
): MessageMetadata {
  return {
    ...metadata,
    ...(runtime.turnModelSnapshot?.modelInfo ? { modelInfo: runtime.turnModelSnapshot.modelInfo } : {}),
  };
}

export { EnginePreferencesValidationError };
