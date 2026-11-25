import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { jsonBody, requestJson } from '../../api/client';
import { formatDateTime } from '../../utils/date-display';
import FailureNotice from '../ui/FailureNotice';
import ConfirmDialog from '../ui/ConfirmDialog';
import UserMenuIcon from '../icons/UserMenuIcon';
import FeishuImSettings, { type BotEditor } from './FeishuImSettings';
import { deliveryStatus, feishuIdentityLabel } from './feishu-status';
import FeishuConnectionStatus, { type FeishuConnection } from './FeishuConnectionStatus';
import FeishuDailyTrend, { feishuTrendDays, type FeishuTrendPoint } from './FeishuDailyTrend';
import FeishuUserAccess from './FeishuUserAccess';
import './feishu-im.css';
import { appPageRoutes } from '../../../../server/src/analytics/pages.ts';
import { featureAction } from '../../analytics/features';
import { FEISHU_ADMIN_MUTATION_ACTIONS } from '../../../../server/src/analytics/registry.ts';
import { tracker } from '../../analytics/tracker';
import { getSessionStatusPresentation, type DisplayedSessionStatus } from '../layout/session-status';
import ProcessSteps from '../messages/ProcessSteps';
import MessageAttachmentList from '../messages/MessageAttachmentList';
import WorkspaceFilePreview from '../layout/WorkspaceFilePreview';
import type { MessageAttachmentDto, MessageAttachmentSummaryDto } from '../../generated/relay-contracts';
import type { ProcessStep, ProcessTimelineEntry } from '../../stores/chat';

interface Chat { id: string; name: string; chatType: 'group' | 'p2p' }
interface Bot { id: string; name: string; workspace: string; enabled: boolean; active: boolean; groups: Chat[]; connection: FeishuConnection }
interface Message {
  sequence: number; chatId: string; chatType: Chat['chatType']; messageId: string; sender: string; senderName?: string | null;
  text: string; receivedAt: number; category: string | null; state: string | null; reply: string | null; executionLine?: string;
  replyId: string | null; sentId: string | null; errorCode: string | null; attempts: number | null; sentUpdatedAt: number | null;
  taskId: string | null; matterId: string | null; sourceCardId: string | null; replyCard: 'group' | 'private' | 'clarify' | null;
  clarificationChoice?: string | null; clarificationTitles?: string[]; relayStatus?: DisplayedSessionStatus | null;
  attachments?: (MessageAttachmentDto | MessageAttachmentSummaryDto)[]; pendingAttachments?: string[];
  conversation?: { model: string; called: boolean; usage: { total_tokens: number } | null };
  summary: { count: number; truncated: boolean; model: string; modelCalled: boolean; usage: { total_tokens: number } | null } | null;
}
interface Notice { id: string; chatId: string; body: string; state: string; createdAt: number; sentId: string | null; errorCode: string | null }
interface Matter { id: string; title: string; chatId: string; taskId: string; sender: string; senderName?: string | null; sessionId: string | null; updatedAt: number; archivedAt: number | null; relayStatus?: DisplayedSessionStatus | null }
interface Count { name: string; displayName?: string | null; total: number; users?: number; groups?: number; days?: number; lastUsedAt?: number }
type FeishuUsageCounts = Record<'conversationTokens' | 'summaryTokens' | 'conversationUnknown' | 'summaryUnknown', number>;
interface FeishuUsageTrend {
  firstDay: string; lastDay: string; days: { day: string; all: FeishuUsageCounts }[];
  chats: { id: string; days: { day: string; tokens: number; unknown: number }[] }[];
}
interface Conversation { conversationId: string; chatId: string; chatType: Chat['chatType']; senderName: string | null; text: string; receivedAt: number; taskId: string | null; threadId: string | null; conversationOwnerId?: string | null; conversationOwnerName?: string | null; sequence: number; total: number; relayStatus?: DisplayedSessionStatus | null }
type Execution = { steps?: ProcessStep[]; processContent?: string; processTimeline?: ProcessTimelineEntry[]; stopped?: boolean };
type MessagePage = { messages: Message[]; next: number | null };
const conversationKey = (entry: Conversation) => `${entry.chatId}/${entry.conversationId}`;
const noticeKey = (chatId: string) => `${chatId}/notices`;
interface Data extends MessagePage { conversations?: Conversation[]; notices: Notice[]; matters: Matter[]; tally: Record<'received' | 'groups' | 'privateChats' | 'users' | 'pending' | 'failed' | 'unknown' | 'replied', number> & { proactiveSent?: number }; byGroup: Count[]; byUser: Count[]; byCategory: Count[]; byDay: Count[]; usageTrend?: FeishuUsageTrend }
interface Result { bots: Bot[]; selected: string | null; data: Data | null }

const endpoint = '/api/admin/feishu-im';
const trackAdmin = (action: string) => featureAction('feishu_admin', action, 'admin');

const approvalButtons = [['cancel', '取消请求'], ['decline', '拒绝'], ['accept', '允许本次']] as const;
type ApprovalDecision = typeof approvalButtons[number][0];
type ApprovalRequest = { id: string } & Record<ApprovalDecision, boolean>;
function useFeishuApprovals(bot: string, sequence: number, onDecided: () => void) {
  const [requests, setRequests] = useState<ApprovalRequest[] | null>(null);
  const [pending, setPending] = useState<{ id: string; action: ApprovalDecision | 'review' } | null>(null);
  const [failure, setFailure] = useState<{ id: string; error: unknown; description: string } | null>(null);
  async function review(id: string) {
    trackAdmin('details');
    setPending({ id, action: 'review' }); setFailure(null);
    try {
      const params = new URLSearchParams({ bot, sequence: String(sequence) });
      const response = await requestJson<{ requests: ApprovalRequest[] }>(`${endpoint}/approvals?${params}`);
      setRequests(response.requests);
    } catch (error) { setFailure({ id, error, description: '读取待审核操作失败' }); }
    finally { setPending(null); }
  }
  async function decide(id: string, action: ApprovalDecision) {
    setPending({ id, action }); setFailure(null);
    try {
      await requestJson(`${endpoint}/approvals`, { method: 'POST', ...jsonBody({ bot, sequence, id, action }),
        analytics: { feature: 'feishu_admin', action: 'decide_approval', surface: 'admin' } });
      setRequests(current => current?.filter(item => item.id !== id) ?? null);
      onDecided();
    } catch (error) { setFailure({ id, error, description: '审核操作未确认' }); }
    finally { setPending(null); }
  }
  return (step: ProcessStep) => {
    if (!['command_approval', 'file_approval', 'permissions_approval'].includes(String(step.details.interactionKind))) return null;
    const request = requests?.find(item => item.id === step.id);
    const activeAction = pending?.id === step.id ? pending.action : null;
    return <div className="feishu-approvals" aria-label="待审核操作" aria-busy={activeAction !== null}>
      {failure?.id === step.id && <FailureNotice error={failure.error} description={failure.description} />}
      <div className="feishu-row-actions">
        {(!request || failure?.id === step.id) && <button type="button" disabled={pending !== null} onClick={() => void review(step.id)}>
          {activeAction === 'review' ? '正在读取…' : requests ? '刷新待审核操作' : '查看待审核操作'}
        </button>}
        {request && approvalButtons.map(([action, label]) => request[action] && <button key={action} type="button"
          className={action === 'accept' ? 'feishu-primary' : undefined} disabled={pending !== null}
          onClick={() => void decide(request.id, action)}>{activeAction === action ? '正在提交…' : label}</button>)}
      </div>
    </div>;
  };
}
const categoryLabels: Record<string, string> = { task_status: '任务状态', track_task: '跟进事项', help: '使用帮助',
  lookup_error: '查询失败', blocked: '已拦截', access_denied: '用户未开通', pending: '待处理', group_summary: '群总结', history_error: '群历史读取失败',
  summary_error: '群总结失败', summary_unknown: '群总结待确认', private_context_choice: '查看私聊新建选项',
  private_context_reset: '新建私聊上下文', private_context_carry: '新建并带入任务线索',
  private_context_card_expired: '私聊新建卡片已失效', group_context_handoff: '群事项带摘要新建',
  group_context_handoff_unavailable: '群事项交接未完成', group_clarify: '请用户选择事项',
  group_clarify_keywords: '请用户补充线索', group_clarify_unavailable: '群事项已不可用',
  conversation: 'AI 对话', conversation_error: '模型回复失败', conversation_unknown: '模型结果待确认' };
