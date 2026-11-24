import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { jsonBody, requestJson } from '../../api/client';
import { featureAction } from '../../analytics/features';
import { feishuBotSaveMode } from '../../../../server/src/analytics/registry.ts';
import { FEISHU_MAX_CONCURRENCY } from '../../../../server/src/contracts/dto.ts';
import FailureNotice from '../ui/FailureNotice';
import Modal from '../ui/Modal';
import ConfirmDialog from '../ui/ConfirmDialog';
import WorkspaceHelpBadge from '../workspace-console/WorkspaceHelpBadge';
import { feishuIdentityLabel } from './feishu-status';
import FeishuConnectionStatus, { type FeishuConnection } from './FeishuConnectionStatus';
import ModelSettingsPanel from '../chat/ModelSettingsPanel';
import DefaultEnginePicker from '../chat/DefaultEnginePicker';
import { ENGINE_PRESENTATION_LIST } from '../../engine/catalog';
import { reconcileReasoningEffort, reconcileServiceTier } from '../chat/model-settings-presentation';
import type { EngineId, EngineModelCatalogDto, EngineModelDto } from '../../generated/relay-contracts';

interface Project { id: string; name: string }
interface SummaryEngine { id: 'codex'; name: string; models: { id: string; name: string; isDefault: boolean }[] }
interface ModelTarget { id: string; name: string; kind: 'group' | 'p2p' }
type ApprovalChoice = 'manual' | 'one_hour' | 'eight_hours' | 'permanent';
type Approval = { choice: ApprovalChoice; expiresAt: number | null };
interface ModelOverride { targetId: string; kind: ModelTarget['kind']; engine: 'bot' | EngineId; model: string | null; reasoningEffort?: string | null; serviceTier?: string | null;
  approval?: Approval; approvalChoice?: ApprovalChoice | null }
type PlatformPreferences = { engineId: EngineId; modelId: string | null; reasoningEffort: string | null; serviceTier: string | null };
const defaultPlatformPreferences: PlatformPreferences = { engineId: 'codex', modelId: null, reasoningEffort: null, serviceTier: null };
const targetKinds = [{ kind: 'p2p', label: '私聊用户' }, { kind: 'group', label: '群聊' }] as const;
const targetKey = (kind: ModelTarget['kind'], id: string) => `${kind}:${id}`;
interface BotSettings {
  id: string; appId: string; name: string; projectId: string; revision: number;
  enabled: boolean; active: boolean; hasAppSecret: boolean; connection: FeishuConnection;
  summary: { model: string; chatIds: string[]; engine: SummaryEngine['id'] | null; hasApiKey: boolean } | null;
  conversationOverrides?: ModelOverride[];
  platformPreferences?: PlatformPreferences | null;
  approval?: Approval | null;
  maxConcurrent?: number | null;
}
interface Configuration { bots: BotSettings[]; projects: Project[]; maxConcurrent: number }
export type BotEditor = BotSettings | 'new' | null;

const endpoint = '/api/admin/feishu-im';
const concurrencyValues = Array.from({ length: FEISHU_MAX_CONCURRENCY }, (_, index) => index + 1);
const configuration = `${endpoint}/configuration`;
const approvalLabels: Record<ApprovalChoice, string> = {
  manual: '按次审核', one_hour: '自动授权 1 小时', eight_hours: '自动授权 8 小时', permanent: '永久自动授权',
};
function approvalExpired(approval?: Approval | null) {
  return approval?.expiresAt != null && approval.expiresAt <= Date.now();
}
type PlatformCatalogs = Partial<Record<EngineId, EngineModelCatalogDto>>;
interface PlatformModels { catalog: EngineModelCatalogDto | null; catalogs?: PlatformCatalogs; supportedEngines?: EngineId[] }

