import type { Client } from '@larksuiteoapi/node-sdk';
import type { CoreStoragePort } from '../../storage/contracts.js';
import type { FeishuPending, FeishuWork } from '../../storage/native-feishu-im.js';
import { feishuBindingId, feishuOverrideFor, feishuPolicyKey, type FeishuBotConfig } from './inbound.js';
import { isCanonicalWorkspace, resolveFeishuScope } from './config.js';
import { createFeishuClient } from './sdk.js';
import { FeishuSenderDirectory, type SenderName } from './sender-directory.js';
import { isSummaryRequest, summarizeFeishuHistory } from './history-summary.js';
import { buildFeishuReplyPayload, feishuContextCommandReply } from './context-card.js';
import type { FeishuSummaryPlatform } from './managed-config.js';
import type { NativeFeishuConversation } from './native-conversation.js';
import { recordTrustedResult } from '../../analytics/command-collector.js';

const senderNameWaitMs = 300;

export class FeishuImWorker {
  private readonly clients = new Map<string, Client>();
  private readonly senderDirectory: FeishuSenderDirectory;
  private readonly recovered = new Set<string>();
  private readonly active = new Map<string, Map<string, Promise<void>>>();
  private readonly receiptCompletions = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private closed = false;
  private readonly stopSignal = new AbortController();

