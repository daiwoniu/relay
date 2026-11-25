import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { CoreStoragePort } from '../../storage/contracts.js';
import { StorageContractError } from '../../storage/command-boundary.js';
import type { FeishuSettingsRow } from '../../storage/native-feishu-im.js';
import type { EngineModelCatalog } from '../../engine/models/types.js';
import { feishuApprovalChoice, feishuApprovalSetting, feishuBotConfigSchema, feishuConcurrencySchema, feishuConversationOverride, feishuDefaultConcurrency, feishuEnginePreferences, feishuIdentity, feishuModelIdSchema, type FeishuBotConfig } from './inbound.js';
import { expiresAtFor } from '../../services/approval-trust.js';
import type { NativeFeishuConversation } from './native-conversation.js';
import { validateEnginePreferences } from '../../engine/models/preferences.js';
import { isCanonicalWorkspace, resolveFeishuScope } from './config.js';
import { FeishuImReceiver } from './receiver.js';
import { FeishuImWorker } from './worker.js';
import { feishuBotSaveMode } from '../../analytics/registry.js';
import { createFeishuClient, readFeishuBotInfo } from './sdk.js';
import { FeishuSenderDirectory } from './sender-directory.js';

export const feishuSettingsRequest = z.object({
  id: z.string().uuid().optional(), revision: z.number().int().positive().optional(),
  appId: feishuIdentity, projectId: feishuIdentity, appSecret: z.string().min(1).max(512).optional(),
  enabled: z.boolean(),
  summary: z.union([
    z.object({ model: feishuModelIdSchema, apiKey: z.string().min(1).max(512).optional(),
      chatIds: z.array(feishuIdentity).min(1).max(200) }).strict(),
    z.object({ model: feishuModelIdSchema, engine: z.literal('codex'),
      chatIds: z.array(feishuIdentity).min(1).max(200) }).strict(),
  ]).nullable(),
  conversationOverrides: z.array(feishuConversationOverride.omit({ approval: true }).extend({ approvalChoice: feishuApprovalChoice.nullish() })).max(200).optional(),
  platformPreferences: feishuEnginePreferences.optional(),
  approvalChoice: feishuApprovalChoice.optional(), maxConcurrent: feishuConcurrencySchema.nullable().optional(),
}).strict();

type SettingsRequest = z.output<typeof feishuSettingsRequest>;
function savedApproval(choice: z.output<typeof feishuApprovalChoice> | null | undefined, prior: z.output<typeof feishuApprovalSetting> | undefined) {
  if (choice === undefined) return prior;
  if (choice === null) return undefined;
  if (prior?.choice === choice && (prior.expiresAt === null || prior.expiresAt > Date.now())) return prior;
  return { choice, expiresAt: choice === 'manual' ? null : expiresAtFor(choice, Date.now()) };
}
type AdminPrincipal = Parameters<CoreStoragePort['runFeishuAdmin']>[0]['principal'];
type Running = {
  receiver: Pick<FeishuImReceiver, 'start' | 'close' | 'name' | 'status'>;
  worker: Pick<FeishuImWorker, 'start' | 'close'>;
};

export class FeishuImConnectionError extends Error {}
export interface FeishuSummaryPlatform {
  getCatalog(): Promise<EngineModelCatalog>;
  getApiKey(): string | undefined;
}

/** The key lives with the local installation. Database rows and standalone database backups carry ciphertext. */
export class FeishuImSecretStore {
  private key?: Buffer;

  constructor(private readonly filename: string) {}

  private async readKey(create: boolean) {
    if (this.key) return this.key;
    try { this.key = await readFile(this.filename); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('FEISHU_IM_KEY_UNAVAILABLE');
      const key = randomBytes(32);
      const file = await open(this.filename, 'wx', 0o600);
      try { await file.writeFile(key); await file.sync(); }
      finally { await file.close(); }
      this.key = key;
    }
    if (this.key.length !== 32) {
      this.key = undefined;
      throw new Error('FEISHU_IM_KEY_INVALID');
    }
    return this.key;
  }

  async seal(value: string, purpose: string, create = false) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.readKey(create), iv);
    cipher.setAAD(Buffer.from(purpose));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }

  async reveal(value: string, purpose: string) {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', await this.readKey(false), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
}

function publicSettings(row: FeishuSettingsRow) {
  return { id: row.id, appId: row.appId, projectId: row.projectId, name: row.name, revision: row.revision,
    enabled: row.enabled, hasAppSecret: true, summary: row.summaryModel ? {
      model: row.summaryModel, chatIds: row.summaryChatIds, engine: row.summaryEngine, hasApiKey: !!row.summarySecret,
    } : null,
    conversationOverrides: row.conversationOverrides ?? [], platformPreferences: row.platformPreferences ?? null,
    approval: row.approval ?? null, maxConcurrent: row.maxConcurrent ?? null };
}