const views = { settings: '机器人配置', users: '使用权限', messages: '消息', matters: '事项', stats: '使用统计' } as const;
type View = keyof typeof views;

function messageText(message: Message) {
  if (!message.sourceCardId) return message.text;
  if (message.clarificationChoice) {
    return `点击卡片 · ${message.clarificationChoice === 'supplement' ? '补充线索' : '确认事项'}\n原问题：${message.text}`;
  }
  return message.text === '/新建 清空' ? '点击卡片 · 空白新建' : '点击卡片 · 带摘要新建';
}

function messageSender(message: Message) {
  return feishuIdentityLabel(message.sender, message.senderName, message.chatType === 'p2p' ? '私聊用户' : '群成员');
}

function ExecutionStatus({ status }: { status?: DisplayedSessionStatus | null }) {
  if (!status) return null;
  const { label, tone } = getSessionStatusPresentation(status);
  return <span className="feishu-status feishu-execution-status" data-tone={tone}><i aria-hidden="true" />{label}</span>;
}

function MessageProcessingDetails({ bot, message, onDecided }: { bot: string; message: Message; onDecided: () => void }) {
  const { summary, conversation } = message;
  const execution = summary ?? conversation;
  const called = summary ? summary.modelCalled : conversation?.called;
  const type = message.category && categoryLabels[message.category];
  const active = Boolean(message.relayStatus && message.relayStatus !== 'queued');
  const [open, setOpen] = useState(active);
  const [process, setProcess] = useState<Execution | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const renderApproval = useFeishuApprovals(bot, message.sequence, () => {
    setRetry(value => value + 1);
    onDecided();
  });
  useEffect(() => { if (active) setOpen(true); }, [active]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ bot, sequence: String(message.sequence) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        if (active && document.hidden) return;
        const { execution } = await requestJson<{ execution: Execution | null }>(`${endpoint}/execution?${params}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          if (execution || !active) setProcess(execution);
          setError(false);
        }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted && active) timer = setTimeout(() => void load(), 1500); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [bot, message.sequence, message.category, open, active, retry]);
  return <details className="feishu-processing-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary onClick={() => { if (!open) trackAdmin('diagnostics'); }}>处理详情</summary>
    {process && Boolean(process.steps?.length || process.processContent || process.processTimeline?.length) && (
      <ProcessSteps readOnly steps={process.steps ?? []} processContent={process.processContent} processTimeline={process.processTimeline}
        defaultCollapsed={false} preserveExpandedOnSettle settled={!active}
        renderReadOnlyInteractionActions={message.relayStatus === 'awaiting_action' ? renderApproval : undefined}
        narrativeStatus={process.stopped ? 'stopped' : active ? 'in_progress' : 'completed'} />
    )}
    {error && <button type="button" onClick={() => { trackAdmin('refresh'); setRetry(value => value + 1); }}>重新读取处理过程</button>}
    <dl>
      {type && <div><dt>处理结果</dt><dd>{type}</dd></div>}
      {summary && <div><dt>群历史</dt><dd>纳入 {summary.count} 条消息{summary.truncated && '，还有部分消息未纳入'}</dd></div>}
      {execution && !message.executionLine && called && <div><dt>模型</dt><dd>{execution.model}</dd></div>}
      {execution && <div><dt>模型用量</dt><dd>{execution.usage ? `${execution.usage.total_tokens.toLocaleString('zh-CN')} tokens`
        : called ? '模型未返回用量' : '本次未调用模型'}</dd></div>}
      {!!message.attempts && <div><dt>发送尝试</dt><dd>{message.attempts} 次</dd></div>}
      {message.sentUpdatedAt != null && <div><dt>发送状态更新时间</dt><dd>{formatDateTime(message.sentUpdatedAt)}</dd></div>}
      {message.errorCode && <div><dt>发送错误码</dt><dd>{message.errorCode}</dd></div>}
      <div><dt>飞书发送者 ID</dt><dd>{message.sender}</dd></div>
      <div><dt>{message.chatType === 'p2p' ? '飞书私聊 ID' : '飞书群聊 ID'}</dt><dd>{message.chatId}</dd></div>
      <div><dt>{message.sourceCardId ? '被点击的卡片 ID' : '飞书原消息 ID'}</dt><dd>{message.sourceCardId ?? message.messageId}</dd></div>
      {message.sentId && <div><dt>飞书回复消息 ID</dt><dd>{message.sentId}</dd></div>}
    </dl>
  </details>;
}

function useFeishuData(view: View, bot: string, chat: string, days: number, before: number | null, revision: number, focusMatter: string | null) {
  const [directory, setDirectory] = useState<Pick<Result, 'bots' | 'selected'>>({ bots: [], selected: null });
  const [response, setResponse] = useState<{ key: string; revision: number; focusMatter: string | null; data: Data | null; error: unknown } | null>(null);
  const enabled = view !== 'settings';
  const key = JSON.stringify([view, bot, chat, days, before]);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const live = view === 'messages' || view === 'matters';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const params = new URLSearchParams({ days: String(days) });
    if (bot) params.set('bot', bot);
    if (chat) params.set('chatId', chat);
    if (before) params.set('before', String(before));
    if (view === 'messages') params.set('conversations', '1');
    if (view === 'stats') params.set('stats', '1');
    if (view === 'users') params.set('directory', '1');
    if (focusMatter) params.set('focusMatter', focusMatter);
    async function load(background = false) {
      let wait = 4000;
      try {
        if (background && document.hidden) return;
        const value = await requestJson<Result>(`${endpoint}?${params}`, { signal: abort.signal });
        if (abort.signal.aborted) return;
        setDirectory({ bots: value.bots, selected: value.selected });
        setResponse({ key, revision, focusMatter, data: value.data, error: null });
        if (value.data?.tally.pending) wait = 1800;
      } catch (error) {
        if (!abort.signal.aborted && !background) {
          setResponse(previous => ({ key, revision, focusMatter, data: previous?.key === key ? previous.data : null, error }));
        }
      } finally {
        if (live && !abort.signal.aborted) timer = setTimeout(() => void load(true), wait);
      }
    }
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [enabled, view, bot, chat, days, before, key, revision, focusMatter]);
  const current = enabled && response?.key === key ? response : null;
  return { ...directory, data: current?.data, error: current?.revision === revision && current.focusMatter === focusMatter ? current.error : null,
    focusPending: focusMatter !== null && current?.focusMatter !== focusMatter,
    loading: enabled && current?.revision !== revision };
}

function groupByChat<T extends { chatId: string }>(rows: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.chatId);
    if (group) group.push(row);
    else groups.set(row.chatId, [row]);
  }
  return [...groups];
}

function FeishuTimeline({ bot, chatId, conversationId, matterId, days, revision, render }: {
  bot: string; chatId: string; conversationId?: string; matterId?: string;
  days: number; revision: number; render: (message: Message) => React.ReactNode;
}) {
  const [latest, setLatest] = useState<MessagePage | null>(null);
  const [older, setOlder] = useState<MessagePage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [olderError, setOlderError] = useState<unknown>(null);
  const [olderRequest, setOlderRequest] = useState<{ before: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const query = new URLSearchParams({ bot, chatId, days: String(days) });
  if (conversationId) query.set('conversationId', conversationId);
  if (matterId) query.set('matterId', matterId);
  const scopedQuery = query.toString();
  async function readPage(params: string, signal: AbortSignal) {
    const { data } = await requestJson<{ data: MessagePage | null }>(`${endpoint}?${params}`, { signal });
    if (!data) throw new Error('飞书记录暂不可用');
    return data;
  }
  useEffect(() => {
    const controller = new AbortController();
    let nextRefresh: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    async function load(background = false) {
      let wait = 4000;
      try {
        if (background && document.hidden) return;
        const data = await readPage(scopedQuery, controller.signal);
        if (controller.signal.aborted) return;
        setError(null);
        setLatest(previous => {
          const oldest = data.messages[data.messages.length - 1]?.sequence;
          if (!previous || data.next == null || oldest === undefined) return data;
          // A pending request may move to its assigned conversation. Keep only history older than the refreshed page.
          return { ...data, messages: [...previous.messages.filter(message => message.sequence < oldest), ...data.messages] };
        });
        if (data.messages.some(message => message.relayStatus || message.category === null || message.state === 'queued' || message.state === 'sending'
          || (message.category === 'access_denied' && message.state === null))) {
          wait = 1800;
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          if (!background) setError(failure);
        }
      } finally {
        if (!controller.signal.aborted) nextRefresh = setTimeout(() => void load(true), wait);
      }
    }
    void load();
    return () => { clearTimeout(nextRefresh); controller.abort(); };
  }, [scopedQuery, revision, retry]);
  useEffect(() => {
    if (!olderRequest) return;
    const controller = new AbortController();
    setOlderError(null);
    void readPage(`${scopedQuery}&before=${olderRequest.before}`, controller.signal).then(data => {
      if (!controller.signal.aborted) setOlder(previous => ({ ...data, messages: [...(previous?.messages ?? []), ...data.messages] }));
    }).catch(failure => {
      if (!controller.signal.aborted) setOlderError(failure);
    }).finally(() => {
      if (!controller.signal.aborted) setOlderRequest(null);
    });
    return () => controller.abort();
  }, [olderRequest, scopedQuery]);
  useLayoutEffect(() => {
    const element = timeline.current;
    const panel = element?.closest<HTMLElement>('.feishu-detail');
    if (!element || !panel || !latest) return;
    const follow = () => {
      if (following.current) panel.scrollTop = panel.scrollHeight;
    };
    const handleScroll = () => {
      following.current = panel.scrollHeight - panel.clientHeight - panel.scrollTop < 80;
    };
    follow();
    panel.addEventListener('scroll', handleScroll, { passive: true });
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    return () => {
      observer.disconnect();
      panel.removeEventListener('scroll', handleScroll);
    };
  }, [Boolean(latest)]);
  const next = older ? older.next : latest?.next;
  const messages = [...new Map([...(older?.messages ?? []), ...(latest?.messages ?? [])]
    .map(message => [message.sequence, message])).values()].sort((a, b) => a.sequence - b.sequence);
  return <div className="feishu-timeline" ref={timeline}>
    {next != null && <button type="button" disabled={!!olderRequest} onClick={() => {
      trackAdmin(olderError == null ? 'paginate' : 'refresh');
      setOlderRequest({ before: next });
    }}>{olderRequest ? '正在加载…' : olderError == null ? '加载更早的消息' : '重试加载更早的消息'}</button>}
    {olderError != null && <FailureNotice error={olderError} description="读取较早消息失败" />}
    {error != null && <><FailureNotice error={error} description="读取会话消息失败" />
      <button type="button" onClick={() => { trackAdmin('refresh'); setRetry(value => value + 1); }}>重新读取</button></>}
    {!latest && error == null && <p role="status">正在读取消息…</p>}
    {messages.length ? messages.map(render) : latest && error == null ? <p>这段时间没有关联消息。</p> : null}
  </div>;
}

function CountTable({ title, rows, labels, bars = false }: { title: string; rows: Count[]; labels?: Record<string, string>; bars?: boolean }) {
  const max = bars ? Math.max(1, ...rows.map(row => row.total)) : 1;
  return <section className="feishu-card"><h2>{title}</h2>{rows.length ? <ul className={bars ? 'feishu-stat-comparison' : undefined}>{rows.map((row, index) =>
    <li key={`${row.name}-${index}`}>
      <span>{labels?.[row.name] ?? row.name}{row.users !== undefined ? ` · ${row.users} 人` : ''}
        {row.groups !== undefined ? ` · ${row.groups} 个群` : ''}{row.days !== undefined ? ` · ${row.days} 天` : ''}
        {row.lastUsedAt !== undefined && <small>最近使用 {formatDateTime(row.lastUsedAt)}</small>}</span>
      {bars && <span aria-hidden="true" className="feishu-stat-bar"><i style={{ width: `${row.total / max * 100}%` }} /></span>}
      <strong>{row.total.toLocaleString('zh-CN')} 次</strong>
    </li>)}</ul> : <p>暂无记录</p>}</section>;
}

function FeishuStatsTrends({ requests, usage, chats, chatLabel, filtered }: {
  requests: Count[]; usage?: FeishuUsageTrend; chats: Chat[]; chatLabel: (id: string, type?: Chat['chatType']) => string;
  filtered: boolean;
}) {
  const [comparison, setComparison] = useState('');
  const dates = usage ? feishuTrendDays(usage.firstDay, usage.lastDay) : [...requests].reverse().map(row => row.name);
  const requestCounts = new Map(requests.map(row => [row.name, row.total]));
  const usageByDay = new Map(usage?.days.map(row => [row.day, row]));
  function modelPoints(kind: 'conversation' | 'summary'): FeishuTrendPoint[] {
    const value: keyof FeishuUsageCounts = `${kind}Tokens`;
    const missing: keyof FeishuUsageCounts = `${kind}Unknown`;
    return dates.map(day => ({ value: usageByDay.get(day)?.all[value] ?? 0, unknown: usageByDay.get(day)?.all[missing] ?? 0 }));
  }
  const chatTypes = new Map(chats.map(chat => [chat.id, chat.chatType]));
  const chatChoices = (usage?.chats ?? []).map(chat => ({
    ...chat, type: chatTypes.get(chat.id) ?? 'group', label: chatLabel(chat.id, chatTypes.get(chat.id)),
    total: chat.days.reduce((sum, day) => sum + day.tokens, 0),
    unknown: chat.days.reduce((sum, day) => sum + day.unknown, 0),
  })).sort((a, b) => b.total - a.total || b.unknown - a.unknown || a.label.localeCompare(b.label, 'zh-CN') || a.id.localeCompare(b.id));
  const selectedChat = chatChoices.find(chat => chat.id === comparison);
  const comparedChats = selectedChat ? [selectedChat] : chatChoices.filter(chat => chat.total || chat.unknown).slice(0, 3);
  const byChat = comparedChats.map(({ id, label, days }) => {
    const usageByDate = new Map(days.map(day => [day.day, day]));
    return { id, label, points: dates.map(day => {
      const point = usageByDate.get(day);
      return { value: point?.tokens ?? 0, unknown: point?.unknown ?? 0 };
    }) };
  });
  const modelSeries = [
    { id: 'conversation', label: 'AI 对话', points: modelPoints('conversation') },
    { id: 'summary', label: '群总结', points: modelPoints('summary') },
  ];
  return <>
    <FeishuDailyTrend title="每日请求" unit="次" dates={dates}
      series={requests.length ? [{ id: 'requests', label: '请求', points: dates.map(day => ({ value: requestCounts.get(day) ?? 0 })) }] : []}
      help="按消息接收日期汇总，包含未开通权限或无需模型的请求。当天没有请求时显示 0。" />
    {usage && <>
      <FeishuDailyTrend title="每日模型用量" unit="tokens" dates={dates}
        series={modelSeries.some(line => line.points.some(point => point.value || point.unknown)) ? modelSeries : []}
        emptyMessage="所选范围内暂无模型用量。"
        help="按当前会话和日期筛选汇总。已返回的 tokens 与未知用量的请求次数分别显示。" />
      {!filtered && <FeishuDailyTrend title="会话用量对比" unit="tokens" dates={dates} series={byChat}
        emptyMessage="所选范围内暂无会话模型用量。"
        help="每条线代表一个私聊或群聊，合计 AI 对话与群总结用量。按已知 tokens 选取用量最高的会话，可切换查看任一会话。"
        controls={chatChoices.length > 0 && <select className="feishu-stats-compare" aria-label="对比会话" value={selectedChat?.id ?? ''}
          onChange={event => { trackAdmin('select_chat'); setComparison(event.target.value); }}>
          <option value="">用量最高的会话（最多 3 个）</option>
          {(['p2p', 'group'] as const).map(type => {
            const choices = chatChoices.filter(chat => chat.type === type);
            return choices.length > 0 && <optgroup key={type} label={type === 'p2p' ? '私聊' : '群聊'}>
              {choices.map(chat => <option key={chat.id} value={chat.id}>{chat.label}</option>)}
            </optgroup>;
          })}
        </select>} />}
    </>}
  </>;
}

function DeliveryActions({ state, active, disabled, label, onRetry }: {
  state: string | null; active: boolean; disabled: boolean; label: string; onRetry?: () => void;
}) {
  if (state === 'unknown') return <p className="feishu-delivery-note">请先在飞书原会话核对是否已经收到。</p>;
  if (state !== 'failed' || !onRetry) return null;
  return <div className="feishu-row-actions feishu-delivery-note">
    <button type="button" disabled={disabled || !active} onClick={onRetry}>{label}</button>
    {!active && <p>机器人连接启动后可补发。</p>}
  </div>;
}

export default function FeishuImAdminPage() {
  const [params, setParams] = useSearchParams();
  const viewport = useRef<HTMLElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listTrigger = useRef<HTMLButtonElement | null>(null);
  const bot = params.get('bot') ?? '';
  const matterParam = params.get('matter');
  const focusedMatter = matterParam && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(matterParam) ? matterParam : null;
  const tab = params.get('view');
  const view: View = tab === 'users' || tab === 'messages' || tab === 'matters' || tab === 'stats' ? tab : 'settings';
  const [editor, setEditor] = useState<BotEditor>(null);
  const chat = params.get('chat') ?? '';
  const [days, setDays] = useState(7);
  const [matterDays, setMatterDays] = useState(30);
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [pagination, setPagination] = useState<{ scope: string; cursors: number[] } | null>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedMessage = useRef<{ key: string; sequence: number } | null>(null);
  const [operation, setOperation] = useState<'busy' | 'idle'>('idle');
  const [outcome, setOutcome] = useState<{ scope: string; message?: string; error?: unknown } | null>(null);
  const [retryTarget, setRetry] = useState<{ scope: string; id: string; chatId: string; chatType?: Chat['chatType'] } | null>(null);
  const filterScope = JSON.stringify([bot, chat, days]);
  const operationScope = JSON.stringify([view, filterScope]);
  const retry = retryTarget?.scope === operationScope ? retryTarget : null;
  const operationResult = outcome?.scope === operationScope ? outcome : null;
  const pages = pagination?.scope === filterScope ? pagination.cursors : [];
  const before = pages[pages.length - 1] ?? null;
  const { bots, selected: defaultBot, data, error, loading, focusPending } = useFeishuData(view, bot, chat, days,
    view === 'messages' ? before : null, revision, view === 'matters' ? focusedMatter : null);
  const currentBot = bots.find(item => item.id === (bot || defaultBot));
  const selectedConversation = data?.conversations?.find(item => conversationKey(item) === selected)
    ?? (selected && selectedMessage.current?.key === selected
      ? data?.conversations?.find(item => item.sequence === selectedMessage.current?.sequence) : undefined);
  const noticeGroups = new Map(groupByChat(before ? [] : data?.notices ?? []));
  const messageGroups = new Map(groupByChat(data?.conversations ?? []));
  for (const chatId of noticeGroups.keys()) {
    if (!messageGroups.has(chatId)) messageGroups.set(chatId, []);
  }
  const selectedNotices = [...noticeGroups].find(([chatId]) => noticeKey(chatId) === selected)?.[1];
  const selectedMatter = data?.matters.find(matter => matter.id === focusedMatter);
  const detailKey = view === 'matters' ? selectedMatter?.id : view === 'messages' && (selectedConversation || selectedNotices) ? selected : null;
  useEffect(() => {
    if (!detailKey) return;
    const notices = detailKey.endsWith('/notices');
    if (notices) detailPanel.current?.scrollTo({ top: 0 });
    if (window.matchMedia('(max-width: 760px)').matches) {
      if (notices) viewport.current?.scrollTo({ top: 0 });
      detailHeading.current?.focus({ preventScroll: true });
    }
  }, [detailKey]);
  const chats = currentBot?.groups ?? [];
  const groupChats = chats.filter(item => item.chatType !== 'p2p');
  const privateChats = chats.filter(item => item.chatType === 'p2p');
  const groups = Object.fromEntries(chats.map(item => [item.id, feishuIdentityLabel(item.id, item.name, item.chatType === 'p2p' ? '私聊' : '群聊')]));
  const people = Object.fromEntries((data?.byUser ?? []).map(item => [item.name, feishuIdentityLabel(item.name, item.displayName, '飞书用户')]));
  const chatLabel = (id: string, type?: Chat['chatType']) => groups[id] ?? feishuIdentityLabel(id, null, type === 'p2p' ? '私聊' : '群聊');
  const conversationName = (entry: Conversation) => {
    if (entry.chatType === 'p2p') return '私聊会话';
    if (entry.taskId) return data?.matters.find(item => item.chatId === entry.chatId && item.taskId === entry.taskId)?.title ?? `跟进 · ${entry.taskId}`;
    if (entry.conversationOwnerId) return feishuIdentityLabel(entry.conversationOwnerId, entry.conversationOwnerName, '群成员');
    return entry.threadId ? '话题对话' : '群内对话';
  };
  const conversationChatLabel = (entry: Conversation) => entry.chatType === 'p2p' && entry.senderName
    ? feishuIdentityLabel(entry.chatId, entry.senderName, '私聊用户') : chatLabel(entry.chatId, entry.chatType);
  const actionsDisabled = operation === 'busy' || loading || error != null;
  function showDelivery(state: string | null, category?: string | null) {
    const status = deliveryStatus(state, category);
    return <span className="feishu-status" data-state={status.state}>{status.label}</span>;
  }
  function renderTurn(message: Message) {
    return <article className="feishu-turn" key={message.sequence}>
      <div className="feishu-bubble is-user">
        <div className="feishu-bubble-meta"><strong>{messageSender(message)}</strong><small>{formatDateTime(message.receivedAt)}</small></div>
        <pre>{messageText(message)}</pre>
        {message.attachments?.length ? <MessageAttachmentList attachments={message.attachments} />
          : message.pendingAttachments?.length ? <ul className="feishu-pending-attachments" aria-label="消息附件">
            {message.pendingAttachments.map((name, index) => <li key={index}>{name}</li>)}
          </ul> : null}
      </div>
      <div className="feishu-bubble is-bot">
        <div className="feishu-bubble-meta"><strong>{currentBot?.name ?? '机器人'}</strong>{message.relayStatus
          ? <ExecutionStatus status={message.relayStatus} /> : showDelivery(message.state, message.category)}</div>
        {message.reply ? message.executionLine
          ? <div className="feishu-reply-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
            img: ({ alt }) => <span>{alt || '图片'}</span>,
            a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          }}>{message.reply}</ReactMarkdown></div>
          : <pre>{message.reply}</pre> : !message.relayStatus && <p className="feishu-reply-state">{message.category === null ? '等待处理' : '暂无回复内容'}</p>}
        {message.executionLine && <p className="feishu-execution-note">{message.executionLine}</p>}
        {message.replyCard === 'clarify'
          ? <p className="feishu-reply-buttons">{message.clarificationTitles?.map((title, index) => <span key={index}>{title}</span>)}<span>都不是，我补充一下</span></p>
          : message.replyCard && <p className="feishu-reply-buttons"><span>带摘要新建</span>{message.replyCard === 'private' && <span>空白新建</span>}</p>}
        <DeliveryActions state={message.state} active={currentBot?.active ?? false} disabled={actionsDisabled} label="补发原回复"
          onRetry={message.replyId ? () => openRetry({ scope: operationScope, id: message.replyId!, chatId: message.chatId, chatType: message.chatType }) : undefined} />
        <div className="feishu-turn-actions">
          {view === 'messages' && <>
            {message.chatType !== 'p2p' && message.taskId && !message.matterId && <button disabled={actionsDisabled}
              onClick={() => void change('convert', { sequence: message.sequence, chatId: message.chatId })}>转为事项</button>}
            {message.matterId && <button onClick={() => viewMatter(message.matterId!, undefined, message.chatId)}>查看事项</button>}
          </>}
        </div>
        {currentBot && <MessageProcessingDetails bot={currentBot.id} message={message} onDecided={() => setRevision(value => value + 1)} />}
      </div>
    </article>;
  }

  useEffect(() => {
    const previous = document.title;
    document.title = `${appPageRoutes.feishu_bots.label} · Relay`;
    return () => { document.title = previous; };
  }, []);
  useEffect(() => { if (view !== 'settings') setEditor(null); }, [view]);
  useEffect(() => { setRetry(null); }, [operationScope]);

  function selectView(next: View) {
    if (next === view) return;
    tracker.action({ feature: 'feishu_admin', action: 'section', surface: 'admin', section: `feishu_${next}` });
    const query = new URLSearchParams(params);
    query.delete('matter');
    if (next === 'matters' && privateChats.some(item => item.id === chat)) query.delete('chat');
    if (next === 'settings') query.delete('view');
    else query.set('view', next);
    setParams(query);
    setOutcome(null);
    viewport.current?.scrollTo({ top: 0 });
  }

  function selectBot(id: string) {
    trackAdmin('select_bot');
    setParams(current => {
      const query = new URLSearchParams(current);
      query.set('bot', id);
      query.delete('chat');
      query.delete('matter');
      return query;
    }, { replace: true });
    resetList();
  }

  function selectChat(id: string) {
    trackAdmin('select_chat');
    const query = new URLSearchParams(params);
    if (id) query.set('chat', id);
    else query.delete('chat');
    query.delete('matter');
    setParams(query, { replace: true });
    resetList();
  }

  function selectMessageList(key: string, action: 'details' | 'notice_details', trigger: HTMLButtonElement, sequence?: number) {
    if (key !== selected) {
      trackAdmin(action);
      setOutcome(null);
    }
    listTrigger.current = trigger;
    selectedMessage.current = sequence === undefined ? null : { key, sequence };
    setSelected(key);
  }

  function viewMatter(id: string, trigger?: HTMLButtonElement, chatId?: string) {
    if (view !== 'matters') tracker.action({ feature: 'feishu_admin', action: 'section', surface: 'admin', section: 'feishu_matters' });
    trackAdmin('view_matter');
    const query = new URLSearchParams(params);
    query.set('view', 'matters');
    query.set('matter', id);
    if (chatId) query.set('chat', chatId);
    setParams(query);
    setOutcome(null);
    listTrigger.current = trigger ?? null;
  }

  function focusList() {
    requestAnimationFrame(() => {
      const trigger = listTrigger.current;
      (trigger?.isConnected ? trigger : listHeading.current)?.focus();
    });
  }

  function closeMessages() {
    trackAdmin('return_list');
    setSelected(null);
    setOutcome(null);
    focusList();
  }

  function refreshRecords() {
    trackAdmin('refresh');
    setRevision(value => value + 1);
  }

  function detailControls(label: string, onBack: () => void) {
    return <div className="feishu-detail-controls">
      <button type="button" onClick={onBack}>{label}</button>
      <button type="button" className="feishu-detail-refresh" onClick={refreshRecords} disabled={loading}>
        {loading ? '正在刷新…' : '刷新'}
      </button>
    </div>;
  }

  function closeMatter() {
    trackAdmin('return_list');
    setOutcome(null);
    const query = new URLSearchParams(params);
    query.delete('matter');
    setParams(query, { replace: true });
    focusList();
  }

  function resetList() { setPagination(null); setSelected(null); setOutcome(null); }
  function pageMessages(next: number | null) {
    trackAdmin('paginate');
    setPagination({ scope: filterScope, cursors: next === null ? pages.slice(0, -1) : [...pages, next] });
    setSelected(null);
    viewport.current?.scrollTo({ top: 0 });
  }

  function openRetry(target: NonNullable<typeof retryTarget>) {
    trackAdmin('open_retry');
    setRetry(target);
  }
  async function change(action: keyof typeof FEISHU_ADMIN_MUTATION_ACTIONS, target: Record<string, string | number>) {
    if (!currentBot || !data || actionsDisabled) {
      if (action === 'retry') throw new Error('请刷新飞书记录后再补发');
      return;
    }
    setOperation('busy'); setOutcome(null);
    try {
      const targetUrl = action === 'convert' || action === 'link' || action === 'handoff' ? `${endpoint}/matters` : endpoint;
      await requestJson(targetUrl, { method: 'POST', ...jsonBody({ bot: currentBot.id, action, ...target }),
        analytics: { feature: 'feishu_admin', action: FEISHU_ADMIN_MUTATION_ACTIONS[action], surface: 'admin' } });
      setRevision(value => value + 1);
      setOutcome({ scope: operationScope, message: {
        retry: '已加入补发队列', archive: '事项已归档', restore: '事项已恢复', convert: '事项已建立', link: '会话已创建', handoff: '已交接到新会话',
      }[action] });
    } catch (failure) {
      if (action === 'retry') throw failure;
      setOutcome({ scope: operationScope, error: failure });
    }
    finally { setOperation('idle'); }
  }

  const conversationView = view === 'messages' || view === 'matters';
  const Overview = conversationView ? 'details' : 'div';
  return <>
  <div className="feishu-admin">
    <header className="feishu-header">
      <div className="feishu-header-inner">
        <div className="feishu-heading">
          <span className="feishu-heading-icon"><UserMenuIcon type="feishu" /></span>
          <h1>{appPageRoutes.feishu_bots.label}</h1>
        </div>
        <button type="button" className="feishu-primary"
          onClick={() => { trackAdmin('edit_bot'); selectView('settings'); setEditor('new'); }}><span aria-hidden="true">＋</span> 添加机器人</button>
        <nav className="feishu-nav" aria-label={appPageRoutes.feishu_bots.label}>
          {(Object.keys(views) as View[]).map(item => <button key={item} type="button" aria-current={view === item ? 'page' : undefined}
            onClick={() => selectView(item)}>{views[item]}</button>)}
        </nav>
      </div>
    </header>
    <main className={`feishu-scroll${conversationView ? ' is-conversation-view' : ''}`} ref={viewport}>
    <div className={`feishu-content${detailKey ? ' is-record-detail' : ''}`}>
    {view === 'settings' &&
      <FeishuImSettings editor={editor} onEdit={setEditor} onChanged={() => { resetList(); setRevision(value => value + 1); }} />
    }
    {view !== 'settings' && <>
    {error != null && <FailureNotice error={error} description={data ? '刷新失败，当前显示上次结果' : '读取飞书记录失败'} />}
    {operationResult?.error != null && <FailureNotice error={operationResult.error} description="操作失败" />}
    {operationResult?.message && <p className="feishu-feedback" role="status">{operationResult.message}</p>}
    {loading && !data && <p role="status">正在读取…</p>}
    {!loading && !error && !bots.length && <p className="feishu-card">尚未配置飞书群机器人。可从页头的「添加机器人」开始。</p>}
    {currentBot && <div className="feishu-view-heading">
      <div><h2>{currentBot.name}</h2><p>工作区 {currentBot.workspace}</p></div>
      <FeishuConnectionStatus key={currentBot.id} enabled={currentBot.enabled} active={currentBot.active} connection={currentBot.connection} />
    </div>}
    {view !== 'users' && !loading && !error && currentBot && data === null && <p className="feishu-card">{currentBot.active ? '在飞书发一条私聊消息，或在群里 @ 机器人，即可看到记录。' : '机器人暂未接收过消息。启用后，可以私聊或在群里 @ 它。'}</p>}
    {!loading && !error && bot && bots.length > 0 && !currentBot && <p className="feishu-card">这个链接指向的机器人暂不可用。请选择一个机器人查看记录。</p>}
    {currentBot || bots.length > 0 || error != null ? (
      <Overview className={conversationView ? 'feishu-record-overview' : undefined} open={conversationView ? overviewOpen : undefined}
        onToggle={conversationView ? event => setOverviewOpen((event.currentTarget as HTMLDetailsElement).open) : undefined}>
      {conversationView && <summary>筛选与统计</summary>}
      <div className="feishu-toolbar">
        {(bots.length > 1 || (!currentBot && bots.length > 0)) && <select aria-label="机器人" value={currentBot?.id ?? ''} onChange={event => selectBot(event.target.value)}>{!currentBot && <option value="" disabled>请选择机器人</option>}{bots.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        {currentBot && view !== 'users' && <select aria-label={view === 'matters' ? '群聊' : '飞书会话'} value={chat} onChange={event => selectChat(event.target.value)}>
          <option value="">{view === 'matters' ? '全部群' : '全部会话'}</option>
          {chat && !(view === 'matters' ? groupChats : chats).some(item => item.id === chat) && <option value={chat}>{chatLabel(chat)}</option>}
          {groupChats.length > 0 && <optgroup label="群聊">{groupChats.map(item => <option key={item.id} value={item.id}>{chatLabel(item.id, item.chatType)}</option>)}</optgroup>}
          {view !== 'matters' && privateChats.length > 0 && <optgroup label="私聊">{privateChats.map(item => <option key={item.id} value={item.id}>{chatLabel(item.id, item.chatType)}</option>)}</optgroup>}
        </select>}
        {view !== 'users' && view !== 'matters' && <select aria-label="时间范围" value={days} onChange={event => { trackAdmin('range'); setDays(Number(event.target.value)); resetList(); }}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select>}
        <button onClick={refreshRecords} disabled={loading}>{loading ? '正在刷新…' : '刷新'}</button>
      </div>
      {view === 'messages' && currentBot && data && <div className="feishu-counts"><span>已受理 <strong>{data.tally.received}</strong></span><span>待处理 <strong>{data.tally.pending}</strong></span><span>发送失败 <strong>{data.tally.failed}</strong></span><span>发送待确认 <strong>{data.tally.unknown}</strong></span></div>}
      </Overview>
    ) : null}
    {view === 'users' && currentBot && <FeishuUserAccess key={currentBot.id} bot={currentBot.id} revision={revision} />}
    {currentBot && data && <>
      {view === 'messages' && <>
        <div className={`feishu-split ${selectedConversation || selectedNotices ? 'has-detail' : ''}`}>
          <section className="feishu-card feishu-message-list" aria-label="会话列表">
            <h2 ref={listHeading} tabIndex={-1}>飞书会话</h2>
            {messageGroups.size ? [...messageGroups].map(([chatId, items]) => <section key={chatId} className="feishu-chat-group">
              <h3><span className="feishu-override-kind" data-kind={items[0]?.chatType ?? 'group'}>{items[0]?.chatType === 'p2p' ? '私聊' : '群聊'}</span>
                {items[0] ? conversationChatLabel(items[0]) : chatLabel(chatId, 'group')}</h3>
              {items.map(item => <button type="button" key={conversationKey(item)} className="feishu-row"
                aria-pressed={item === selectedConversation} onClick={event => selectMessageList(conversationKey(item), 'details', event.currentTarget, item.sequence)}>
                <span className="feishu-message-lead"><strong>{conversationName(item)}</strong><ExecutionStatus status={item.relayStatus} /></span>
                <span className="feishu-preview">{item.text}</span>
                <small>{formatDateTime(item.receivedAt)} · {item.total} 条请求</small>
              </button>)}
              {noticeGroups.has(chatId) && <button type="button" className="feishu-row" aria-pressed={selected === noticeKey(chatId)}
                onClick={event => selectMessageList(noticeKey(chatId), 'notice_details', event.currentTarget)}>
                <strong>机器人主动发送</strong><small>{noticeGroups.get(chatId)?.length} 条通知</small>
              </button>}
            </section>) : <p>这段时间没有受理的会话。</p>}
            {(before || data.next) && <div className="feishu-pagination" role="group" aria-label="消息翻页">
              <button disabled={!before || loading} onClick={() => pageMessages(null)}>上一页（较新）</button>
              <button disabled={!data.next || loading} onClick={() => { if (data.next) pageMessages(data.next); }}>下一页（较早）</button>
            </div>}
          </section>
          <section className="feishu-card feishu-detail" ref={detailPanel} aria-label="会话详情">
            {selectedConversation ? <>
              <header className="feishu-detail-header">
                {detailControls('返回会话列表', closeMessages)}
                <div className="feishu-message-lead"><h2 ref={detailHeading} tabIndex={-1}>{conversationName(selectedConversation)}</h2>
                  <ExecutionStatus status={selectedConversation.relayStatus} /></div>
                <small>{conversationChatLabel(selectedConversation)} · {selectedConversation.total} 条请求</small>
              </header>
              <FeishuTimeline key={`${currentBot.id}:${conversationKey(selectedConversation)}:${days}`} bot={currentBot.id} chatId={selectedConversation.chatId}
                conversationId={selectedConversation.conversationId} days={days} revision={revision} render={renderTurn} />
            </> : selectedNotices ? <>
              <header className="feishu-detail-header">
                {detailControls('返回会话列表', closeMessages)}
                <h2 ref={detailHeading} tabIndex={-1}>机器人主动发送</h2>
                <small>{chatLabel(selectedNotices[0].chatId, 'group')} · {selectedNotices.length} 条通知{data.notices.length === 30 && ' · 显示筛选范围内最近的通知'}</small>
              </header>
              <div className="feishu-timeline">{[...selectedNotices].reverse().map(notice => <article className="feishu-bubble is-bot" key={notice.id}>
                <div className="feishu-bubble-meta"><strong>{currentBot.name}</strong><small>{formatDateTime(notice.createdAt)}</small>{showDelivery(notice.state)}</div>
                <pre>{notice.body}</pre>
                <DeliveryActions state={notice.state} active={currentBot.active} disabled={actionsDisabled} label="补发原通知"
                  onRetry={() => openRetry({ scope: operationScope, id: notice.id, chatId: notice.chatId, chatType: 'group' })} />
                {(notice.sentId || notice.errorCode) && <details className="feishu-processing-details" onToggle={event => {
                  if (event.currentTarget.open) trackAdmin('diagnostics');
                }}><summary>处理详情</summary>
                  {notice.sentId && <p>消息 ID {notice.sentId}</p>}{notice.errorCode && <p>错误码 {notice.errorCode}</p>}
                </details>}
              </article>)}</div>
            </> : <div className="feishu-detail-empty"><p>选择一个会话查看消息和回复。</p></div>}
          </section>
        </div>
      </>}
      {view === 'matters' && <div className={`feishu-split ${selectedMatter ? 'has-detail' : ''}`}>
        <section className="feishu-card feishu-message-list" aria-label="事项列表"><h2 ref={listHeading} tabIndex={-1}>跟进事项</h2>
          {focusedMatter && !selectedMatter && <p role="status">{focusPending ? '正在读取关联事项…' : '当前范围内未找到该事项。'}</p>}
          {data.matters.length >= 100 && <p>显示最近更新的 100 项{data.matters.length > 100 ? '及当前打开的事项。' : '。可按群筛选。'}</p>}
          {data.matters.length ? groupByChat(data.matters).map(([chatId, items]) => <section key={chatId} className="feishu-chat-group">
            <h3><span className="feishu-override-kind" data-kind="group">群聊</span>{chatLabel(chatId, 'group')}</h3>
            {items.map(matter => <button type="button" className="feishu-row" aria-pressed={matter.id === focusedMatter}
              key={matter.id} onClick={event => viewMatter(matter.id, event.currentTarget)}>
              <span className="feishu-message-lead"><strong>{matter.title}</strong>{matter.relayStatus ? <ExecutionStatus status={matter.relayStatus} />
                : <span className="feishu-status" data-state={matter.archivedAt ? 'idle' : 'connected'}>{matter.archivedAt ? '已归档' : '跟进中'}</span>}</span>
              <small>{feishuIdentityLabel(matter.sender, matter.senderName, '群成员')} · {formatDateTime(matter.updatedAt)}</small>
            </button>)}
          </section>) : <p>暂无跟进事项。群聊中关联到事项的消息会显示在这里。</p>}
        </section>
        <section className="feishu-card feishu-detail" ref={detailPanel} aria-label="事项详情">
          {selectedMatter ? <>
            <header className="feishu-detail-header">
            {detailControls('返回事项列表', closeMatter)}
            <div className="feishu-message-lead">
              <h2 ref={detailHeading} tabIndex={-1}>{selectedMatter.title}</h2>
              {selectedMatter.relayStatus ? <ExecutionStatus status={selectedMatter.relayStatus} />
                : <span className="feishu-status" data-state={selectedMatter.archivedAt ? 'idle' : 'connected'}>{selectedMatter.archivedAt ? '已归档' : '跟进中'}</span>}
            </div>
            <small>{chatLabel(selectedMatter.chatId, 'group')} · 发起人 {feishuIdentityLabel(selectedMatter.sender, selectedMatter.senderName, '群成员')}</small>
            <small>更新于 {formatDateTime(selectedMatter.updatedAt)}</small>
            <div className="feishu-row-actions feishu-matter-actions">
              {selectedMatter.sessionId && <a className="feishu-button-link" href={`/?session=${encodeURIComponent(selectedMatter.sessionId)}`} target="_blank" rel="noopener noreferrer"
                onClick={() => trackAdmin('open_session')} onAuxClick={event => { if (event.button === 1) trackAdmin('open_session'); }}>打开 Relay 会话 <span aria-hidden="true">↗</span><span className="sr-only">（新标签页打开）</span></a>}
              {!selectedMatter.archivedAt && !selectedMatter.sessionId && <button disabled={actionsDisabled} onClick={() => void change('link', { id: selectedMatter.id })}>创建 Relay 会话</button>}
              {!selectedMatter.archivedAt && selectedMatter.sessionId && <button disabled={actionsDisabled}
                onClick={() => void change('handoff', { id: selectedMatter.id, sessionId: selectedMatter.sessionId! })}>交接到新会话</button>}
              <button disabled={actionsDisabled} onClick={() => void change(selectedMatter.archivedAt ? 'restore' : 'archive', { id: selectedMatter.id })}>
                {selectedMatter.archivedAt ? '恢复' : '归档'}</button>
            </div>
            <label className="feishu-matter-range">关联消息
              <select value={matterDays} onChange={event => {
                trackAdmin('range');
                setMatterDays(Number(event.target.value));
              }}>
                <option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option>
              </select>
            </label>
            </header>
            <FeishuTimeline key={`${currentBot.id}:${selectedMatter.id}:${matterDays}`} bot={currentBot.id} chatId={selectedMatter.chatId}
              matterId={selectedMatter.id} days={matterDays} revision={revision} render={renderTurn} />
          </> : <div className="feishu-detail-empty"><p>选择一个事项查看关联消息。</p></div>}
        </section>
      </div>}
      {view === 'stats' && <>
        <div className="feishu-counts" aria-label="使用概览">
          <span>收到请求 <strong>{data.tally.received.toLocaleString('zh-CN')}</strong></span><span>发起人数 <strong>{data.tally.users.toLocaleString('zh-CN')}</strong></span>
          <span>活跃群聊 <strong>{data.tally.groups.toLocaleString('zh-CN')}</strong></span><span>活跃私聊 <strong>{data.tally.privateChats.toLocaleString('zh-CN')}</strong></span>
        </div>
        <div className="feishu-stats">
          <FeishuStatsTrends key={currentBot.id} requests={data.byDay} usage={data.usageTrend} chats={chats} chatLabel={chatLabel} filtered={!!chat} />
          <section className="feishu-card"><h2>回复状态</h2>
            <dl className="feishu-stat-values">
              <div><dt>已回复</dt><dd>{data.tally.replied}</dd></div>
              <div><dt>待处理</dt><dd>{data.tally.pending}</dd></div>
              <div><dt>发送失败</dt><dd>{data.tally.failed}</dd></div>
              <div><dt>发送待确认</dt><dd>{data.tally.unknown}</dd></div>
              {data.tally.proactiveSent !== undefined && <div><dt>主动通知已发送</dt><dd>{data.tally.proactiveSent}</dd></div>}
            </dl>
          </section>
          <CountTable title="请求类型" rows={data.byCategory} labels={categoryLabels} bars />
          <CountTable title="活跃群聊（前 50）" rows={data.byGroup} labels={groups} bars />
          <CountTable title="活跃人员（前 50）" rows={data.byUser} labels={people} bars />
        </div>
      </>}
    </>}
    <ConfirmDialog open={retry !== null} title="补发飞书消息" tone="warning"
      subject={retry ? { label: '发送到', value: chatLabel(retry.chatId, retry.chatType) } : undefined}
      description="确认后会将原消息加入发送队列，并发送到原飞书会话。"
      confirmLabel="确认补发" pendingLabel="正在提交…" confirmDisabled={actionsDisabled || !currentBot?.active}
      onCancel={() => { trackAdmin('cancel_retry'); setRetry(null); }}
      onConfirm={async () => { if (!retry) return; await change('retry', { id: retry.id }); setRetry(null); }} />
    </>}
    </div>
    </main>
  </div>
  <WorkspaceFilePreview />
  </>;
}