  constructor(private readonly options: {
    bots: readonly FeishuBotConfig[];
    port: Pick<CoreStoragePort, 'runFeishuWork'>;
    assertExclusiveWriter: () => Promise<void>;
    diagnostic: () => void;
    summaryPlatform?: FeishuSummaryPlatform;
    nativeConversation: Pick<NativeFeishuConversation, 'reply'>;
    acquireTurn: () => (() => void) | null;
    senderDirectory?: FeishuSenderDirectory;
  }) { this.senderDirectory = options.senderDirectory ?? new FeishuSenderDirectory(options); }

  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      if (this.pending) return;
      this.pending = this.tick().catch(this.options.diagnostic).finally(() => { this.pending = undefined; });
    }, 800);
    this.timer.unref();
  }

  private async tick() {
    await this.options.assertExclusiveWriter();
    for (const bot of this.options.bots) {
      if (this.closed) return;
      await this.process(bot).catch(() => { this.recovered.delete(bot.id); this.options.diagnostic(); });
    }
  }

  private async process(bot: FeishuBotConfig) {
    const scope = await resolveFeishuScope(this.options.port, bot);
    if (!scope) return;
    const work = async (request: FeishuWork) => {
      const result = await this.options.port.runFeishuWork(request);
      if (result?.kind === 'retryDeliveries') {
        for (const { operationId, state, userId } of result.deliveries) {
          recordTrustedResult(this.options.port, { userId, role: 'admin' }, 'feishu_admin', 'retry_delivery', operationId, operationId,
            state === 'sent' ? 'success' : state === 'blocked' ? 'rejected' : state === 'unknown' ? 'unknown' : 'error',
            state === 'blocked' ? { reasonCode: 'PERMISSION_DENIED' } : {}, 'feishu_bots');
        }
      }
      return result;
    };
    if (!this.recovered.has(bot.id)) {
      await work({ ...scope, action: 'recover' });
      this.recovered.add(bot.id);
    }
    if (!this.receiptCompletions.has(bot.id)) {
      const completion = this.completeReceipt(bot, scope).catch(() => undefined).finally(() => this.receiptCompletions.delete(bot.id));
      this.receiptCompletions.set(bot.id, completion);
    }
    // Permission reminders do not use an engine slot or the conversation state.
    const denied = await work({ ...scope, action: 'pending', workspacePath: bot.workspacePath, deniedOnly: true });
    if (this.closed) return;
    if (denied?.kind === 'inbound' && denied.accessDenied) await this.processInbound(bot, scope, denied);
    await this.deliver(bot, scope, work);
    const active = this.active.get(bot.id) ?? new Map<string, Promise<void>>();
    this.active.set(bot.id, active);
    while (!this.closed) {
      const release = this.options.acquireTurn();
      if (!release) break;
      let scheduled = false;
      try {
        const next = await work({ ...scope, action: 'pending', workspacePath: bot.workspacePath, inFlightChats: [...active.keys()] });
        if (this.closed || next?.kind !== 'inbound' || active.has(next.inbound.chatId)) break;
        const chatId = next.inbound.chatId;
        const execution = this.processInbound(bot, scope, next).catch(this.options.diagnostic).finally(() => {
          active.delete(chatId);
          release();
        });
        active.set(chatId, execution);
        scheduled = true;
      } finally {
        if (!scheduled) release();
      }
    }
  }

  private async completeReceipt(bot: FeishuBotConfig, scope: { botId: string; tenantKey: string }) {
    const result = await this.options.port.runFeishuWork({ ...scope, action: 'takeReceiptCompletion',
      projectId: bot.projectId, workspacePath: bot.workspacePath });
    if (result?.kind !== 'receiptCompletion') return;
    const { im } = await this.client(bot);
    await this.options.assertExclusiveWriter();
    await im.messageReaction.create({ path: { message_id: result.messageId }, data: { reaction_type: { emoji_type: 'DONE' } } });
  }

  private async processInbound(bot: FeishuBotConfig, scope: { botId: string; tenantKey: string }, next: FeishuPending) {
    const allowed = next.inbound.botId === feishuBindingId(bot) && next.inbound.projectId === bot.projectId
      && await isCanonicalWorkspace(bot.workspacePath);
    let senderName: SenderName | undefined;
    const loadName = () => senderName ??= this.senderName(bot, scope, next.inbound.senderId, next.inbound.senderName);
    const response: Extract<FeishuWork, { action: 'prepare' }>['response'] = allowed && !next.accessDenied
      ? await this.answer(bot, next, scope, loadName) : null;
    if (this.closed) return;
    if (response?.category === 'private_context_choice') response.offerPrivateContext = true;
    if (response || (allowed && next.accessDenied)) {
      const { name } = loadName();
      if (name && response) response.senderName = name;
    }
    if (this.closed) return;
    await this.options.port.runFeishuWork({ ...scope, action: 'prepare', sequence: next.sequence, workspacePath: bot.workspacePath, response,
      ...(response?.summary ? { summaryPolicyKey: feishuPolicyKey(bot, next.inbound.chatId) } : {}),
      ...(next.clarificationOf && next.question ? { clarificationOf: next.clarificationOf, clarificationQuestion: next.question } : {}) });
  }

  private async deliver(bot: FeishuBotConfig, scope: { botId: string; tenantKey: string }, work: CoreStoragePort['runFeishuWork']) {
    if (this.closed || !await isCanonicalWorkspace(bot.workspacePath)) return;
    const outgoing = await work({ ...scope, action: 'claim', projectId: bot.projectId, workspacePath: bot.workspacePath });
    if (outgoing?.kind !== 'outbound') return;
    const settle: Extract<FeishuWork, { action: 'settle' }> = { ...scope, action: 'settle', id: outgoing.id,
      state: 'blocked', messageId: null, errorCode: 'permission' };
    const legacySummaryAllowed = !outgoing.legacySummary || (bot.summaryChatIds.includes(outgoing.chatId)
      && bot.summary?.model === outgoing.legacySummary.model
      && ('engine' in bot.summary ? bot.summary.engine : undefined) === outgoing.legacySummary.engine);
    const allowed = outgoing.inbound
      ? outgoing.inbound.botId === feishuBindingId(bot) && outgoing.inbound.projectId === bot.projectId
        && legacySummaryAllowed && (outgoing.policyKey === null || feishuPolicyKey(bot, outgoing.chatId) === outgoing.policyKey)
      : feishuPolicyKey(bot, outgoing.chatId) === outgoing.policyKey;
    if (allowed) {
      try {
        const client = await this.client(bot);
        await this.options.assertExclusiveWriter();
        const data = buildFeishuReplyPayload(outgoing);
        const response = outgoing.replyTo ? await client.im.message.reply({ path: { message_id: outgoing.replyTo },
          data: { ...data, reply_in_thread: outgoing.inThread } }) : await client.im.message.create({ params: { receive_id_type: 'chat_id' },
          data: { ...data, receive_id: outgoing.chatId } });
        settle.state = response.code === 0 && response.data?.message_id ? 'sent' : typeof response.code === 'number' && response.code !== 0 ? 'failed' : 'unknown';
        settle.messageId = response.data?.message_id ?? null;
        settle.errorCode = settle.state === 'sent' ? null : `feishu-${response.code ?? 'missing'}`;
      } catch {
        settle.state = 'unknown';
        settle.errorCode = 'transport';
      }
    }
    await work(settle);
  }

  private async client(bot: FeishuBotConfig) {
    let client = this.clients.get(bot.id);
    if (!client) {
      client = await createFeishuClient(bot.appId, bot.appSecret);
      this.clients.set(bot.id, client);
    }
    return client;
  }

  private senderName(bot: FeishuBotConfig, scope: { botId: string; tenantKey: string }, senderId: string, knownName?: string) {
    return this.senderDirectory.lookup(scope, senderId, () => this.client(bot), knownName);
  }

  private async nameForPrompt(entry: SenderName) {
    if (entry.name || !entry.refreshing) return entry.name;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([entry.refreshing, new Promise<void>(resolve => { timer = setTimeout(resolve, senderNameWaitMs); })]);
      return entry.name;
    } finally { clearTimeout(timer); }
  }

  private async answer(bot: FeishuBotConfig, next: FeishuPending, scope: { botId: string; tenantKey: string }, loadName: () => SenderName) {
    if (next.inbound.mentionOnly) return { category: 'help', body: '请在 @ 我时一起发来你想问的问题。' };
    const resumed = !!next.inbound.relayTurn;
    if (next.inbound.cardAction?.card.kind === 'group') return { category: 'group_context_handoff', body: '正在处理会话交接。' };
    if (next.inbound.cardAction?.choice === 'supplement') {
      return { category: 'group_clarify_keywords', body: '好，你说的是哪件事？回复这条消息并 @ 我，给几个关键词就行。原问题我会一起带上。' };
    }
    if (next.confirmedTaskId === null) return { category: 'group_clarify_unavailable', body: '这个事项已经更新了。可以重新 @ 我，说一下你想问哪件事。' };
    const direct = next.inbound.chatType === 'p2p';
    if (!resumed && !next.question && !next.inbound.cardAction && isSummaryRequest(next.inbound.text)
      && !direct) {
      if (!bot.summaryChatIds.includes(next.inbound.chatId) || !bot.summary) return { category: 'help', body: '本群还未开启群消息总结。' };
      const started = await this.options.port.runFeishuWork({ ...scope, action: 'startSummary', sequence: next.sequence, workspacePath: bot.workspacePath });
      if (started?.kind !== 'summaryStarted') return { category: 'summary_unknown', body: '上次总结未能确认结果。需要时请重新 @ 我发起总结。' };
      const messages = (await this.client(bot)).im.message;
      return summarizeFeishuHistory(bot, next.inbound, next.receivedAt, payload => messages.list(payload),
        undefined, this.options.summaryPlatform?.getApiKey, async messageIds => {
          const result = await this.options.port.runFeishuWork({ ...scope, action: 'readSummaryReplies',
            sequence: next.sequence, workspacePath: bot.workspacePath, messageIds });
          if (result?.kind !== 'summaryReplies') throw new Error('FEISHU_SUMMARY_SCOPE_UNAVAILABLE');
          return new Map(result.replies.map(({ messageId, text }) => [messageId, text]));
        });
    }
    const commandReply = !resumed && feishuContextCommandReply(next.inbound, next.relatedTaskIds);
    if (commandReply) return commandReply;
    if (next.needsGroupReference) {
      return { category: 'help', body: '你想接着哪条消息聊？可以引用那条消息再 @ 我，也可以补一句具体线索。' };
    }
    const target = feishuOverrideFor(bot.conversationOverrides, next.inbound);
    const matter = next.confirmedTaskId ? { taskId: next.confirmedTaskId } : undefined;
    const defaults = bot.platformPreferences ?? { engineId: 'codex' as const, modelId: null, reasoningEffort: null, serviceTier: null };
    const preferences = target && (target.engine !== 'bot' || target.model !== null) ? { engineId: target.engine === 'bot' ? 'codex' as const : target.engine,
      modelId: target.model, reasoningEffort: target.reasoningEffort ?? null, serviceTier: target.serviceTier ?? null } : defaults;
    const senderDisplayName = !resumed ? await this.nameForPrompt(loadName()) : null;
    const result = await this.options.nativeConversation.reply(bot, next, preferences, this.stopSignal.signal,
      { ...matter, ...(senderDisplayName ? { senderDisplayName } : {}) });
    return result ? { category: 'conversation', body: result.body, executionLine: result.executionLine,
      ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
      ...(result.taskTitle === undefined ? {} : { taskTitle: result.taskTitle }),
      conversation: { model: result.model, called: true, usage: result.usage } }
      : { category: 'conversation_error', body: '暂时没有完成这条回复，请稍后再试。' };
  }

  async close() {
    this.closed = true;
    if (!this.options.senderDirectory) this.senderDirectory.close();
    this.stopSignal.abort();
    clearInterval(this.timer);
    await this.pending;
    await Promise.allSettled([...this.active.values()].flatMap(chats => [...chats.values()]));
    await Promise.allSettled(this.receiptCompletions.values());
  }
}
