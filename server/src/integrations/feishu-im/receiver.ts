import type { Client, WSClient } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { CoreStoragePort } from '../../storage/contracts.js';
import { feishuBindingId, feishuIdentity, normalizeFeishuInbound, type FeishuBotConfig } from './inbound.js';
import { feishuSdk, feishuLogger, readFeishuBotInfo } from './sdk.js';
import { feishuCardCallback } from './context-card.js';

const groupEvent = z.object({ app_id: feishuIdentity, tenant_key: feishuIdentity, chat_id: feishuIdentity,
  name: z.string().trim().max(160).optional(), create_time: z.string().regex(/^\d{10,13}$/).optional() });

export class FeishuImReceiver {
  private readonly connections = new Map<string, { client: WSClient; name: string | null }>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly receipts = new Set<Promise<void>>();
  private closed = false;
  private started = false;

  constructor(private readonly options: {
    bots: readonly FeishuBotConfig[];
    port: Pick<CoreStoragePort, 'acceptFeishuInbound' | 'runFeishuWork'>;
    assertExclusiveWriter: () => Promise<void>;
    diagnostic: () => void;
  }) {}

  start() {
    if (this.closed || this.started) return;
    this.started = true;
    void feishuSdk().then(({ Client, WSClient, EventDispatcher, DefaultCache, httpInstance }) => {
      if (this.closed) return;
      for (const bot of this.options.bots) {
        const client = new Client({ appId: bot.appId, appSecret: bot.appSecret, logger: feishuLogger, httpInstance, cache: new DefaultCache() });
        const connection = new WSClient({ appId: bot.appId, appSecret: bot.appSecret, logger: feishuLogger, httpInstance, onError: this.options.diagnostic });
        const entry: { client: WSClient; name: string | null } = { client: connection, name: null };
        this.connections.set(bot.id, entry);
        let identity: Promise<string> | undefined;
        const identify = () => identity ??= readFeishuBotInfo(client).then(info => {
          entry.name = info.name;
          return info.openId;
        }).catch(error => { identity = undefined; throw error; });
        const eventDispatcher = new EventDispatcher({ logger: feishuLogger }).register({
          'im.message.receive_v1': (event: unknown) => this.receive(bot, identify, event, client.im.messageReaction),
          'im.chat.member.bot.added_v1': (event: unknown) => this.receiveMembership(bot, event, true),
          'im.chat.member.bot.deleted_v1': (event: unknown) => this.receiveMembership(bot, event, false),
          'card.action.trigger': (event: unknown) => this.receiveCard(bot, event),
        });
        void connection.start({ eventDispatcher }).catch(this.options.diagnostic);
        void identify().catch(this.options.diagnostic);
        const sync = this.syncGroups(bot, client).catch(this.options.diagnostic).finally(() => this.pending.delete(sync));
        this.pending.add(sync);
      }
    }).catch(this.options.diagnostic);
  }

  status(botId: string) {
    return this.connections.get(botId)?.client.getConnectionStatus() ?? null;
  }

  name(botId: string, fallback = botId) {
    return this.connections.get(botId)?.name ?? fallback;
  }

  async receive(bot: FeishuBotConfig, identify: () => Promise<string>, event: unknown,
    reactions?: Pick<Client['im']['messageReaction'], 'create'>): Promise<void> {
    if (this.closed) throw new Error('FEISHU_IM_RECEIVER_CLOSED');
    const work = (async () => {
      const inbound = normalizeFeishuInbound(bot, await identify(), event);
      if (!inbound) return;
      await this.options.assertExclusiveWriter();
      const result = await this.options.port.acceptFeishuInbound({ inbound, workspacePath: bot.workspacePath });
      if (result === 'received' && reactions && !this.closed && this.receipts.size < 4) {
        const receipt = this.addReceiptReaction(reactions, inbound).catch(() => undefined).finally(() => this.receipts.delete(receipt));
        this.receipts.add(receipt);
      }
    })();
    this.pending.add(work);
    try { await work; }
    catch { this.options.diagnostic(); throw new Error('FEISHU_IM_RECEIVE_NOT_COMMITTED'); }
    finally { this.pending.delete(work); }
  }