function ApprovalSelect({ value, saved, inherit, onChange }: {
  value?: ApprovalChoice | null; saved?: Approval | null; inherit?: boolean; onChange: (choice: ApprovalChoice | null) => void;
}) {
  const expired = approvalExpired(saved);
  const selected = value !== undefined ? value : expired ? 'manual' : saved?.choice ?? (inherit ? null : 'manual');
  return <label>授权审核
    <select value={selected ?? ''} onChange={event => onChange(event.target.value ? event.target.value as ApprovalChoice : null)}>
      {inherit && <option value="">沿用机器人默认</option>}
      {Object.entries(approvalLabels).map(([choice, label]) => <option key={choice} value={choice}>{label}</option>)}
    </select>
    {expired && value === undefined && <small>上次自动授权已到期。</small>}
  </label>;
}

function PlatformModelFields({ catalogs, supportedEngines, value, onChange, disabled = false, allowAutomaticModel = true }: {
  catalogs: PlatformCatalogs; supportedEngines: EngineId[];
  value: PlatformPreferences; onChange: (preferences: PlatformPreferences) => void; disabled?: boolean; allowAutomaticModel?: boolean;
}) {
  const models: EngineModelDto[] = catalogs[value.engineId]?.models ?? [];
  const label = allowAutomaticModel ? '默认引擎' : '指定引擎';
  return <fieldset className="account-model-settings feishu-platform-fields" disabled={disabled}>
    <div className="conversation-defaults__label"><div>{label}</div></div>
    <DefaultEnginePicker value={value.engineId} pending={false} supportedEngines={supportedEngines} label={label}
      unavailableEngines={supportedEngines.filter(id => !catalogs[id]?.models.length)}
      onChange={engineId => {
        if (engineId === value.engineId) return;
        const options = catalogs[engineId]?.models ?? [];
        onChange({ ...defaultPlatformPreferences, engineId,
          modelId: allowAutomaticModel ? null : (options.find(model => model.isDefault) ?? options[0])?.id ?? null });
      }} />
    {models.length ? <ModelSettingsPanel embedded deferSubmission allowAutomaticModel={allowAutomaticModel} engineId={value.engineId} models={models}
    modelId={value.modelId} reasoningEffort={value.reasoningEffort} serviceTier={value.serviceTier}
    onModelChange={modelId => {
      const model = models.find(item => item.id === modelId) ?? (modelId === null ? models.find(item => item.isDefault) : undefined);
      onChange({ ...value, modelId, reasoningEffort: modelId ? reconcileReasoningEffort(model, value.reasoningEffort).value : null,
        serviceTier: reconcileServiceTier(model, value.serviceTier).value });
    }}
    onReasoningChange={reasoningEffort => onChange({ ...value, reasoningEffort })}
    onServiceTierChange={serviceTier => onChange({ ...value, serviceTier })} /> : null}
  </fieldset>;
}

function SettingsSection({ title, caption, help, children, onOpen }: {
  title: string; caption?: string; help?: string; children: ReactNode; onOpen?: () => void;
}) {
  return <details className="feishu-settings-section" onToggle={event => {
    if (!event.currentTarget.open) return;
    featureAction('feishu_admin', 'configuration_options', 'admin');
    onOpen?.();
  }}>
    <summary>
      <span><strong>{title}</strong>{help && <WorkspaceHelpBadge label={title} content={help} triggerClassName="feishu-help" coexist />}</span>
      {caption && <small>{caption}</small>}
      <span className="feishu-disclosure-chevron" aria-hidden="true" />
    </summary>
    <div className="feishu-settings-section-content">{children}</div>
  </details>;
}

