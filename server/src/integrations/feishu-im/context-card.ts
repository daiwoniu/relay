import { z } from 'zod';
import { feishuIdentity, privateContextCommand, type FeishuInbound } from './inbound.js';
import { feishuContextLabels, formatCompactTokens } from './reply-display.js';

type FeishuReplyFileButton = { id: string; name: string; path: string };

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
    return { category: 'help', body: `「/新建」可在私聊里使用。群里有「${feishuContextLabels.carry}」按钮时，可直接点击开启新对话。` };
  }
  switch (command) {
    case 'choose':
      return { category: 'private_context_choice', body: '要开启新对话吗？可以带上之前的对话要点，也可以从空白开始。' };
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
    z.object({ relay: z.literal('reply-file'), id: z.string().uuid() }).strict(),
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

function useMarkdown(text: string) {
  return /(?:^|\n)[ \t]{0,3}(?:#{1,6}\s|[-+*>]\s|\d+\.\s|`{3,}|~{3,}|\|[^\n]+\|)/.test(text)
    || /\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/|\\[\\`*_[\]~|]|&(?:lt|gt|amp);/i.test(text);
}

const literalMentions = (text: string) => text.replace(/<(?=\/?at\b)/gi, '＜');

function shortenFileLabel(label: string, index: number) {
  const chars = Array.from(label);
  return chars.length > 76 ? `${chars.slice(0, 45).join('')}…${chars.slice(-24).join('')}（${index + 1}）` : label;
}

function replyFileLabels(files: FeishuReplyFileButton[]) {
  const paths = files.map(file => file.path.split(/[\\/]/));
  return files.map((file, index) => {
    const path = paths[index]!;
    // Choose the shortest unique trailing path when two files have the same name.
    for (let depth = 1; depth <= path.length; depth++) {
      const suffix = path.slice(-depth).join('/');
      if (!paths.some((other, offset) => offset !== index && other.slice(-depth).join('/') === suffix)) {
        return shortenFileLabel(depth === 1 ? file.name : `${file.name}（${path.slice(-depth, -1).join('/')}）`, index);
      }
    }
    return shortenFileLabel(file.name, index);
  });
}

type ReplyFiles = { files?: FeishuReplyFileButton[]; unavailableFileCount?: number; omittedFileCount?: number };

export function buildFeishuContextCard(id: string, text: string, card?: FeishuContextCard,
  { markdown, footer, files = [], unavailableFileCount, omittedFileCount }: ReplyFiles & { markdown?: boolean; footer?: string } = {}) {
  const plain = (content: string) => ({ tag: 'plain_text', content });
  const line = (content: string) => ({ tag: 'div' as const, text: plain(content) });
  const note = (content: string) => ({ tag: 'div' as const, text: { ...plain(content), text_size: 'notation', text_color: 'grey' } });
  const button = (choice: FeishuCardChoice, label: string, type: 'primary' | 'default') => ({
    tag: 'button' as const, text: plain(label), type,
    behaviors: [{ type: 'callback' as const, value: { relay: card?.kind === 'clarify' ? 'clarify' : 'new-context', id, choice } }],
  });
  const actions = card?.kind === 'clarify'
    ? [...clarificationLabels(card.candidates).map((title, index) => button(matterChoices[index]!, title, 'default')),
      button('supplement', '都不是，我补充一下', 'default')]
    : card ? [button('carry', feishuContextLabels.carry, 'primary'), ...(card.kind === 'private' ? [button('clear', feishuContextLabels.clear, 'default')] : [])] : [];
  const content = (markdown ?? useMarkdown(text))
    ? { tag: 'markdown' as const, content: feishuModelMarkdown(text) }
    : line(literalMentions(text));
  const labels = replyFileLabels(files);
  const fileNotes = fileAvailability({ unavailableFileCount, omittedFileCount });
  return {
    schema: '2.0',
    body: { elements: [content, ...actions, ...(files.length ? [line('附件')] : []), ...files.map((file, index) => ({
      tag: 'button' as const, text: plain(`获取 ${labels[index]}`), type: 'default',
      behaviors: [{ type: 'callback' as const, value: { relay: 'reply-file', id: file.id } }],
    })), ...fileNotes.map(note), ...(footer ? [note(footer)] : [])] },
  };
}

function fileAvailability({ unavailableFileCount, omittedFileCount }: ReplyFiles) {
  return [
    ...(unavailableFileCount ? [`有 ${unavailableFileCount} 个文件当前无法获取。`] : []),
    ...(omittedFileCount ? [`有 ${omittedFileCount} 个文件未提供领取按钮，可以请机器人单独生成。`] : []),
  ];
}

export function buildFeishuDelivery(outgoing: ReplyFiles & {
  id: string; body: string; contextCard?: FeishuContextCard; inbound: {
    executionLine?: string; chatType?: FeishuInbound['chatType'];
    conversation?: { actualModel?: string; usage: { total_tokens: number } | null };
  } | null;
  replyTo: string | null; inThread: boolean; chatId: string;
}) {
  const request = (content: string, msg_type: 'interactive' | 'text', fileCount = 0) => {
    const message = { content, msg_type, uuid: outgoing.id };
    const stagedFiles = fileCount ? { fileCount } : {};
    return outgoing.replyTo
      ? { ...stagedFiles, method: 'reply', payload: { path: { message_id: outgoing.replyTo },
        data: { ...message, reply_in_thread: outgoing.inThread } } } as const
      : { ...stagedFiles, method: 'create', payload: { params: { receive_id_type: 'chat_id' },
        data: { ...message, receive_id: outgoing.chatId } } } as const;
  };
  const { inbound, contextCard, files = [], unavailableFileCount, omittedFileCount } = outgoing;
  const { text } = splitFeishuReplyBody(outgoing.body, inbound?.executionLine);
  const engine = inbound?.executionLine?.match(/^引擎：([^·\n]+)/)?.[1]?.trim();
  const usage = inbound?.conversation?.usage?.total_tokens;
  const footer = inbound?.chatType === 'p2p'
    ? [engine, inbound.conversation?.actualModel, usage == null ? null : `${formatCompactTokens(usage)} Tokens`].filter(Boolean).join(' · ')
    : '';
  const markdown = Boolean(inbound || contextCard || files.length) && useMarkdown(text);
  const hasActions = Boolean(contextCard || files.length);
  if (markdown || footer || hasActions) {
    const card = (body: string, options: { markdown?: boolean; footer?: string } = {}) =>
      request(JSON.stringify(buildFeishuContextCard(outgoing.id, body, contextCard,
        { files, unavailableFileCount, omittedFileCount, ...options })), 'interactive', files.length);
    const fits = (delivery: ReturnType<typeof request>) => Buffer.byteLength(JSON.stringify(delivery.payload.data)) <= 30_000;
    const full = card(text, { markdown, footer });
    if (fits(full)) return full;
    if (footer) {
      const withoutFooter = card(text, { markdown });
      if (fits(withoutFooter)) return withoutFooter;
    }
    if (hasActions) {
      const hint = '\n\n正文过长，仅显示前段。完整内容可请 Relay 管理员查看。';
      const chars = Array.from(text);
      const preview = (end: number) => card(chars.slice(0, end).join('').trimEnd() + hint, { markdown: false });
      let low = 0;
      let high = chars.length;
      let best = preview(0);
      // Keep the original actions and file buttons. The complete reply stays in Relay.
      if (fits(best)) {
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = preview(mid);
          if (fits(candidate)) { best = candidate; low = mid + 1; }
          else high = mid - 1;
        }
        const prefix = chars.slice(0, high).join('');
        const paragraph = prefix.lastIndexOf('\n\n');
        return paragraph > prefix.length * 0.8 ? card(prefix.slice(0, paragraph).trimEnd() + hint, { markdown: false }) : best;
      }
    }
  }
  const notices = fileAvailability({ unavailableFileCount, omittedFileCount: (omittedFileCount ?? 0) + files.length });
  if (contextCard) notices.push('当前回复未能附带操作按钮，请重新发起选择。');
  return request(JSON.stringify({ text: [literalMentions(text), ...notices].join('\n\n') }), 'text');
}