export class ManagedFeishuIm {
  private readonly entries = new Map<string, { bot: FeishuBotConfig; name: string; enabled: boolean; running?: Running }>();
  private maxConcurrent = feishuDefaultConcurrency;
  private runningTurns = 0;
  private readonly botTurns = new Map<string, number>();
  private readonly senderDirectory: FeishuSenderDirectory;
  private changes: Promise<unknown> = Promise.resolve();
  private started = false;
  private closed = false;
  private readonly secrets: FeishuImSecretStore;

  constructor(private readonly options: {
    port: Pick<CoreStoragePort, 'runFeishuWork' | 'runFeishuAdmin' | 'acceptFeishuInbound'>;
    assertExclusiveWriter: () => Promise<void>; diagnostic: () => void; keyPath: string;
    summaryPlatform?: FeishuSummaryPlatform;
    nativeConversation: Pick<NativeFeishuConversation, 'supportedEngines' | 'catalog' | 'reply' | 'approvals'>;
    identify?: (appId: string, appSecret: string) => Promise<{ openId: string; name: string | null }>;
    createRuntime?: (bot: FeishuBotConfig, acquireTurn: () => (() => void) | null) => Running;
  }) {
    this.secrets = new FeishuImSecretStore(options.keyPath);
    this.senderDirectory = new FeishuSenderDirectory(options);
  }

  private async rows() {
    const result = await this.options.port.runFeishuWork({ action: 'settings' });
    if (result?.kind !== 'settings') throw new Error('FEISHU_IM_SETTINGS_UNAVAILABLE');
    return result.rows;
  }

  bots() { return [...this.entries.values()].map(entry => entry.bot); }
  name(id: string) { const entry = this.entries.get(id); return entry?.running?.receiver.name(id, entry.name) ?? entry?.name ?? id; }
  status(id: string) { return this.entries.get(id)?.running?.receiver.status(id) ?? null; }
  active(id: string) { return !!this.entries.get(id)?.running; }
  enabled(id: string) { return this.entries.get(id)?.enabled === true; }

  async summaryModels() {
    const platform = this.options.summaryPlatform;
    if (!platform?.getApiKey()) return { engines: [] };
    const catalog = await platform.getCatalog();
    return { engines: [{ id: 'codex' as const, name: 'Codex',
      models: catalog.models.filter(model => model.inputModalities.includes('text') && feishuModelIdSchema.safeParse(model.id).success)
        .map(model => ({ id: model.id, name: model.displayName, isDefault: model.isDefault })) }] };
  }

  async platformModels() {
    const platform = this.options.nativeConversation;
    const supportedEngines = platform.supportedEngines;
    const entries = await Promise.all(supportedEngines.map(async id => {
      try { return [id, await platform.catalog(id)] as const; }
      catch { return [id, null] as const; }
    }));
    const catalogs = Object.fromEntries(entries.filter(([, catalog]) => catalog !== null));
    return { supportedEngines, catalogs, catalog: catalogs.codex ?? null };
  }

  async summaryGroups(id: string) {
    const bot = this.entries.get(id)?.bot;
    if (!bot) throw new StorageContractError('INVALID_ARGUMENT');
    return { groups: (await this.modelTargets(id)).targets.filter(item => item.kind === 'group').map(({ id, name }) => ({ id, name })) };
  }

  async approvals(principal: AdminPrincipal, id: string, sequence: number,
    decision?: Parameters<NativeFeishuConversation['approvals']>[3]) {
    const bot = this.entries.get(id)?.bot;
    if (!bot) throw new StorageContractError('NOT_FOUND');
    const scope = await resolveFeishuScope(this.options.port, bot);
    if (!scope) throw new StorageContractError('NOT_FOUND');
    return this.options.nativeConversation.approvals(principal, scope, sequence, decision);
  }

