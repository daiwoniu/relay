import { z } from 'zod';
import { feishuIdentity, privateContextCommand, type FeishuInbound } from './inbound.js';

export const feishuCardChoice = z.enum(['carry', 'clear', 'matter-1', 'matter-2', 'matter-3', 'supplement']);
export type FeishuCardChoice = z.output<typeof feishuCardChoice>;
export const feishuClarificationCandidates = z.array(z.object({
  matterId: z.string().uuid(), title: z.string().min(1).max(100), reference: z.string().min(1).max(128).optional(),
}).strict()).min(1).max(3);
export const feishuClarificationCard = z.object({ kind: z.literal('clarify'), candidates: feishuClarificationCandidates }).strict();
const matterChoices = ['matter-1', 'matter-2', 'matter-3'] as const;
export function clarificationLabels(candidates: z.output<typeof feishuClarificationCandidates>) {
  return candidates.map((candidate, index) => candidates.some((other, offset) => offset !== index && other.title === candidate.title)
    ? `${candidate.title}（${candidate.reference ?? `选项 ${index + 1}`}）` : candidate.title);
}
export function clarificationCandidate(card: Extract<FeishuContextCard, { kind: 'clarify' }>, choice: FeishuCardChoice) {
  return card.candidates.find((_, index) => matterChoices[index] === choice);
}

export const feishuContextCard = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('private') }).strict(),
  z.object({ kind: z.literal('group'), matterId: z.string().uuid().optional(), sessionId: feishuIdentity }).strict(),
  feishuClarificationCard,
]);
export type FeishuContextCard = z.output<typeof feishuContextCard>;

export function feishuContextCommandReply(message: Pick<FeishuInbound, 'chatType' | 'text'>, relatedTaskIds: readonly string[]) {
  const command = privateContextCommand(message.text);
  if (!command) return null;
  if (message.chatType === 'group') {
    return { category: 'help', body: '「/新建」可在私聊里使用。群里出现「带摘要新建」按钮时，也可以点它开启一段新对话。' };
  }
  switch (command) {
    case 'choose':
      return { category: 'private_context_choice', body: '想开一段新对话吗？点下方按钮选择。\n带摘要新建：保留对话要点。\n空白新建：从头开始。' };
    case 'carry':
      return { category: 'private_context_carry', body: '新对话开好了。可以接着聊。', carriedTaskIds: [...relatedTaskIds] };
    case 'clear':
      return { category: 'private_context_reset', body: '新对话开好了。接下来想聊什么？' };
  }
}

export const feishuCardCallback = z.object({
  app_id: feishuIdentity, tenant_key: feishuIdentity, host: z.literal('im_message'),
  operator: z.object({ open_id: feishuIdentity }),
  context: z.object({ open_chat_id: feishuIdentity, open_message_id: feishuIdentity }),
  action: z.object({ tag: z.literal('button'), value: z.discriminatedUnion('relay', [
    z.object({ relay: z.literal('new-context'), id: z.string().regex(/^[a-f0-9]{40}$/), choice: z.enum(['carry', 'clear']) }).strict(),
    z.object({ relay: z.literal('clarify'), id: z.string().regex(/^[a-f0-9]{40}$/),
      choice: z.enum(['matter-1', 'matter-2', 'matter-3', 'supplement']) }).strict(),
  ]) }),
});

function feishuModelMarkdown(body: string) {
  // Keep model-generated Feishu mentions literal, including group-wide mentions.
  return body.replace(/<(?=\/?at\b)/gi, '&lt;');
}

export function splitFeishuReplyBody(body: string, executionLine?: string) {
  const suffix = executionLine ? `\n\n${executionLine}` : '';
  return executionLine && body.endsWith(suffix)
    ? { text: body.slice(0, -suffix.length), footer: executionLine }
    : { text: body };
}

export function buildFeishuContextCard(id: string, body: string, card?: FeishuContextCard, executionLine?: string) {
  const button = (choice: FeishuCardChoice, label: string, type: 'primary' | 'default') => ({
    tag: 'button', text: { tag: 'plain_text', content: label }, type,
    value: { relay: card?.kind === 'clarify' ? 'clarify' : 'new-context', id, choice },
  });
  const actions = card?.kind === 'clarify'
    ? [...clarificationLabels(card.candidates).map((title, index) => button(matterChoices[index]!, title, 'default')),
      button('supplement', '都不是，我补充一下', 'default')]
    : card ? [button('carry', '带摘要新建', 'primary'), ...(card.kind === 'private' ? [button('clear', '空白新建', 'default')] : [])] : [];
  const { text, footer } = splitFeishuReplyBody(body, executionLine);
  const plain = (content: string) => ({ tag: 'plain_text', content });
  const elements: { tag: string; content?: string; text?: ReturnType<typeof plain>; actions?: typeof actions; elements?: ReturnType<typeof plain>[] }[] =
    [footer
      ? { tag: 'markdown', content: feishuModelMarkdown(text) }
      : { tag: 'div', text: plain(text) }];
  if (actions.length) elements.push({ tag: 'action', actions });
  if (footer) elements.push({ tag: 'note', elements: [plain(footer)] });
  return { elements };
}

export function buildFeishuReplyPayload(outgoing: {
  id: string; body: string; contextCard?: FeishuContextCard; inbound: { executionLine?: string } | null;
  replyTo: string | null; inThread: boolean; chatId: string;
}) {
  const executionLine = outgoing.inbound?.executionLine;
  if (outgoing.contextCard || executionLine) {
    const routing = outgoing.replyTo ? { reply_in_thread: outgoing.inThread } : { receive_id: outgoing.chatId };
    const cardData = (footer?: string) => ({
      content: JSON.stringify(buildFeishuContextCard(outgoing.id, outgoing.body, outgoing.contextCard, footer)),
      msg_type: 'interactive' as const, uuid: outgoing.id,
    });
    // The size limit applies to the JSON request including the escaped card content.
    const fits = (data: ReturnType<typeof cardData>) => Buffer.byteLength(JSON.stringify({ ...data, ...routing })) <= 30_000;
    const data = cardData(executionLine);
    if (fits(data)) return data;
    if (outgoing.contextCard && executionLine) {
      const plainCard = cardData();
      if (fits(plainCard)) return plainCard;
    }
  }
  return { content: JSON.stringify({ text: outgoing.body }), msg_type: 'text' as const, uuid: outgoing.id };
}