  private async addReceiptReaction(reactions: Pick<Client['im']['messageReaction'], 'create'>,
    { botId, tenantKey, messageId }: NonNullable<ReturnType<typeof normalizeFeishuInbound>>) {
    await this.options.assertExclusiveWriter();
    if (this.closed) return;
    try {
      await reactions.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: 'Get' } } });
    } finally {
      await this.options.port.runFeishuWork({ action: 'finishReceiptAttempt', botId, tenantKey, messageId });
    }
  }

  async close() {
    this.closed = true;
    for (const { client } of this.connections.values()) client.close({ force: true });
    this.connections.clear();
    await Promise.allSettled([...this.pending, ...this.receipts]);
  }

  async receiveMembership(bot: FeishuBotConfig, event: unknown, joined: boolean) {
    if (this.closed) return;
    const parsed = groupEvent.safeParse(event);
    if (!parsed.success || parsed.data.app_id !== bot.appId) return;
    const { tenant_key, chat_id, name, create_time } = parsed.data;
    const changedAt = create_time ? Number(create_time) * (create_time.length === 10 ? 1000 : 1) : Date.now();
    const work = this.writeMembership(bot, tenant_key, chat_id, name, joined, changedAt);
    this.pending.add(work);
    try { await work; } finally { this.pending.delete(work); }
  }

  private async writeMembership(bot: FeishuBotConfig, tenantKey: string, chatId: string, name: string | undefined, joined: boolean, changedAt: number) {
    const cleanName = name?.trim().slice(0, 160);
    await this.options.assertExclusiveWriter();
    await this.options.port.runFeishuWork({ action: 'groupMembership', botId: feishuBindingId(bot), tenantKey, chatId,
      projectId: bot.projectId, workspacePath: bot.workspacePath, joined, changedAt, ...(cleanName ? { name: cleanName } : {}) });
  }

  private async syncGroups(bot: FeishuBotConfig, client: Client) {
    const changedAt = Date.now();
    const binding = await this.options.port.runFeishuWork({ action: 'tenant', botId: feishuBindingId(bot) });
    const groups: NonNullable<NonNullable<Awaited<ReturnType<Client['im']['chat']['list']>>['data']>['items']> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4 && !this.closed; page++) {
      const result = await client.im.chat.list({ params: { page_size: 100, ...(cursor ? { page_token: cursor } : {}) } });
      if (result.code !== 0 || !result.data) return;
      groups.push(...result.data.items ?? []);
      cursor = result.data.has_more ? result.data.page_token : undefined;
      if (!cursor) break;
    }
    const internalTenants = new Set(groups.filter(group => group.external === false && feishuIdentity.safeParse(group.tenant_key).success)
      .map(group => group.tenant_key!));
    const tenantKey = binding?.kind === 'tenant' ? binding.tenantKey : internalTenants.size === 1 ? [...internalTenants][0] : undefined;
    if (!tenantKey) return;
    for (const group of groups) {
      if (this.closed) return;
      if (!feishuIdentity.safeParse(group.chat_id).success || group.chat_mode === 'p2p' || (group.chat_status && group.chat_status !== 'normal')) continue;
      await this.writeMembership(bot, tenantKey, group.chat_id!, group.name, true, changedAt);
    }
  }

  async receiveCard(bot: FeishuBotConfig, event: unknown) {
    if (this.closed) throw new Error('FEISHU_IM_RECEIVER_CLOSED');
    const parsed = feishuCardCallback.safeParse(event);
    const unavailable = { toast: { type: 'warning', content: '这个按钮可能已过期，或需要由提问人操作。' } };
    if (!parsed.success || parsed.data.app_id !== bot.appId) return unavailable;
    const data = parsed.data;
    const value = data.action.value;
    const work = (async () => {
      await this.options.assertExclusiveWriter();
      const request = { botId: feishuBindingId(bot), tenantKey: data.tenant_key,
        workspacePath: bot.workspacePath, projectId: bot.projectId, id: value.id, chatId: data.context.open_chat_id,
        messageId: data.context.open_message_id, senderId: data.operator.open_id,
      };
      return this.options.port.runFeishuWork(value.relay === 'reply-file' ? { ...request, action: 'requestReplyFile' }
        : { ...request, action: 'cardAction', choice: value.choice });
    })();
    this.pending.add(work);
    try {
      const result = await work;
      if (value.relay === 'reply-file') {
        const state = result?.kind === 'replyFileRequest' ? result.state : 'unavailable';
        const content = {
          queued: '已受理，附件将发送到当前会话。', sending: '附件正在发送。', sent: '附件已发送。',
          unknown: '暂时无法确认附件是否已发送，请查看会话。', unavailable: '文件已变更或当前无法获取，请重新生成。',
        }[state];
        return { toast: { type: state === 'unknown' || state === 'unavailable' ? 'warning' : 'info', content } };
      }
      if (result?.kind !== 'cardAccepted') return unavailable;
      return { toast: { type: 'info', content: result.duplicate ? '已收到此卡片的操作。' : '已收到，处理结果会在这里回复。' } };
    } catch {
      this.options.diagnostic();
      return { toast: { type: 'error', content: '暂时无法受理，请稍后重试。' } };
    } finally { this.pending.delete(work); }
  }
}