  async modelTargets(id: string, refreshNames = false) {
    const bot = this.entries.get(id)?.bot;
    if (!bot) throw new StorageContractError('INVALID_ARGUMENT');
    const scope = await resolveFeishuScope(this.options.port, bot);
    const result = scope ? await this.options.port.runFeishuWork({ ...scope, action: 'modelTargets' }) : null;
    const targets = result?.kind === 'modelTargets' ? result.targets : [];
    if (refreshNames && scope) {
      const missing = targets.filter(target => {
        if (target.kind !== 'p2p' || target.name !== target.id) return false;
        const entry = this.senderDirectory.current(scope, target.id);
        if (entry?.name) target.name = entry.name;
        return !entry || !!entry.refreshing || entry.expiresAt <= Date.now();
      }).slice(0, 6);
      let client: ReturnType<typeof createFeishuClient> | undefined;
      await Promise.all(missing.map(async target => {
        const entry = this.senderDirectory.lookup(scope, target.id, () => client ??= createFeishuClient(bot.appId, bot.appSecret));
        await entry.refreshing;
        if (entry.name) target.name = entry.name;
      }));
    }
    return { targets };
  }

  private acquireTurn(bot: FeishuBotConfig) {
    const running = this.botTurns.get(bot.id) ?? 0;
    if (this.runningTurns >= this.maxConcurrent || running >= (bot.maxConcurrent ?? this.maxConcurrent)) return null;
    this.runningTurns++;
    this.botTurns.set(bot.id, running + 1);
    return () => {
      this.runningTurns--;
      const remaining = (this.botTurns.get(bot.id) ?? 1) - 1;
      if (remaining > 0) this.botTurns.set(bot.id, remaining);
      else this.botTurns.delete(bot.id);
    };
  }

  saveConcurrency(principal: AdminPrincipal, limit: number) {
    return this.serialize(async () => {
      await this.options.port.runFeishuAdmin({ principal, request: { action: 'settingsConcurrency', maxConcurrent: limit } });
      this.maxConcurrent = limit;
      return { maxConcurrent: limit };
    });
  }

  private async observedGroups(bot: FeishuBotConfig, chatIds?: string[]) {
    const scope = await resolveFeishuScope(this.options.port, bot);
    const observed = scope ? await this.options.port.runFeishuWork({ action: 'settingsGroups', ...scope, chatIds }) : null;
    return observed?.kind === 'settingsGroups' ? observed.chatIds : [];
  }

