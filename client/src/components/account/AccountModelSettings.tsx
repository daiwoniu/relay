import { useEffect, useState } from 'react';
import type { AuthUser } from '../../api/auth';
import type { EngineModelDto } from '../../generated/relay-contracts';
import ModelSettingsPanel from '../chat/ModelSettingsPanel';
import { reconcileReasoningEffort, reconcileServiceTier } from '../chat/model-settings-presentation';

type Preferences = { modelId: string | null; reasoningEffort: string | null; serviceTier: string | null };
interface Props {
  user: AuthUser;
  models: EngineModelDto[];
  pending: boolean;
  unavailable: boolean;
  onApply: (preferences: Preferences) => void;
}

export default function AccountModelSettings({ user, models, pending, unavailable, onApply }: Props) {
  const saved = { modelId: user.defaultModelId, reasoningEffort: user.defaultReasoningEffort ?? null, serviceTier: user.defaultServiceTier ?? null };
  const [draft, setDraft] = useState<Preferences>(saved);
  useEffect(() => {
    setDraft({ modelId: user.defaultModelId, reasoningEffort: user.defaultReasoningEffort ?? null, serviceTier: user.defaultServiceTier ?? null });
  }, [user.id, user.defaultEngine, user.defaultModelId, user.defaultReasoningEffort, user.defaultServiceTier]);
  const model = models.find(item => item.id === draft.modelId) ?? (!draft.modelId ? models.find(item => item.isDefault) : undefined);
  const normalized = {
    ...draft,
    reasoningEffort: draft.modelId ? reconcileReasoningEffort(model, draft.reasoningEffort).value : null,
    serviceTier: reconcileServiceTier(model, draft.serviceTier).value,
  };
  const invalidSelection = normalized.reasoningEffort !== draft.reasoningEffort || normalized.serviceTier !== draft.serviceTier;
  const changeModel = (modelId: string | null) => {
    const nextModel = models.find(item => item.id === modelId) ?? (!modelId ? models.find(item => item.isDefault) : undefined);
    setDraft({ modelId, reasoningEffort: modelId ? reconcileReasoningEffort(nextModel, draft.reasoningEffort).value : null,
      serviceTier: reconcileServiceTier(nextModel, draft.serviceTier).value });
  };

  return <fieldset disabled={pending || unavailable} className="account-model-settings">
    <ModelSettingsPanel embedded models={models} modelId={draft.modelId} reasoningEffort={normalized.reasoningEffort} serviceTier={normalized.serviceTier}
      applyDisabled={false} submitting={pending} engineId={user.defaultEngine}
      notice={invalidSelection ? '已保存的部分选项不再可用，应用后将恢复为模型默认。' : '调整后点击应用，只影响新会话。'}
      onModelChange={changeModel} onReasoningChange={reasoningEffort => setDraft({ ...draft, reasoningEffort })}
      onServiceTierChange={serviceTier => setDraft({ ...draft, serviceTier })} onCancel={() => setDraft(saved)}
      onApply={() => onApply(normalized)} />
  </fieldset>;
}