function SettingsDialog({ bot, projects, projectHint, onClose, onSaved }: {
  bot: BotSettings | null; projects: Project[]; projectHint: string | null; onClose: () => void; onSaved: () => void;
}) {
  const titleId = useId();
  const [appId, setAppId] = useState(bot?.appId ?? '');
  const [projectId, setProjectId] = useState(bot?.projectId ?? '');
  const [summary, setSummary] = useState(!!bot?.summary);
  const [platformPreferences, setPlatformPreferences] = useState(bot?.platformPreferences ?? defaultPlatformPreferences);
  const [approvalChoice, setApprovalChoice] = useState<ApprovalChoice>();
  const [maxConcurrent, setMaxConcurrent] = useState(bot?.maxConcurrent ?? null);
  const [platform, setPlatform] = useState<PlatformModels | null>(null);
  const [platformError, setPlatformError] = useState<unknown>(null);
  const [directory, setTargets] = useState<ModelTarget[] | null>(null);
  const [directoryRequested, setDirectoryRequested] = useState(false);
  const targets = directory ?? [];
  const [targetError, setTargetError] = useState<unknown>(null);
  const [overrides, setOverrides] = useState(bot?.conversationOverrides ?? []);
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const [chats, setChats] = useState(bot?.summary?.chatIds ?? []);
  const [error, setError] = useState<unknown>(null);
  const [chatRevision, setChatRevision] = useState(0);
  const [engines, setEngines] = useState<SummaryEngine[] | null>(null);
  const [modelError, setModelError] = useState<unknown>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const [selectedSource, setSelectedSource] = useState(bot?.summary ? bot.summary.engine ?? 'manual' : '');
  const [saving, setSaving] = useState(false);
  const bindingChanged = !!bot && (projectId !== bot.projectId || appId.trim() !== bot.appId);
  const summaryEnabled = summary && !bindingChanged;
  const needsPlatformModels = summaryEnabled;
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<PlatformModels>(`${configuration}/platform-models`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setPlatform(result);
        setPlatformError(null);
      })
      .catch(failure => { if (!controller.signal.aborted) setPlatformError(failure); });
    return () => controller.abort();
  }, [modelRevision]);
  useEffect(() => {
    if (!needsPlatformModels) return;
    const controller = new AbortController();
    void requestJson<{ engines: SummaryEngine[] }>(`${configuration}/summary-models`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setModelError(null); setEngines(result.engines); } })
      .catch(error => { if (!controller.signal.aborted) setModelError(error); });
    return () => controller.abort();
  }, [needsPlatformModels, modelRevision]);
  useEffect(() => {
    if (!bot || bindingChanged || !directoryRequested) return;
    const controller = new AbortController();
    void requestJson<{ targets: ModelTarget[] }>(`${configuration}/model-targets?bot=${encodeURIComponent(bot.id)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setTargetError(null); setTargets(result.targets); } })
      .catch(failure => { if (!controller.signal.aborted) setTargetError(failure); });
    return () => controller.abort();
  }, [bot, bindingChanged, chatRevision, directoryRequested]);
  const platformEngines = (engines ?? []).filter(engine => engine.models.length > 0);
  const source = selectedSource || platformEngines[0]?.id || 'manual';
  const models = platformEngines.find(engine => engine.id === source)?.models ?? [];
  const existingModel = bot?.summary && bot.summary.engine === source ? bot.summary.model : '';
  const groupChoices = [...new Map([...(bot?.summary?.chatIds ?? []).map(id => ({ id, name: id })),
    ...targets.filter(target => target.kind === 'group')].map(chat => [chat.id, chat])).values()];
  const catalogs = platform?.catalogs ?? (platform?.catalog ? { codex: platform.catalog } : {});
  const supportedEngines = platform?.supportedEngines ?? ['codex'];
  const availableTargets = targets.filter(target => !overrides.some(item => item.targetId === target.id && item.kind === target.kind));
  const requestDirectory = () => setDirectoryRequested(true);
  const credentials = <div className="feishu-editor-grid">
    <label>飞书 App ID<input autoComplete="off" value={appId} onChange={event => setAppId(event.target.value)} maxLength={128} required /></label>
    <label>飞书 App Secret<input type="password" name="appSecret" autoComplete="new-password" maxLength={512}
      required={!bot?.hasAppSecret || appId.trim() !== bot.appId} placeholder={bot?.hasAppSecret ? '留空沿用已设置的密钥' : ''} /></label>
  </div>;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const values = new FormData(event.currentTarget);
    const secret = (key: string) => String(values.get(key) ?? '') || undefined;
    const enabled = values.get('enabled') === 'on';
    const mode = feishuBotSaveMode(bot?.enabled, enabled);
    setSaving(true); setError(null);
    try {
      await requestJson(configuration, { method: 'POST', ...jsonBody({
        ...(bot ? { id: bot.id, revision: bot.revision } : {}), appId: appId.trim(), projectId,
        appSecret: secret('appSecret'), enabled,
        summary: summaryEnabled ? { model: String(values.get('model') ?? '').trim(), chatIds: chats,
          ...(source === 'manual' ? { apiKey: secret('apiKey') } : { engine: source }) } : null,
        platformPreferences: bindingChanged ? defaultPlatformPreferences : platformPreferences,
        approvalChoice: bindingChanged ? undefined : approvalChoice,
        maxConcurrent: bindingChanged ? null : maxConcurrent,
        conversationOverrides: bindingChanged ? [] : overrides.map(({ approval: _approval, ...item }) => item),
      }), analytics: { feature: 'feishu_admin', action: 'save_bot', surface: 'admin', mode } });
      onSaved();
    } catch (failure) { setError(failure); }
    finally { setSaving(false); }
  }

  return <Modal open labelledBy={titleId} contentClassName="feishu-editor" closeOnBackdrop={false}
    closeOnEscape={!saving} onClose={() => { if (!saving) onClose(); }}>
    <form className="feishu-settings-form" onSubmit={event => void save(event)} onInvalidCapture={event => {
      if (event.target instanceof HTMLElement) {
        const section = event.target.closest('details');
        if (section) section.open = true;
      }
    }}>
    <header className="feishu-editor-header">
      <h2 id={titleId} tabIndex={-1} data-autofocus>{bot ? '编辑机器人' : '添加机器人'}</h2>
      {bot && <p>{bot.name}</p>}
    </header>
    <div className="feishu-editor-fields">
    {error != null && <div role="alert"><FailureNotice error={error} description="保存机器人失败" /></div>}
    <fieldset className="feishu-editor-sections" disabled={saving}>
      <section className="feishu-editor-block">
      <h3>基本信息</h3>
      <div className="feishu-editor-grid feishu-editor-binding">
      <label>工作区<select value={projectId} onChange={event => setProjectId(event.target.value)}
        aria-describedby={projectHint ? `${titleId}-projects` : undefined} disabled={!projects.length} required>
        <option value="" disabled>选择一个项目</option>
        {projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
      </select></label>
      <label className="feishu-check"><input type="checkbox" name="enabled" defaultChecked={bot?.enabled ?? true} />启用机器人</label>
      </div>
      {projectHint && <p id={`${titleId}-projects`} role="status">{projectHint}</p>}
      </section>
      {!bot && <section className="feishu-editor-block"><h3>飞书应用凭据</h3>{credentials}</section>}
      <section className="feishu-editor-block">
      <h3>默认执行设置</h3>
      <PlatformModelFields catalogs={catalogs} supportedEngines={supportedEngines} disabled={bindingChanged}
        value={bindingChanged ? defaultPlatformPreferences : platformPreferences} onChange={setPlatformPreferences} />
      {!bindingChanged && <div className="feishu-editor-grid">
        <ApprovalSelect value={approvalChoice} saved={bot?.approval} onChange={value => setApprovalChoice(value ?? 'manual')} />
        <label>机器人并发<select value={maxConcurrent ?? ''} onChange={event => setMaxConcurrent(event.target.value ? Number(event.target.value) : null)}>
          <option value="">沿用飞书总并发</option>
          {concurrencyValues.map(value => <option value={value} key={value}>{value}</option>)}
        </select></label>
      </div>}
      {platformError == null && !platform && <p role="status">正在读取引擎模型…</p>}
      {(platformError != null || (platform && !catalogs[platformPreferences.engineId]?.models.length)) && <div className="feishu-toolbar">
        {platformError != null && <FailureNotice error={platformError} description="读取引擎模型失败" />}
        <button type="button" onClick={() => { featureAction('feishu_admin', 'retry_models', 'admin'); setModelRevision(value => value + 1); }}>重试读取模型</button></div>}
      </section>
      {bot && !bindingChanged && <SettingsSection title="私聊与群聊配置" caption={overrides.length ? `已设置 ${overrides.length} 项` : '沿用机器人默认设置'}
        onOpen={requestDirectory}>
        {targetError != null && <FailureNotice error={targetError} description="读取可配置对象失败" />}
        <div className="feishu-override-tools">
          <select aria-label="添加指定对象" disabled={!availableTargets.length} value="" onChange={event => {
            const target = availableTargets.find(candidate => targetKey(candidate.kind, candidate.id) === event.target.value);
            if (!target) return;
            setOverrides(rows => [...rows, { targetId: target.id, kind: target.kind, engine: 'bot', model: null }]);
            setEditingTarget(targetKey(target.kind, target.id));
          }}>
            <option value="">{directory === null && targetError === null ? '正在读取可配置对象…'
              : !availableTargets.length ? '暂无可添加的对象' : '添加私聊用户或群聊'}</option>
            {targetKinds.map(({ kind, label }) => {
              const choices = availableTargets.filter(target => target.kind === kind);
              return choices.length > 0 && <optgroup label={label} key={kind}>{choices.map(target =>
                <option key={target.id} value={targetKey(kind, target.id)}>{feishuIdentityLabel(target.id, target.name, label)}</option>)}</optgroup>;
            })}
          </select>
          <button type="button" onClick={() => {
            featureAction('feishu_admin', 'retry_groups', 'admin'); setChatRevision(value => value + 1);
          }}>刷新对象</button>
        </div>
        {targetKinds.map(({ kind, label }) => {
          const items = overrides.filter(item => item.kind === kind);
          return items.length > 0 && <section className="feishu-override-group" key={kind} aria-label={label}>
            <h3><span className="feishu-override-kind" data-kind={kind}>{label}</span><small>{items.length}</small></h3>
            {items.map(item => {
              const key = targetKey(kind, item.targetId);
              const target = targets.find(candidate => candidate.kind === kind && candidate.id === item.targetId);
              const inheritsModel = item.engine === 'bot' && item.model === null;
              const engineId = inheritsModel ? platformPreferences.engineId : item.engine === 'bot' ? 'codex' : item.engine;
              const engineName = ENGINE_PRESENTATION_LIST.find(engine => engine.id === engineId)?.label;
              const modelName = catalogs[engineId]?.models.find(model => model.id === item.model)?.displayName ?? item.model;
              const expanded = editingTarget === key;
              return <div className="feishu-override-item" key={key}>
                <button type="button" className="feishu-override-toggle" aria-expanded={expanded}
                  onClick={() => {
                    if (!expanded) featureAction('feishu_admin', 'configuration_options', 'admin');
                    setEditingTarget(expanded ? null : key);
                  }}>
                  <strong>{feishuIdentityLabel(item.targetId, target?.name, label)}</strong>
                  <small>{inheritsModel ? '沿用机器人模型' : `${engineName} · ${modelName ?? '自动选模型'}`}</small>
                  <span className="feishu-disclosure-chevron" aria-hidden="true" />
                </button>
                {expanded && <div className="feishu-override-editor">
                  <label className="feishu-check"><input type="checkbox" checked={!inheritsModel} onChange={event => {
                    const custom = event.target.checked;
                    setOverrides(rows => rows.map(row => targetKey(row.kind, row.targetId) === key
                      ? { ...row, engine: custom ? platformPreferences.engineId : 'bot', model: custom ? platformPreferences.modelId : null,
                        reasoningEffort: null, serviceTier: null } : row));
                  }} />单独设置引擎和模型</label>
                  {!inheritsModel && <PlatformModelFields catalogs={catalogs} supportedEngines={supportedEngines}
                    value={{ engineId, modelId: item.model || null, reasoningEffort: item.reasoningEffort ?? null, serviceTier: item.serviceTier ?? null }}
                    onChange={value => setOverrides(rows => rows.map(row => targetKey(row.kind, row.targetId) === key
                      ? { ...row, engine: value.engineId, model: value.modelId, reasoningEffort: value.reasoningEffort, serviceTier: value.serviceTier } : row))} />}
                  <ApprovalSelect value={item.approvalChoice} saved={item.approval} inherit
                    onChange={approvalChoice => setOverrides(rows => rows.map(row => targetKey(row.kind, row.targetId) === key
                      ? { ...row, approvalChoice } : row))} />
                  <button type="button" onClick={() => {
                    setOverrides(rows => rows.filter(row => targetKey(row.kind, row.targetId) !== key));
                    setEditingTarget(null);
                  }}>恢复默认设置</button>
                </div>}
              </div>;
            })}
          </section>;
        })}
      </SettingsSection>}
      {bot && <SettingsSection title="飞书应用凭据" caption={bot.appId}>{credentials}</SettingsSection>}
      {bot && <SettingsSection title="群历史总结" caption={summaryEnabled ? `已开启 · ${chats.length} 个群` : '未开启'}
        help="开启后可逐群选择。选中的群聊共用当前机器人的群总结模型。" onOpen={requestDirectory}>
        {bindingChanged ? <p>更换应用或工作区会清除原群总结设置。</p>
          : <label className="feishu-check"><input type="checkbox" checked={summary} onChange={event => setSummary(event.target.checked)} />启用群历史总结</label>}
        {summaryEnabled && <fieldset className="feishu-summary-groups">
        <legend>适用群聊</legend>
        {groupChoices.length ? <div className="feishu-chat-options">{groupChoices.map(chat => <label className="feishu-check" key={chat.id}>
          <input type="checkbox" value={chat.id} checked={chats.includes(chat.id)} onChange={event => {
            const checked = event.target.checked;
            setChats(items => checked ? [...items, chat.id] : items.filter(id => id !== chat.id));
          }} />{feishuIdentityLabel(chat.id, chat.name, '群聊')}
        </label>)}</div> : targetError == null && <p>{directory ? '把机器人加入群后，刷新可配置对象。' : '正在读取机器人所在群…'}</p>}
        </fieldset>}
        {summaryEnabled && <div className="feishu-summary-model feishu-editor-grid">
        <label>模型来源<select value={source} onChange={event => setSelectedSource(event.target.value)}>
          {platformEngines.map(engine => <option value={engine.id} key={engine.id}>Relay · {engine.name}</option>)}
          {bot?.summary?.engine && !platformEngines.some(engine => engine.id === bot.summary?.engine) &&
            <option value={bot.summary.engine}>Relay · Codex</option>}
          <option value="manual">手动配置 OpenAI API</option>
        </select></label>
        {engines === null && modelError == null && <p role="status">正在读取可用的平台模型…</p>}
        {modelError != null && <div className="feishu-toolbar"><FailureNotice error={modelError} description="读取群总结模型失败" />
          <button type="button" onClick={() => { featureAction('feishu_admin', 'retry_models', 'admin'); setModelRevision(value => value + 1); }}>重试读取模型</button></div>}
        {engines && !platformEngines.length && <p>当前没有可用于群总结的平台模型，可使用手动配置。</p>}
        {source === 'manual' ? <>
          <label>OpenAI 模型 ID<input name="model" defaultValue={bot?.summary?.hasApiKey ? bot.summary.model : ''} required maxLength={128}
            onChange={() => setSelectedSource('manual')} /></label>
          <label>OpenAI API 密钥<input type="password" name="apiKey" autoComplete="new-password" maxLength={512}
            onChange={() => setSelectedSource('manual')} required={!bot?.summary?.hasApiKey}
            placeholder={bot?.summary?.hasApiKey ? '留空沿用已设置的密钥' : ''} /></label>
        </> : <label>平台模型<select name="model" key={source} required defaultValue={existingModel || models.find(model => model.isDefault)?.id || ''}>
          <option value="" disabled>选择一个模型</option>
          {existingModel && !models.some(model => model.id === existingModel) && <option value={existingModel}>{existingModel}（当前配置）</option>}
          {models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}
        </select></label>}
        </div>}
      </SettingsSection>}
    </fieldset>
    </div>
    <footer className="feishu-editor-actions">
      <button type="button" disabled={saving} onClick={onClose}>取消</button>
      <button className="feishu-primary" type="submit" disabled={saving || !projects.length || (summaryEnabled && !chats.length)}>{saving ? '正在保存…' : bot ? '保存配置' : '验证并添加'}</button>
    </footer>
    </form>
  </Modal>;
}

export default function FeishuImSettings({ editor, onEdit, onChanged }: {
  editor: BotEditor; onEdit: (editor: BotEditor) => void; onChanged: () => void;
}) {
  const [data, setData] = useState<Configuration | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const [pauseTarget, setPauseTarget] = useState<BotSettings | null>(null);
  const [feedback, setFeedback] = useState('');
  const [concurrencyError, setConcurrencyError] = useState<unknown>(null);
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<Configuration>(configuration, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(error => { if (!controller.signal.aborted) setError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoadedRevision(revision); });
    return () => controller.abort();
  }, [revision]);

  function refresh() { setError(null); setFeedback(''); setRevision(value => value + 1); }
  function changed(message: string) { refresh(); setFeedback(message); onChanged(); }
  const loading = loadedRevision !== revision;
  const projectHint = data?.projects.length ? null : loading ? '正在读取可管理的 Relay 项目…'
    : !data ? '暂时无法读取 Relay 项目。请关闭弹窗并刷新状态。' : '当前没有可管理的 Relay 项目。请先创建项目或取得项目管理权限。';
  async function pause() {
    if (!pauseTarget) return;
    await requestJson(`${configuration}/pause`, { method: 'POST', ...jsonBody({ id: pauseTarget.id, revision: pauseTarget.revision }),
      analytics: { feature: 'feishu_admin', action: 'pause_bot', surface: 'admin' } });
    setPauseTarget(null);
    changed('机器人已停用');
  }
  async function saveConcurrency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingConcurrency) return;
    const value = Number(new FormData(event.currentTarget).get('maxConcurrent'));
    if (value === data?.maxConcurrent) { setEditingConcurrency(false); return; }
    setSavingConcurrency(true);
    setConcurrencyError(null);
    try {
      const result = await requestJson<{ maxConcurrent: number }>(`${configuration}/concurrency`, {
        method: 'PUT', ...jsonBody({ maxConcurrent: value }),
        analytics: { feature: 'feishu_admin', action: 'save_concurrency', surface: 'admin' },
      });
      setData(current => current && { ...current, maxConcurrent: result.maxConcurrent });
      setEditingConcurrency(false);
      setFeedback('飞书并发已保存');
    } catch (failure) { setConcurrencyError(failure); }
    finally { setSavingConcurrency(false); }
  }
  return <section aria-label="机器人配置" className="feishu-settings">
    {error != null && <FailureNotice error={error} description={data ? '刷新失败，当前显示上次配置' : '读取机器人配置失败'} />}
    {feedback && <p className="feishu-feedback" role="status">{feedback}</p>}
    {editor && <SettingsDialog key={editor === 'new' ? 'new' : editor.id} bot={editor === 'new' ? null : editor}
      projects={data?.projects ?? []} projectHint={projectHint}
      onClose={() => { featureAction('feishu_admin', 'cancel_edit', 'admin'); onEdit(null); }}
      onSaved={() => { onEdit(null); changed(editor === 'new' ? '机器人已添加' : '机器人配置已保存'); }} />}
    <ConfirmDialog open={pauseTarget !== null} title="停用机器人" tone="warning" confirmLabel="确认停用"
      subject={pauseTarget ? { label: '机器人', value: pauseTarget.name } : undefined}
      description="停用后将暂停接收和发送飞书消息。已有记录仍可查看，可通过编辑重新启用。"
      pendingLabel="正在停用…" onCancel={() => { featureAction('feishu_admin', 'cancel_pause', 'admin'); setPauseTarget(null); }} onConfirm={pause} />
    {data && !data.projects.length && <p className="feishu-card">当前没有可管理的 Relay 项目。添加机器人前，请先创建项目或取得项目管理权限。</p>}
    <section className="feishu-card">
      <div className="feishu-section-heading">
        <h2>机器人列表</h2>
        <div className="feishu-concurrency-actions">
          {data && <button type="button" className="feishu-concurrency-toggle" aria-expanded={editingConcurrency} disabled={savingConcurrency}
            onClick={() => {
              if (!editingConcurrency) featureAction('feishu_admin', 'configuration_options', 'admin');
              setConcurrencyError(null); setEditingConcurrency(!editingConcurrency);
            }}>并发 {data.maxConcurrent}<span className="feishu-disclosure-chevron" aria-hidden="true" /></button>}
          <button type="button" onClick={() => { featureAction('feishu_admin', 'refresh', 'admin'); refresh(); }} disabled={loading}>{loading ? '正在读取…' : '刷新状态'}</button>
        </div>
      </div>
      {data && editingConcurrency && <div className="feishu-concurrency-editor">
        <form className="feishu-concurrency-form" key={data.maxConcurrent} onSubmit={saveConcurrency}>
          <label>飞书并发 <select name="maxConcurrent" defaultValue={data.maxConcurrent} disabled={savingConcurrency}>
            {concurrencyValues.map(value => <option value={value} key={value}>{value}</option>)}
          </select></label>
          <WorkspaceHelpBadge label="飞书并发" content="所有飞书机器人共用。同一个聊天按顺序处理。" triggerClassName="feishu-help" />
          <button className="feishu-primary" type="submit" disabled={savingConcurrency || loading}>{savingConcurrency ? '保存中…' : '保存'}</button>
        </form>
        {concurrencyError != null && <FailureNotice error={concurrencyError} description="保存飞书并发失败" />}
      </div>}
      {!data && loading && <p role="status">正在读取机器人及可管理的项目…</p>}
      {data?.bots.length ? data.bots.map(bot => {
        const project = data.projects.find(item => item.id === bot.projectId);
        const engineId = bot.platformPreferences?.engineId ?? 'codex';
        const engineName = ENGINE_PRESENTATION_LIST.find(engine => engine.id === engineId)?.label ?? engineId;
        const approval = approvalExpired(bot.approval) ? 'manual' : bot.approval?.choice ?? 'manual';
        return <article className="feishu-bot-row" key={bot.id}>
          <header className="feishu-bot-heading">
            <div><h3>{bot.name}</h3><p>工作区 · {project?.name ?? bot.projectId}</p></div>
            <FeishuConnectionStatus enabled={bot.enabled} active={bot.active} connection={bot.connection} />
          </header>
          <dl className="feishu-bot-facts">
            <div><dt>引擎和模型</dt><dd>{engineName} · {bot.platformPreferences?.modelId ?? '自动选择模型'}</dd></div>
            <div><dt>审核方式</dt><dd>{approvalLabels[approval]}</dd></div>
            <div><dt>机器人并发</dt><dd>{bot.maxConcurrent ?? '沿用飞书总并发'}</dd></div>
            <div><dt>群历史总结</dt><dd>{bot.summary ? `已开启 · ${bot.summary.chatIds.length} 个群` : '未开启'}</dd></div>
            <div><dt>私聊与群聊配置</dt><dd>{bot.conversationOverrides?.length ? `${bot.conversationOverrides.length} 项单独设置` : '沿用机器人默认设置'}</dd></div>
          </dl>
          <footer className="feishu-bot-footer">
            <div><small>App ID · {bot.appId}</small>{!project && <p>编辑需要此项目的管理权限。</p>}</div>
            <div className="feishu-row-actions">
              <button type="button" disabled={loading || error != null || !project} onClick={() => { featureAction('feishu_admin', 'edit_bot', 'admin'); onEdit(bot); }}>{bot.enabled ? '编辑' : '编辑或启用'}</button>
              {bot.enabled && <button type="button" disabled={loading || error != null} onClick={() => { featureAction('feishu_admin', 'open_pause', 'admin'); setPauseTarget(bot); }}>停用</button>}
            </div>
          </footer>
        </article>; }) : data && <p>还没有机器人。点击页头的「添加机器人」绑定飞书应用和 Relay 项目。</p>}
    </section>
  </section>;
}