  async configuration(principal: AdminPrincipal) {
    const result = await this.options.port.runFeishuAdmin({ principal, request: { action: 'settingsList' } });
    return { projects: result.projects ?? [], maxConcurrent: this.maxConcurrent,
      platformModelAvailable: !!this.options.summaryPlatform?.getApiKey(), bots: (await this.rows()).map(row => ({ ...publicSettings(row),
      active: this.active(row.id), connection: this.status(row.id), name: this.entries.has(row.id) ? this.name(row.id) : row.name })) };
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    const runtime = await this.options.port.runFeishuWork({ action: 'runtimeSettings' });
    if (runtime?.kind === 'runtimeSettings') this.maxConcurrent = runtime.maxConcurrent;
    for (const row of await this.rows()) {
      try { await this.apply(row, await this.resolve(row)); }
      catch { this.options.diagnostic(); }
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.changes.then(async () => {
      if (this.closed) throw new StorageContractError('CONFLICT');
      await this.options.assertExclusiveWriter();
      return work();
    });
    this.changes = next.catch(() => undefined);
    return next;
  }

  save(principal: AdminPrincipal, input: SettingsRequest, committed?: (mode: ReturnType<typeof feishuBotSaveMode>) => void) {
    return this.serialize(async () => {
      const { projects } = await this.options.port.runFeishuAdmin({ principal, request: { action: 'settingsList' } });
      if (!projects?.some(project => project.id === input.projectId)) throw new StorageContractError('FORBIDDEN');
      const rows = await this.rows();
      const prior = rows.find(row => row.id === input.id);
      if (input.id ? !prior || prior.revision !== input.revision : input.revision !== undefined) throw new StorageContractError('CONFLICT');
      if (prior && !projects.some(project => project.id === prior.projectId)) throw new StorageContractError('FORBIDDEN');
      if (rows.some(row => row.appId === input.appId && row.id !== input.id)) throw new StorageContractError('CONFLICT');
      const project = await this.options.port.runFeishuWork({ action: 'project', projectId: input.projectId });
      if (project?.kind !== 'project' || !await isCanonicalWorkspace(project.path)) throw new StorageContractError('INVALID_ARGUMENT');
      const id = prior?.id ?? randomUUID();
      const appPurpose = `${id}:${input.appId}:app`;
      const summaryPurpose = `${id}:summary`;
      const appSecret = input.appSecret ?? (prior?.appId === input.appId ? await this.secrets.reveal(prior.secret, appPurpose) : null);
      if (!appSecret) throw new StorageContractError('INVALID_ARGUMENT');
      const summary = input.summary;
      const engine = summary && 'engine' in summary ? summary.engine : null;
      const apiKey = summary && !('engine' in summary) ? summary.apiKey ??
        (prior?.summarySecret ? await this.secrets.reveal(prior.summarySecret, summaryPurpose) : null) : null;
      const runtimeSummary = summary ? (engine ? { model: summary.model, engine } : apiKey ? { model: summary.model, apiKey } : null) : null;
      const sameBinding = !!prior && prior.appId === input.appId && prior.projectId === input.projectId;
      const platformPreferences = input.platformPreferences ?? (sameBinding ? prior?.platformPreferences : undefined);
      const platform = this.options.nativeConversation;
      const getPlatformCatalog = async (engine: Parameters<NativeFeishuConversation['catalog']>[0]) => {
        if (!platform.supportedEngines.includes(engine)) throw new StorageContractError('INVALID_ARGUMENT');
        return platform.catalog(engine);
      };
      const preferencesChanged = input.platformPreferences && (!sameBinding
        || JSON.stringify(input.platformPreferences) !== JSON.stringify(prior?.platformPreferences));
      if (preferencesChanged && input.platformPreferences
        && (input.platformPreferences.engineId !== 'codex' || input.platformPreferences.modelId || input.platformPreferences.reasoningEffort || input.platformPreferences.serviceTier)) {
        try { validateEnginePreferences(await getPlatformCatalog(input.platformPreferences.engineId), input.platformPreferences); }
        catch { throw new StorageContractError('INVALID_ARGUMENT'); }
      }
      const priorOverrides = sameBinding ? prior?.conversationOverrides : undefined;
      const approval = savedApproval(input.approvalChoice, sameBinding ? prior?.approval : undefined);
      const maxConcurrent = input.maxConcurrent === undefined ? (sameBinding ? prior?.maxConcurrent : undefined) : input.maxConcurrent ?? undefined;
      const conversationOverrides = input.conversationOverrides?.map(({ approvalChoice, ...item }) => {
        const overrideApproval = savedApproval(approvalChoice,
          priorOverrides?.find(saved => saved.kind === item.kind && saved.targetId === item.targetId)?.approval);
        return { ...item, ...(overrideApproval ? { approval: overrideApproval } : {}) };
      }) ?? priorOverrides ?? [];
      if (input.conversationOverrides) {
        const distinct = new Set(conversationOverrides.map(item => `${item.kind}:${item.targetId}`));
        if (distinct.size !== conversationOverrides.length || (!sameBinding && distinct.size)) throw new StorageContractError('INVALID_ARGUMENT');
        if (sameBinding && conversationOverrides.length) {
          const { targets } = await this.modelTargets(id);
          const known = new Set([...targets, ...(prior?.conversationOverrides ?? []).map(item => ({ kind: item.kind, id: item.targetId }))]
            .map(item => `${item.kind}:${item.id}`));
          if ([...distinct].some(target => !known.has(target))) throw new StorageContractError('INVALID_ARGUMENT');
          const changed = conversationOverrides.filter(item => !prior?.conversationOverrides?.some(saved =>
            saved.kind === item.kind && saved.targetId === item.targetId && saved.engine === item.engine && saved.model === item.model
            && saved.reasoningEffort === item.reasoningEffort && saved.serviceTier === item.serviceTier));
          try {
            for (const item of changed) {
              if (item.engine === 'bot' && item.model === null) continue;
              const engine = item.engine === 'bot' ? 'codex' : item.engine;
              validateEnginePreferences(await getPlatformCatalog(engine), { modelId: item.model,
                reasoningEffort: item.reasoningEffort ?? null, serviceTier: item.serviceTier ?? null });
            }
          } catch { throw new StorageContractError('INVALID_ARGUMENT'); }
        }
      }
      if (summary && (!runtimeSummary || new Set(summary.chatIds).size !== summary.chatIds.length)) throw new StorageContractError('INVALID_ARGUMENT');
      const bot: FeishuBotConfig = { ...feishuBotConfigSchema.parse({ id, appId: input.appId, appSecret, projectId: input.projectId,
        summaryChatIds: summary?.chatIds ?? [], summary: runtimeSummary ?? undefined,
        platformPreferences, conversationOverrides, approval, maxConcurrent }),
        workspaceName: project.name, workspacePath: project.path };
      if (summary) {
        const observed = await this.observedGroups(bot, summary.chatIds);
        if (observed.length !== summary.chatIds.length) throw new StorageContractError('INVALID_ARGUMENT');
        if (engine && (prior?.summaryEngine !== engine || prior.summaryModel !== summary.model)) {
          const { engines } = await this.summaryModels();
          if (!engines.some(item => item.id === engine && item.models.some(model => model.id === summary.model))) {
            throw new StorageContractError('INVALID_ARGUMENT');
          }
        }
      }
      let name = prior?.name ?? input.appId;
      if (!prior || input.appSecret || prior.appId !== input.appId || (input.enabled && !prior.enabled)) {
        try {
          const identity = await (this.options.identify ?? identifyBot)(input.appId, appSecret);
          name = identity.name ?? input.appId;
        } catch { throw new FeishuImConnectionError('FEISHU_IM_VERIFY_FAILED'); }
      }
      const row: FeishuSettingsRow = { id, appId: input.appId, projectId: input.projectId, name, enabled: input.enabled, revision: prior?.revision ?? 0,
        summaryChatIds: summary?.chatIds ?? [], summaryModel: summary?.model ?? null, summaryEngine: engine,
        secret: await this.secrets.seal(appSecret, appPurpose, rows.length === 0),
        summarySecret: apiKey ? await this.secrets.seal(apiKey, summaryPurpose) : null,
        ...(platformPreferences ? { platformPreferences } : {}), conversationOverrides,
        ...(approval ? { approval } : {}), ...(maxConcurrent === undefined ? {} : { maxConcurrent }) };
      await this.options.assertExclusiveWriter();
      await this.options.port.runFeishuAdmin({ principal, request: { action: 'settingsSave', settings: row } });
      committed?.(feishuBotSaveMode(prior?.enabled, row.enabled));
      await this.apply(row, bot);
      return publicSettings({ ...row, revision: row.revision + 1 });
    });
  }

  pause(principal: AdminPrincipal, id: string, revision: number, committed?: () => void) {
    return this.serialize(async () => {
      await this.options.port.runFeishuAdmin({ principal, request: { action: 'settingsPause', id, revision } });
      committed?.();
      const entry = this.entries.get(id);
      if (entry) {
        const running = entry.running;
        entry.enabled = false;
        entry.running = undefined;
        if (running) await this.stop(running);
      }
      return { updated: true };
    });
  }

  private async resolve(row: FeishuSettingsRow): Promise<FeishuBotConfig> {
    const project = await this.options.port.runFeishuWork({ action: 'project', projectId: row.projectId });
    if (project?.kind !== 'project' || !await isCanonicalWorkspace(project.path)) throw new Error('FEISHU_IM_PROJECT_INVALID');
    const appSecret = await this.secrets.reveal(row.secret, `${row.id}:${row.appId}:app`);
    const summary = row.summaryModel && (row.summaryEngine ? { model: row.summaryModel, engine: row.summaryEngine } :
      row.summarySecret ? { model: row.summaryModel, apiKey: await this.secrets.reveal(row.summarySecret, `${row.id}:summary`) } : undefined);
    return { ...feishuBotConfigSchema.parse({ id: row.id, appId: row.appId, projectId: row.projectId, appSecret,
      summaryChatIds: row.summaryChatIds, summary: summary || undefined,
      platformPreferences: row.platformPreferences, approval: row.approval, maxConcurrent: row.maxConcurrent,
      conversationOverrides: row.conversationOverrides }),
    workspaceName: project.name, workspacePath: project.path };
  }

  private async apply(row: FeishuSettingsRow, bot: FeishuBotConfig) {
    const previous = this.entries.get(row.id)?.running;
    this.entries.set(row.id, { bot, name: row.name, enabled: row.enabled });
    if (previous) await this.stop(previous);
    if (this.closed || !this.started || !row.enabled) return;
    const acquireTurn = () => this.acquireTurn(bot);
    const options = { ...this.options, bots: [bot], acquireTurn, senderDirectory: this.senderDirectory };
    const running = this.options.createRuntime?.(bot, acquireTurn) ?? { receiver: new FeishuImReceiver(options), worker: new FeishuImWorker(options) };
    this.entries.set(row.id, { bot, name: row.name, enabled: row.enabled, running });
    running.receiver.start();
    running.worker.start();
  }

  private async stop(running: Running) {
    await Promise.allSettled([running.receiver.close(), running.worker.close()]);
  }

  async close() {
    this.closed = true;
    this.senderDirectory.close();
    await this.changes;
    await Promise.all([...this.entries.values()].map(entry => entry.running && this.stop(entry.running)));
    this.entries.clear();
  }
}

async function identifyBot(appId: string, appSecret: string) {
  return readFeishuBotInfo(await createFeishuClient(appId, appSecret));
}
