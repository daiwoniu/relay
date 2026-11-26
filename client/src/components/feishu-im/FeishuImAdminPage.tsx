import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, jsonBody, requestJson } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { formatClockTime, formatDate, formatDateTime } from '../../utils/date-display';
import FailureNotice from '../ui/FailureNotice';
import ConfirmDialog from '../ui/ConfirmDialog';
import UserMenuIcon from '../icons/UserMenuIcon';
import FeishuImSettings, { type BotEditor } from './FeishuImSettings';
import { deliveryStatus, feishuIdentityLabel } from './feishu-status';
import FeishuOverview, { type Overview, type OverviewDimension, type OverviewMetric, type Drilldown, type TimeWindow } from './FeishuOverview';
import FeishuStatsFilters from './FeishuStatsFilters';
import FeishuUserAccess from './FeishuUserAccess';
import FeishuReplyMarkdown from './FeishuReplyMarkdown';
import FeishuDiagnostics from './FeishuDiagnostics';
import { readFeishuExecutionLine } from './feishu-execution-details';
import { feishuContextLabels, formatCompactTokens } from '../../../../server/src/integrations/feishu-im/reply-display.ts';
import { readFeishuConversationPosition, requestedFeishuAdminView, saveFeishuConversationPosition, type FeishuAdminView as View } from './feishu-admin-navigation';
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
interface Bot { id: string; name: string; workspace: string; active: boolean; groups: Chat[] }
interface Message {
  sequence: number; chatId: string; chatType: Chat['chatType']; messageId: string; sender: string; senderName?: string | null;
  text: string; receivedAt: number; category: string | null; state: string | null; reply: string | null; executionLine?: string;
  replyId: string | null; sentId: string | null; errorCode: string | null; attempts: number | null; sentUpdatedAt: number | null;
  taskId: string | null; matterId: string | null; sourceCardId: string | null; replyCard: 'group' | 'private' | 'clarify' | null;
  clarificationChoice?: string | null; clarificationTitles?: string[]; relayStatus?: DisplayedSessionStatus | null;
  attachments?: (MessageAttachmentDto | MessageAttachmentSummaryDto)[]; pendingAttachments?: string[];
  replyFiles?: { id: string; name: string; state: 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'unavailable'; updatedAt: number }[];
  previewProjectPath?: string;
  conversation?: { model: string; called: boolean; usage: { total_tokens: number } | null };
  summary: { count: number; truncated: boolean; model: string; modelCalled: boolean; usage: { total_tokens: number } | null } | null;
}
interface RecordOwner { botId?: string; groupName?: string | null }
interface Notice extends RecordOwner { id: string; chatId: string; body: string; state: string; createdAt: number; sentId: string | null; errorCode: string | null }
interface Matter extends RecordOwner { id: string; title: string; chatId: string; taskId: string; sender: string; senderName?: string | null; sessionId: string | null; updatedAt: number; archivedAt: number | null; relayStatus?: DisplayedSessionStatus | null }
interface Conversation extends RecordOwner { conversationId: string; chatId: string; chatType: Chat['chatType']; senderName: string | null; text: string; receivedAt: number; taskId: string | null; threadId: string | null; conversationOwnerId?: string | null; conversationOwnerName?: string | null; sequence: number; total: number; relayStatus?: DisplayedSessionStatus | null;
  deliveryFailed?: number; deliveryUnknown?: number; matchSequence?: number | null; matchPreview?: string | null; attentionSequence?: number | null }
type ConversationFilters = { q: string; chatType: Chat['chatType'] | ''; attention: 'approval' | 'failed' | 'unknown' | 'reply_failed' | 'reply_unknown' | 'reply_anomaly' | ''; requestsOnly: boolean };
type Execution = { steps?: ProcessStep[]; processContent?: string; processTimeline?: ProcessTimelineEntry[]; stopped?: boolean };
type ExecutionRead = 'loading' | 'loaded' | { error: string; retryable: boolean };
type MessagePage = { messages: Message[]; next: number | null };
const conversationKey = (entry: Conversation) => JSON.stringify([entry.botId, entry.chatId, entry.conversationId]);
const noticeKey = (entry: Notice) => `${JSON.stringify([entry.botId, entry.chatId])}/notices`;
interface Data { conversations?: Conversation[]; next?: number | null; notices?: Notice[]; matters?: Matter[]; tally?: { pending: number }; overview?: Overview }
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
const views = { settings: '机器人配置', users: '使用权限', messages: '消息', stats: '使用统计' } as const;
const viewOrder: View[] = ['messages', 'settings', 'users', 'stats'];

function messageText(message: Message) {
  if (!message.sourceCardId) return message.text;
  if (message.clarificationChoice) {
    return `点击卡片 · ${message.clarificationChoice === 'supplement' ? '补充线索' : '确认事项'}\n原问题：${message.text}`;
  }
  return `点击卡片 · ${message.text === '/新建 清空' ? feishuContextLabels.clear : feishuContextLabels.carry}`;
}

function messageSender(message: Message) {
  return feishuIdentityLabel(message.sender, message.senderName, message.chatType === 'p2p' ? '私聊用户' : '群成员');
}

function ExecutionStatus({ status }: { status?: DisplayedSessionStatus | null }) {
  if (!status) return null;
  const { label, tone } = getSessionStatusPresentation(status);
  return <span className="feishu-status feishu-execution-status" data-tone={tone}><i aria-hidden="true" />{label}</span>;
}

function MatterStatus({ matter }: { matter: Matter }) {
  return matter.relayStatus ? <ExecutionStatus status={matter.relayStatus} />
    : <span className="feishu-status" data-state={matter.archivedAt ? 'idle' : 'connected'}>{matter.archivedAt ? '已归档' : '跟进中'}</span>;
}

function MessageProcessingDetails({ bot, message, onDecided }: { bot: string; message: Message; onDecided: () => void }) {
  const { summary, conversation } = message;
  const execution = summary ?? conversation;
  const called = summary ? summary.modelCalled : conversation?.called;
  const type = message.category && categoryLabels[message.category];
  const footer = readFeishuExecutionLine(message.executionLine);
  const totalTokens = execution?.usage?.total_tokens;
  const tokens = totalTokens != null ? `${totalTokens.toLocaleString('zh-CN')} Tokens` : null;
  const context = [type, summary ? `纳入 ${summary.count} 条消息` : footer?.engine].filter(Boolean);
  const highlights = totalTokens == null ? context : [...context, `${formatCompactTokens(totalTokens)} Tokens`];
  const parameters = [
    ['引擎', footer?.engine],
    ['模型', footer?.model ?? (!message.executionLine && called ? execution?.model : null)],
    ['强度', footer?.effort],
    ['速度', footer?.speed],
    ['模型用量', execution ? tokens ?? (called ? '模型未返回用量' : '本次未调用模型') : null],
    ['会话累计压缩', footer?.compactions != null ? `${footer.compactions} 次` : null],
    ['群历史范围', summary?.truncated ? '还有部分消息未纳入' : null],
  ].flatMap(([label, value]) => label && value ? [{ label, value }] : []);
  const legacyFooter = !footer ? message.executionLine : undefined;
  const diagnostics = [
    { label: '发送尝试', value: message.attempts ? `${message.attempts} 次` : null },
    { label: '发送状态更新时间', value: message.sentUpdatedAt != null ? formatDateTime(message.sentUpdatedAt) : null },
    { label: '发送错误码', value: message.errorCode },
    { label: '飞书发送者 ID', value: message.sender, identifier: true },
    { label: message.chatType === 'p2p' ? '飞书私聊 ID' : '飞书群聊 ID', value: message.chatId, identifier: true },
    { label: '飞书原消息 ID', value: message.messageId, identifier: true },
    { label: '被点击的卡片 ID', value: message.sourceCardId, identifier: true },
    { label: '飞书回复消息 ID', value: message.sentId, identifier: true },
  ].flatMap(({ value, ...field }) => value ? [{ ...field, value }] : []);
  const active = Boolean(message.relayStatus && message.relayStatus !== 'queued');
  const needsApproval = message.relayStatus === 'awaiting_action';
  const [open, setOpen] = useState(needsApproval);
  const [process, setProcess] = useState<Execution | null>(null);
  const [executionRead, setExecutionRead] = useState<ExecutionRead>('loading');
  const [retry, setRetry] = useState(0);
  const renderApproval = useFeishuApprovals(bot, message.sequence, () => {
    setRetry(value => value + 1);
    onDecided();
  });
  useEffect(() => { if (needsApproval) setOpen(true); }, [needsApproval]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ bot, sequence: String(message.sequence) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    setExecutionRead('loading');
    async function load() {
      let retryable = true;
      try {
        if (active && document.hidden) return;
        const { execution } = await requestJson<{ execution: Execution | null }>(`${endpoint}/execution?${params}`, {
          signal: controller.signal, timeoutMs: 10_000,
        });
        if (!controller.signal.aborted) {
          if (execution || !active) setProcess(execution);
          setExecutionRead('loaded');
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const status = error instanceof ApiError ? error.status : undefined;
        const terminal = status === 401 ? '登录已过期，请重新登录。'
          : status === 403 ? '当前账号没有查看此处理过程的权限。'
          : status === 400 || status === 404 ? '消息记录已变化，请刷新消息列表。' : undefined;
        retryable = terminal === undefined;
        if (terminal) setProcess(null);
        setExecutionRead({ error: terminal ?? (status === 0 ? '连接失败或超时，请重试。' : '处理过程读取失败，请稍后重试。'), retryable });
      } finally { if (!controller.signal.aborted && active && retryable) timer = setTimeout(() => void load(), 1500); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [bot, message.sequence, message.category, open, active, retry]);
  const hasProcess = process && Boolean(process.steps?.length || process.processContent || process.processTimeline?.length);
  return <details className="feishu-processing-details" data-review={needsApproval || undefined} open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary onClick={() => { if (!open) trackAdmin('diagnostics'); }}>
      <strong>处理详情</strong>{highlights.length > 0 &&
        <span title={(tokens ? [...context, tokens] : context).join(' · ')}>{highlights.join(' · ')}</span>}
    </summary>
    <div className="feishu-processing-content">
    {process && hasProcess && (
      <ProcessSteps readOnly steps={process.steps ?? []} processContent={process.processContent} processTimeline={process.processTimeline}
        preserveExpandedOnSettle={needsApproval} expandRunningOperations={active} settled={!active}
        renderReadOnlyInteractionActions={needsApproval ? renderApproval : undefined}
        narrativeStatus={process.stopped ? 'stopped' : active ? 'in_progress' : 'completed'} />
    )}
    {executionRead === 'loading' && <p className="feishu-reply-state" role="status">正在读取处理过程…</p>}
    {executionRead === 'loaded' && !hasProcess && <p className="feishu-reply-state" role="status">
      {message.relayStatus ? '正在等待处理过程。' : '这条消息没有保存的处理过程。'}
    </p>}
    {typeof executionRead === 'object' && <div className="feishu-process-read-error">
      <p className="feishu-reply-state" role="status">{executionRead.error}</p>
      {executionRead.retryable && <button type="button" onClick={() => {
        trackAdmin('refresh'); setExecutionRead('loading'); setRetry(value => value + 1);
      }}>重新读取处理过程</button>}
    </div>}
    {(parameters.length > 0 || legacyFooter) && <section className="feishu-execution-parameters">
      <h4>执行参数</h4>
      {legacyFooter && <p>{legacyFooter}</p>}
      {parameters.length > 0 && <dl>{parameters.map(({ label, value }) =>
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    </section>}
    <FeishuDiagnostics fields={diagnostics} />
    </div>
  </details>;
}

function useFeishuData(view: View, bot: string, chat: string, days: number, before: number | null, revision: number, focusMatter: string | null,
  { q, chatType, attention, requestsOnly }: ConversationFilters, range: TimeWindow | null, dimension: OverviewDimension, metric: OverviewMetric) {
  const [directory, setDirectory] = useState<Pick<Result, 'bots' | 'selected'>>({ bots: [], selected: null });
  const [response, setResponse] = useState<{
    key: string; scopeKey: string; revision: number; focusMatter: string | null; data: Data | null; error: unknown; rankingUnavailable?: boolean;
  } | null>(null);
  const query = new URLSearchParams({ days: String(days) });
  if (bot) query.set('bot', bot);
  if (chat) query.set('chatId', chat);
  if (before) query.set('before', String(before));
  if (chatType && (view === 'messages' || view === 'stats')) query.set('chatType', chatType);
  if (view === 'messages') {
    query.set('conversations', '1');
    if (q) query.set('q', q);
    if (attention) query.set('attention', attention);
    if (requestsOnly) query.set('requestsOnly', '1');
  }
  if (view === 'stats') {
    query.set('stats', '1');
    query.set('bucket', days === 1 ? 'hour' : days === 90 ? 'week' : 'day');
  }
  if (view === 'users' || view === 'settings') query.set('directory', '1');
  if (range && (view === 'messages' || view === 'stats')) {
    query.set('from', String(range.from));
    query.set('to', String(range.to));
  }
  const scopeKey = query.toString();
  if (view === 'stats') {
    query.set('dimension', dimension);
    query.set('metric', metric);
  }
  const key = query.toString();
  useEffect(() => {
    const abort = new AbortController();
    const live = view === 'messages' && !q;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let canPoll = live;
    const params = new URLSearchParams(key);
    if (focusMatter) params.set('focusMatter', focusMatter);
    async function load(background = false) {
      let wait = 4000;
      try {
        if (background && document.hidden) return;
        const value = await requestJson<Result>(`${endpoint}?${params}`, { signal: abort.signal });
        if (abort.signal.aborted) return;
        canPoll = live && value.bots.length > 0;
        setDirectory({ bots: value.bots, selected: value.selected });
        setResponse({ key, scopeKey, revision, focusMatter, data: value.data, error: null });
        if (value.data?.tally?.pending) wait = 1800;
      } catch (error) {
        if (!abort.signal.aborted && !background) {
          setResponse(previous => {
            const mayKeepData = !(error instanceof ApiError && (error.status === 401 || error.status === 403));
            if (mayKeepData && previous?.key === key) return { ...previous, revision, focusMatter, error };
            if (mayKeepData && view === 'stats' && previous?.scopeKey === scopeKey && previous.data?.overview) {
              const data = { ...previous.data, overview: { ...previous.data.overview, ranking: [] } };
              return { key, scopeKey, revision, focusMatter, data, error, rankingUnavailable: true };
            }
            return { key, scopeKey, revision, focusMatter, data: null, error };
          });
        }
      } finally {
        if (canPoll && !abort.signal.aborted) timer = setTimeout(() => void load(true), wait);
      }
    }
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [view, key, scopeKey, revision, focusMatter, q]);
  const current = response?.key === key ? response : null;
  const data = current ? current.data : view === 'stats' && response?.scopeKey === scopeKey ? response.data : undefined;
  return { ...directory, data, rankingUnavailable: current?.rankingUnavailable ?? false,
    error: current?.revision === revision && current.focusMatter === focusMatter ? current.error : null,
    focusPending: focusMatter !== null && current?.focusMatter !== focusMatter,
    loading: current?.revision !== revision };
}

function groupNotices(rows: readonly Notice[]) {
  const groups = new Map<string, Notice[]>();
  for (const row of rows) {
    const key = noticeKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups];
}

function FeishuTimeline({ bot, chatId, conversationId, matterId, days, range, revision, focusSequence, onLatest, render }: {
  bot: string; chatId: string; conversationId?: string; matterId?: string;
  days: number; range?: TimeWindow | null; revision: number; focusSequence?: number | null; onLatest?: () => void; render: (message: Message) => React.ReactNode;
}) {
  const [latest, setLatest] = useState<MessagePage | null>(null);
  const [older, setOlder] = useState<MessagePage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [olderError, setOlderError] = useState<unknown>(null);
  const [olderRequest, setOlderRequest] = useState<{ before: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(!focusSequence);
  const historyAnchor = useRef<{ turn: HTMLElement; top: number } | null>(null);
  const query = new URLSearchParams({ bot, chatId, days: String(days) });
  if (conversationId) query.set('conversationId', conversationId);
  if (matterId) query.set('matterId', matterId);
  if (range) {
    query.set('from', String(range.from));
    query.set('to', String(range.to));
  }
  if (focusSequence) query.set('before', String(focusSequence + 1));
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
        if (!controller.signal.aborted && !focusSequence) nextRefresh = setTimeout(() => void load(true), wait);
      }
    }
    void load();
    return () => { clearTimeout(nextRefresh); controller.abort(); };
  }, [scopedQuery, revision, retry, focusSequence]);
  useEffect(() => {
    if (!olderRequest) return;
    const controller = new AbortController();
    setOlderError(null);
    const olderQuery = new URLSearchParams(scopedQuery);
    olderQuery.set('before', String(olderRequest.before));
    void readPage(olderQuery.toString(), controller.signal).then(data => {
      if (controller.signal.aborted) return;
      const element = timeline.current;
      const panel = element?.closest<HTMLElement>('.feishu-detail');
      const visibleTop = panel?.querySelector('.feishu-detail-header')?.getBoundingClientRect().bottom;
      if (element && visibleTop !== undefined) {
        const turn = Array.from(element.querySelectorAll<HTMLElement>('[data-feishu-turn]'))
          .find(item => item.getBoundingClientRect().bottom > visibleTop);
        if (turn) {
          historyAnchor.current = { turn, top: turn.getBoundingClientRect().top };
          following.current = false;
        }
      }
      setOlder(previous => ({ ...data, messages: [...(previous?.messages ?? []), ...data.messages] }));
    }).catch(failure => {
      if (!controller.signal.aborted) setOlderError(failure);
    }).finally(() => {
      if (!controller.signal.aborted) setOlderRequest(null);
    });
    return () => controller.abort();
  }, [olderRequest, scopedQuery]);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    historyAnchor.current = null;
    const panel = anchor?.turn.closest<HTMLElement>('.feishu-detail');
    if (panel && anchor) panel.scrollTop += anchor.turn.getBoundingClientRect().top - anchor.top;
  }, [older]);
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
    if (focusSequence) {
      const target = element.querySelector(`[data-feishu-turn="${focusSequence}"]`);
      const headerBottom = panel.querySelector('.feishu-detail-header')?.getBoundingClientRect().bottom;
      if (target && headerBottom !== undefined) panel.scrollTop += target.getBoundingClientRect().top - headerBottom - 8;
    } else follow();
    panel.addEventListener('scroll', handleScroll, { passive: true });
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    return () => {
      observer.disconnect();
      panel.removeEventListener('scroll', handleScroll);
    };
  }, [Boolean(latest), focusSequence]);
  const next = older ? older.next : latest?.next;
  const messages = [...new Map([...(older?.messages ?? []), ...(latest?.messages ?? [])]
    .map(message => [message.sequence, message])).values()].sort((a, b) => a.sequence - b.sequence);
  let previousDay: string | undefined;
  return <div className="feishu-timeline" ref={timeline}>
    {focusSequence && onLatest && <button type="button" onClick={() => { trackAdmin('paginate'); onLatest(); }}>返回最新消息</button>}
    {next != null && <button type="button" disabled={!!olderRequest} onClick={() => {
      trackAdmin(olderError == null ? 'paginate' : 'refresh');
      setOlderRequest({ before: next });
    }}>{olderRequest ? '正在加载…' : olderError == null ? '加载更早的消息' : '重试加载更早的消息'}</button>}
    {olderError != null && <FailureNotice error={olderError} description="读取较早消息失败" />}
    {error != null && <><FailureNotice error={error} description="读取会话消息失败" />
      <button type="button" onClick={() => { trackAdmin('refresh'); setRetry(value => value + 1); }}>重新读取</button></>}
    {!latest && error == null && <p role="status">正在读取消息…</p>}
    {messages.length ? messages.map(message => {
      const day = formatDate(message.receivedAt);
      const divider = day !== previousDay;
      previousDay = day;
      return <Fragment key={message.sequence}>
        {divider && <div className="feishu-timeline-date"><time dateTime={day}>{day}</time></div>}
        {render(message)}
      </Fragment>;
    }) : latest && error == null ? <p className="feishu-record-empty">这段时间没有关联消息。</p> : null}
  </div>;
}


const isDeliveryIssue = (state: string | null) => state === 'failed' || state === 'unknown';

function DeliveryActions({ state, active, disabled, label, onRetry }: {
  state: string | null; active: boolean; disabled: boolean; label: string; onRetry?: () => void;
}) {
  if (!isDeliveryIssue(state)) return null;
  const status = deliveryStatus(state);
  return <div className="feishu-row-actions feishu-delivery-note" data-state={status.state}>
    <span className="feishu-status" data-state={status.state}>{status.label}</span>
    {state === 'unknown' && <p>请先在飞书原会话核对是否已经收到。</p>}
    {state === 'failed' && onRetry && <>
      <button type="button" disabled={disabled || !active} onClick={onRetry}>{label}</button>
      {!active && <p>机器人连接启动后可补发。</p>}
    </>}
  </div>;
}

export default function FeishuImAdminPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const viewport = useRef<HTMLElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const listPanel = useRef<HTMLElement>(null);
  const listScroll = useRef(0);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listTrigger = useRef<HTMLButtonElement | null>(null);
  const bot = params.get('bot') ?? '';
  const matterParam = params.get('matter');
  const focusedMatter = matterParam && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(matterParam) ? matterParam : null;
  const requestedView = requestedFeishuAdminView(params);
  const requestView = requestedView ?? 'messages';
  const [editor, setEditor] = useState<BotEditor>(null);
  const chat = bot === 'all' ? '' : params.get('chat') ?? '';
  const daysParam = Number(params.get('days'));
  const days = daysParam === 1 || daysParam === 30 || daysParam === 90 ? daysParam : 7;
  const from = params.has('from') ? Number(params.get('from')) : NaN;
  const to = params.has('to') ? Number(params.get('to')) : NaN;
  const range = Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to > from && to - from <= 93 * 86400_000 ? { from, to } : null;
  const q = params.get('q')?.trim().slice(0, 120) ?? '';
  const typeParam = params.get('type');
  const selectedChatType = typeParam === 'group' || typeParam === 'p2p' ? typeParam : '';
  const chatType = chat ? '' : selectedChatType;
  const attentionParam = params.get('attention');
  const attention = attentionParam === 'approval' || attentionParam === 'failed' || attentionParam === 'unknown'
    || attentionParam === 'reply_failed' || attentionParam === 'reply_unknown' || attentionParam === 'reply_anomaly' ? attentionParam : '';
  const requestsOnly = params.get('requestsOnly') === '1';
  const [comparisonDimension, setDimension] = useState<OverviewDimension>('robot');
  const dimension = chatType && (comparisonDimension === 'group' || comparisonDimension === 'p2p') && comparisonDimension !== chatType
    ? 'robot' : comparisonDimension;
  const [metric, setMetric] = useState<OverviewMetric>('received');
  const [preferredBot, setPreferredBot] = useState('');
  useEffect(() => {
    try { setPreferredBot(user ? localStorage.getItem(`feishu-admin-bot:${user.id}`) ?? '' : ''); } catch { setPreferredBot(''); }
  }, [user?.id]);
  const requestedBot = bot || (focusedMatter || chat ? '' : preferredBot || 'all');
  const [searchDraft, setSearchDraft] = useState(q);
  const [matterDays, setMatterDays] = useState(30);
  const [pagination, setPagination] = useState<{ scope: string; cursors: number[] } | null>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusSequence, setFocusSequence] = useState<number | null>(null);
  const selectedMessage = useRef<{ key: string; sequence: number } | null>(null);
  const restoredScope = useRef<string | null>(null);
  const [operation, setOperation] = useState<'busy' | 'idle'>('idle');
  const [outcome, setOutcome] = useState<{ scope: string; message?: string; error?: unknown } | null>(null);
  const [retryTarget, setRetry] = useState<{ scope: string; id: string; owner: Bot; destination: string } | null>(null);
  const filterScope = JSON.stringify([requestedBot, chat, days, q, chatType, attention, range, requestsOnly]);
  const pages = pagination?.scope === filterScope ? pagination.cursors : [];
  const before = pages[pages.length - 1] ?? null;
  const { bots, selected: defaultBot, data, error, loading, focusPending, rankingUnavailable } = useFeishuData(requestView, requestedBot, chat, days,
    requestView === 'messages' ? before : null, revision, requestView === 'messages' ? focusedMatter : null, { q, chatType, attention, requestsOnly },
    range, dimension, dimension === 'model' ? 'tokens' : metric);
  const view: View = requestedView ?? (!error && data === null && !bots.length ? 'settings' : 'messages');
  const operationScope = JSON.stringify([view, filterScope, focusedMatter ?? selected]);
  const retry = retryTarget?.scope === operationScope ? retryTarget : null;
  const operationResult = outcome?.scope === operationScope ? outcome : null;
  const scopeId = requestedBot === 'all' ? bots.length === 1 ? bots[0].id : 'all' : requestedBot || defaultBot;
  const allBots = scopeId === 'all';
  const currentBot = bots.find(item => item.id === scopeId);
  const scopeReady = Boolean(currentBot || allBots && bots.length);
  const ownerOf = (row?: RecordOwner) => row?.botId ? bots.find(item => item.id === row.botId) : currentBot;
  const positionScope = user && scopeReady && !q && !attention && !range && !requestsOnly ? JSON.stringify([user.id, scopeId, chat, chatType, days]) : null;
  useEffect(() => { setSearchDraft(q); }, [q]);
  useEffect(() => {
    if (view !== 'messages' || !positionScope || loading || !data?.conversations || focusedMatter || restoredScope.current === positionScope) return;
    restoredScope.current = positionScope;
    if (selected) return;
    try {
      const position = readFeishuConversationPosition(window.localStorage, positionScope);
      if (!position) return;
      if (position.cursors.length) setPagination({ scope: filterScope, cursors: position.cursors });
      selectedMessage.current = { key: position.key, sequence: position.sequence };
      setSelected(position.key);
    } catch { /* Browser storage is optional. */ }
  }, [view, positionScope, loading, data?.conversations, focusedMatter, selected, filterScope]);
  const selectedConversation = focusedMatter ? undefined : data?.conversations?.find(item => conversationKey(item) === selected)
    ?? (selected && selectedMessage.current?.key === selected
      ? data?.conversations?.find(item => item.sequence === selectedMessage.current?.sequence) : undefined);
  const noticeGroups = new Map(groupNotices(before ? [] : data?.notices ?? []));
  const selectedNotices = focusedMatter || !selected ? undefined : noticeGroups.get(selected);
  const selectedMatter = data?.matters?.find(matter => matter.id === focusedMatter);
  const matterKey = (row: Conversation | Matter) => JSON.stringify([ownerOf(row)?.id, row.chatId, row.taskId]);
  const mattersByTask = new Map((data?.matters ?? []).map(matter => [matterKey(matter), matter]));
  const matterFor = (entry: Conversation) => entry.taskId ? mattersByTask.get(matterKey(entry)) : undefined;
  const activeMatter = selectedConversation && matterFor(selectedConversation);
  const representedMatterIds = new Set((data?.conversations ?? []).map(entry => matterFor(entry)?.id));
  const otherMatters = before || q || attention || chatType === 'p2p' || requestsOnly ? [] : (data?.matters ?? []).filter(matter => !representedMatterIds.has(matter.id));
  const detailBot = ownerOf(selectedMatter ?? selectedConversation ?? selectedNotices?.[0]);
  const detailKey = view === 'messages' ? selectedMatter?.id ?? ((selectedConversation || selectedNotices) ? selected : null) : null;
  useEffect(() => {
    if (!detailKey) return;
    const notices = detailKey.endsWith('/notices');
    if (notices) detailPanel.current?.scrollTo({ top: 0 });
    if (window.matchMedia('(max-width: 760px)').matches) {
      viewport.current?.scrollTo({ top: 0 });
      detailHeading.current?.focus({ preventScroll: true });
    }
  }, [detailKey]);
  const chats = currentBot?.groups ?? [];
  const groupChats = chats.filter(item => item.chatType !== 'p2p');
  const privateChats = chats.filter(item => item.chatType === 'p2p');
  const groups = Object.fromEntries(chats.map(item => [item.id, feishuIdentityLabel(item.id, item.name, item.chatType === 'p2p' ? '私聊' : '群聊')]));
  const chatLabel = (id: string, type?: Chat['chatType'], name?: string | null) => name
    ? feishuIdentityLabel(id, name, type === 'p2p' ? '私聊' : '群聊')
    : groups[id] ?? feishuIdentityLabel(id, null, type === 'p2p' ? '私聊' : '群聊');
  const conversationName = (entry: Conversation) => {
    if (entry.chatType === 'p2p') return '私聊会话';
    if (entry.taskId) return matterFor(entry)?.title ?? `跟进 · ${entry.taskId}`;
    if (entry.conversationOwnerId) return feishuIdentityLabel(entry.conversationOwnerId, entry.conversationOwnerName, '群成员');
    return entry.threadId ? '话题对话' : '群内对话';
  };
  const conversationChatLabel = (entry: Conversation) => entry.chatType === 'p2p' && entry.senderName
    ? feishuIdentityLabel(entry.chatId, entry.senderName, '私聊用户') : chatLabel(entry.chatId, entry.chatType, entry.groupName);
  const actionsDisabled = operation === 'busy' || loading || error != null;
  function showDelivery(state: string | null, category?: string | null) {
    const status = deliveryStatus(state, category);
    return <span className="feishu-status" data-state={status.state}>{status.label}</span>;
  }
  function renderTurn(message: Message) {
    return <article className="feishu-turn" data-feishu-turn={message.sequence} data-search-match={message.sequence === focusSequence || undefined}>
      <div className="feishu-bubble is-user">
        <div className="feishu-bubble-meta"><strong>{messageSender(message)}</strong><small title={formatDateTime(message.receivedAt)}>{formatClockTime(message.receivedAt)}</small></div>
        <pre>{messageText(message)}</pre>
        {message.attachments?.length ? <MessageAttachmentList attachments={message.attachments} />
          : message.pendingAttachments?.length ? <ul className="feishu-pending-attachments" aria-label="消息附件">
            {message.pendingAttachments.map((name, index) => <li key={index}>{name}</li>)}
          </ul> : null}
      </div>
      <div className="feishu-bubble is-bot">
        <div className="feishu-bubble-meta"><strong>{detailBot?.name ?? '机器人'}</strong>{message.relayStatus
          ? <ExecutionStatus status={message.relayStatus} /> : !isDeliveryIssue(message.state) && showDelivery(message.state, message.category)}
          {message.state === 'sent' && message.sentUpdatedAt != null && <small title={formatDateTime(message.sentUpdatedAt)}>{formatClockTime(message.sentUpdatedAt)}</small>}
        </div>
        {message.reply ? message.executionLine
          ? <FeishuReplyMarkdown body={message.reply} projectPath={message.previewProjectPath} />
          : <pre>{message.reply}</pre> : !message.relayStatus && <p className="feishu-reply-state">{message.category === null ? '等待处理' : '暂无回复内容'}</p>}
        {message.replyFiles?.length ? <ul className="feishu-reply-files" aria-label="回复附件投递记录">
          {message.replyFiles.map(file => <li key={file.id}>
            <strong>{file.name}</strong>
            {file.state === 'unavailable' ? <span className="feishu-status" data-state="blocked">文件不可用</span> : showDelivery(file.state)}
            <small>{formatDateTime(file.updatedAt, { short: true })}</small>
          </li>)}
        </ul> : null}
        <DeliveryActions state={message.state} active={detailBot?.active ?? false} disabled={actionsDisabled} label="补发原回复"
          onRetry={message.replyId && detailBot ? () => openRetry({ scope: operationScope, id: message.replyId!, owner: detailBot,
            destination: selectedConversation ? conversationChatLabel(selectedConversation) : chatLabel(message.chatId, message.chatType) }) : undefined} />
        {message.replyCard === 'clarify'
          ? <p className="feishu-reply-buttons">{message.clarificationTitles?.map((title, index) => <span key={index}>{title}</span>)}<span>都不是，我补充一下</span></p>
          : message.replyCard && <p className="feishu-reply-buttons"><span>{feishuContextLabels.carry}</span>{message.replyCard === 'private' && <span>{feishuContextLabels.clear}</span>}</p>}
        <div className="feishu-turn-actions">
          {view === 'messages' && <>
            {message.chatType !== 'p2p' && message.taskId && !message.matterId && <button disabled={actionsDisabled}
              onClick={() => void change('convert', { sequence: message.sequence, chatId: message.chatId })}>转为事项</button>}
            {message.matterId && message.matterId !== (activeMatter ?? selectedMatter)?.id
              && <button onClick={() => viewMatter(message.matterId!, undefined, message.chatId)}>查看关联事项</button>}
          </>}
        </div>
        {detailBot && <MessageProcessingDetails bot={detailBot.id} message={message} onDecided={() => setRevision(value => value + 1)} />}
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
    query.set('view', next);
    setParams(query);
    setOutcome(null);
    viewport.current?.scrollTo({ top: 0 });
  }

  function selectBot(id: string) {
    trackAdmin('select_bot');
    setPreferredBot(id);
    try { if (user) localStorage.setItem(`feishu-admin-bot:${user.id}`, id); } catch { /* Optional preference. */ }
    setParams(current => {
      const query = new URLSearchParams(current);
      query.set('bot', id);
      query.delete('chat');
      query.delete('matter');
      query.delete('type');
      query.delete('attention');
      query.delete('q');
      query.delete('from');
      query.delete('to');
      query.delete('requestsOnly');
      return query;
    }, { replace: true });
    resetList();
  }

  function selectChat(id: string, keepType = false) {
    trackAdmin('select_chat');
    const query = new URLSearchParams(params);
    if (!keepType) query.delete('type');
    query.delete('chat');
    if (id === ':group' || id === ':p2p') query.set('type', id.slice(1));
    else if (id) query.set('chat', id);
    query.delete('matter');
    setParams(query, { replace: true });
    resetList();
  }

  function changeListFilter(name: 'q' | 'days' | 'attention', value: string) {
    const query = new URLSearchParams(params);
    query.delete('matter');
    if (name === 'days') {
      query.delete('from');
      query.delete('to');
      query.delete('requestsOnly');
    }
    if (value) query.set(name, value);
    else query.delete(name);
    setParams(query, { replace: true });
    resetList();
  }

  function selectMessageList(key: string, action: 'details' | 'notice_details', trigger: HTMLButtonElement, sequence?: number, matchSequence?: number | null) {
    if (key !== selected) {
      trackAdmin(action);
      setOutcome(null);
    }
    listTrigger.current = trigger;
    listScroll.current = listPanel.current?.scrollTop ?? 0;
    selectedMessage.current = sequence === undefined ? null : { key, sequence };
    setFocusSequence(matchSequence ?? null);
    if (sequence !== undefined && positionScope) {
      try { saveFeishuConversationPosition(window.localStorage, positionScope, { key, sequence, cursors: pages }); } catch { /* Optional preference. */ }
    }
    clearFocusedMatter();
    setSelected(key);
  }

  function viewMatter(id: string, trigger?: HTMLButtonElement, chatId?: string) {
    trackAdmin('view_matter');
    const query = new URLSearchParams(params);
    query.set('view', 'messages');
    query.set('matter', id);
    if (allBots) query.set('bot', 'all');
    else if (chatId) query.set('chat', chatId);
    setParams(query);
    setSelected(null);
    setFocusSequence(null);
    setOutcome(null);
    listTrigger.current = trigger ?? null;
    if (trigger && listPanel.current?.contains(trigger)) listScroll.current = listPanel.current.scrollTop;
  }

  function focusList() {
    requestAnimationFrame(() => {
      if (listPanel.current) listPanel.current.scrollTop = listScroll.current;
      const trigger = listTrigger.current;
      (trigger?.isConnected ? trigger : listHeading.current)?.focus({ preventScroll: true });
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

  function matterActions(matter: Matter, includeHistory = false) {
    const { sessionId, archivedAt, id } = matter;
    return <div className="feishu-row-actions feishu-matter-actions">
      {sessionId && <a className="feishu-button-link" href={`/?session=${encodeURIComponent(sessionId)}`} target="_blank" rel="noopener noreferrer"
        onClick={() => trackAdmin('open_session')} onAuxClick={event => { if (event.button === 1) trackAdmin('open_session'); }}>打开 Relay 会话 <span aria-hidden="true">↗</span><span className="sr-only">（新标签页打开）</span></a>}
      {!archivedAt && <button disabled={actionsDisabled} onClick={() => void change(sessionId ? 'handoff' : 'link', sessionId ? { id, sessionId } : { id })}>
        {sessionId ? '交接到新会话' : '创建 Relay 会话'}</button>}
      <button disabled={actionsDisabled} onClick={() => void change(archivedAt ? 'restore' : 'archive', { id })}>{archivedAt ? '恢复' : '归档'}</button>
      {includeHistory && <button type="button" onClick={() => viewMatter(id)}>事项历史</button>}
    </div>;
  }

  function clearFocusedMatter() {
    if (!focusedMatter) return;
    const query = new URLSearchParams(params);
    query.delete('matter');
    setParams(query, { replace: true });
  }

  function closeMatter() {
    trackAdmin('return_list');
    setOutcome(null);
    clearFocusedMatter();
    focusList();
  }

  function resetList() {
    listScroll.current = 0;
    listPanel.current?.scrollTo({ top: 0 });
    setPagination(null); setSelected(null); setFocusSequence(null); setOutcome(null);
  }
  function pageMessages(next: number | null) {
    trackAdmin('paginate');
    setPagination({ scope: filterScope, cursors: next === null ? pages.slice(0, -1) : [...pages, next] });
    setSelected(null);
    clearFocusedMatter();
    viewport.current?.scrollTo({ top: 0 });
  }

  function openRetry(target: NonNullable<typeof retryTarget>) {
    trackAdmin('open_retry');
    setRetry(target);
  }
  async function change(action: keyof typeof FEISHU_ADMIN_MUTATION_ACTIONS, target: Record<string, string | number>, owner = detailBot) {
    if (!owner || !data || actionsDisabled) {
      if (action === 'retry') throw new Error('请刷新飞书记录后再补发');
      return;
    }
    setOperation('busy'); setOutcome(null);
    try {
      const targetUrl = action === 'convert' || action === 'link' || action === 'handoff' ? `${endpoint}/matters` : endpoint;
      await requestJson(targetUrl, { method: 'POST', ...jsonBody({ bot: owner.id, action, ...target }),
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

  const conversationView = view === 'messages';
  const listFiltered = Boolean(q || attention || chatType || range || requestsOnly);
  const chatFilter = <select aria-label="飞书会话" value={chat || (chatType ? `:${chatType}` : '')} onChange={event => selectChat(event.target.value)}>
    <option value="">全部会话</option>
    <option value=":p2p">全部私聊</option><option value=":group">全部群聊</option>
    {chat && !chats.some(item => item.id === chat) && <option value={chat}>{chatLabel(chat)}</option>}
    {groupChats.length > 0 && <optgroup label="群聊">{groupChats.map(item => <option key={item.id} value={item.id}>{chatLabel(item.id, item.chatType)}</option>)}</optgroup>}
    {privateChats.length > 0 && <optgroup label="私聊">{privateChats.map(item => <option key={item.id} value={item.id}>{chatLabel(item.id, item.chatType)}</option>)}</optgroup>}
  </select>;
  const rangeFilter = <select aria-label="时间范围" value={range ? 'fixed' : days} onChange={event => { trackAdmin('range'); changeListFilter('days', event.target.value); }}>
    {range && <option value="fixed">{formatDateTime(range.from, { short: true })} – {formatDateTime(range.to - 1, { short: true })}</option>}
    <option value="1">最近 24 小时</option>
    <option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option>
  </select>;
  function openRecords(target: Drilldown) {
    trackAdmin('details');
    const query = new URLSearchParams({ view: 'messages', days: String(days), from: String(target.from), to: String(target.to), requestsOnly: '1' });
    if (target.botId || scopeId) query.set('bot', target.botId ?? scopeId!);
    if (target.chatId || chat) query.set('chat', target.chatId ?? chat);
    const type = target.chatType ?? selectedChatType;
    if (type) query.set('type', type);
    if (target.attention) query.set('attention', target.attention);
    setParams(query);
    resetList();
  }
  return <>
  <div className={`feishu-admin${detailKey ? ' is-reading' : ''}`} data-view={view}>
    <header className="feishu-header">
      <div className="feishu-header-inner">
        <div className="feishu-heading">
          <span className="feishu-heading-icon"><UserMenuIcon type="feishu" /></span>
          <h1>{appPageRoutes.feishu_bots.label}</h1>
        </div>
        {view !== 'settings' && bots.length > 0 && <div className="feishu-header-context">
          {(bots.length > 1 || (!scopeReady && bots.length > 0)) ? <select aria-label="当前机器人" value={scopeReady ? scopeId ?? '' : ''} onChange={event => selectBot(event.target.value)}>
            {!scopeReady && <option value="" disabled>选择机器人</option>}
            {bots.length > 1 && <option value="all">全部机器人</option>}
            {bots.map(item => <option key={item.id} value={item.id}>
              {bots.some(other => other.id !== item.id && other.name === item.name) ? `${item.name} · ${item.workspace}` : item.name}
            </option>)}
          </select> : currentBot && <strong>{currentBot.name}</strong>}
        </div>}
        <nav className="feishu-nav" aria-label={appPageRoutes.feishu_bots.label}>
          {viewOrder.map(item => <button key={item} type="button" aria-current={view === item ? 'page' : undefined}
            onClick={() => selectView(item)}>{views[item]}</button>)}
        </nav>
      </div>
    </header>
    <main className={`feishu-scroll${conversationView ? ' is-conversation-view' : ''}`} ref={viewport}>
    <div className="feishu-content">
    {view === 'settings' &&
      <FeishuImSettings botDirectory={bots} editor={editor} onEdit={setEditor} onChanged={() => { resetList(); setRevision(value => value + 1); }} />
    }
    {view !== 'settings' && <>
    {error != null && <FailureNotice error={error} description={data ? '刷新失败，当前显示上次结果' : '读取飞书记录失败'} />}
    {operationResult?.error != null && <FailureNotice error={operationResult.error} description="操作失败" />}
    {operationResult?.message && <p className="feishu-feedback" role="status">{operationResult.message}</p>}
    {loading && !data && (!scopeReady || view !== 'messages') && <p role="status">正在读取…</p>}
    {!loading && !error && !bots.length && <div className="feishu-card feishu-empty-setup"><p>尚未配置飞书机器人。</p>
      <button type="button" onClick={() => selectView('settings')}>前往机器人配置</button></div>}
    {view !== 'users' && !loading && !error && scopeReady && data === null && <p className="feishu-card">所选机器人暂无消息记录。</p>}
    {!loading && !error && requestedBot && bots.length > 0 && !scopeReady && <p className="feishu-card">所选机器人暂不可用。请选择一个机器人查看记录。</p>}
    {view === 'stats' && scopeReady && <div className="feishu-toolbar feishu-stats-toolbar">
      <FeishuStatsFilters days={days} chatType={selectedChatType} chat={chat}
        fixedRange={range ? `${formatDateTime(range.from, { short: true })} – ${formatDateTime(range.to - 1, { short: true })}` : undefined}
        options={currentBot ? [
          ...chats.filter(item => !selectedChatType || item.chatType === selectedChatType || item.id === chat)
            .map(item => ({ ...item, label: chatLabel(item.id, item.chatType) })),
          ...(chat && !chats.some(item => item.id === chat) ? [{ id: chat, label: chatLabel(chat, selectedChatType || undefined) }] : []),
        ] : null}
        onRange={value => { trackAdmin('range'); changeListFilter('days', String(value)); }}
        onType={value => selectChat(value ? `:${value}` : '')} onChat={id => selectChat(id, true)} />
      <button type="button" onClick={refreshRecords} disabled={loading}>刷新</button></div>}
    {view === 'users' && scopeReady && <div className="feishu-toolbar feishu-stats-toolbar"><button type="button" onClick={refreshRecords} disabled={loading}>刷新</button></div>}
    {view === 'messages' && error != null && !scopeReady && <button type="button" onClick={refreshRecords}>重新读取</button>}
    {view === 'users' && scopeReady && scopeId && <FeishuUserAccess key={scopeId} bot={scopeId} bots={bots} revision={revision} />}
    {scopeReady && <>
      {view === 'messages' && <>
        <div className={`feishu-split ${detailKey ? 'has-detail' : ''}`}>
          <section className="feishu-card feishu-message-list" ref={listPanel} aria-label="会话列表">
            <header className="feishu-list-header">
              <div className="feishu-list-heading"><h2 ref={listHeading} tabIndex={-1}>会话</h2>
                {!detailKey && <button type="button" onClick={refreshRecords} disabled={loading}>刷新</button>}</div>
              <form className="feishu-list-search" role="search" onSubmit={event => {
                event.preventDefault();
                const term = searchDraft.trim();
                if (term === q) return;
                trackAdmin('search'); changeListFilter('q', term);
              }}>
                <input type="text" enterKeyHint="search" value={searchDraft} maxLength={120} aria-label="搜索会话、消息或回复" placeholder="搜索会话、消息或回复"
                  onChange={event => setSearchDraft(event.target.value)} />
                {q && <button type="button" className="feishu-clear-search" onClick={() => { trackAdmin('search'); changeListFilter('q', ''); }}>清除</button>}
                <button type="submit">搜索</button>
              </form>
              <div className="feishu-list-filters">{chatFilter}{rangeFilter}
                <select aria-label="会话状态" value={attention} onChange={event => { trackAdmin('filter'); changeListFilter('attention', event.target.value); }}>
                  <option value="">全部状态</option><option value="approval">待审核</option><option value="failed">发送失败</option><option value="unknown">发送待确认</option>
                  {attention === 'reply_failed' && <option value="reply_failed">回复失败</option>}
                  {attention === 'reply_unknown' && <option value="reply_unknown">回复待确认</option>}
                  {attention === 'reply_anomaly' && <option value="reply_anomaly">回复异常</option>}
                </select>
              </div>
            </header>
            {loading && !data && <p className="feishu-record-empty" role="status">正在读取会话…</p>}
            {focusedMatter && !selectedMatter && <p role="status">{focusPending ? '正在读取关联事项…' : '未找到该事项。'}</p>}
            {data?.conversations?.map(item => {
                const matter = matterFor(item);
                return <button type="button" key={conversationKey(item)} className="feishu-row"
                aria-pressed={item === selectedConversation} onClick={event => selectMessageList(conversationKey(item), 'details', event.currentTarget, item.sequence, item.matchSequence ?? item.attentionSequence)}>
                <span className="feishu-row-context">
                  <span className="feishu-override-kind" data-kind={item.chatType}>{item.chatType === 'p2p' ? '私聊' : '群聊'}</span>
                  <span>{conversationChatLabel(item)}</span>
                  {allBots && <span className="feishu-robot-badge" title={ownerOf(item)?.workspace}>{ownerOf(item)?.name}</span>}
                </span>
                <span className="feishu-message-lead"><strong>{conversationName(item)}</strong>
                  {item.relayStatus ? <ExecutionStatus status={item.relayStatus} /> : matter && <MatterStatus matter={matter} />}</span>
                <span className="feishu-preview">{item.matchPreview ?? item.text}</span>
                {(item.deliveryFailed === 1 || item.deliveryUnknown === 1) && <span className="feishu-list-flags">
                  {item.deliveryFailed === 1 && showDelivery('failed')}{item.deliveryUnknown === 1 && showDelivery('unknown')}</span>}
                <small className="feishu-row-meta"><span>{formatDateTime(item.receivedAt, { short: true })}</span><span>{item.total} 条请求</span></small>
              </button>;
            })}
            {[...noticeGroups].map(([key, notices]) => <button key={key} type="button" className="feishu-row" aria-pressed={selected === key}
              onClick={event => selectMessageList(key, 'notice_details', event.currentTarget)}>
              <span className="feishu-row-context"><span>{chatLabel(notices[0].chatId, 'group', notices[0].groupName)}</span>
                {allBots && <span className="feishu-robot-badge" title={ownerOf(notices[0])?.workspace}>{ownerOf(notices[0])?.name}</span>}</span>
              <strong>机器人主动发送</strong><small>{notices.length} 条通知</small>
            </button>)}
            {data && !data.conversations?.length && !noticeGroups.size && <p className="feishu-record-empty">{listFiltered ? '没有符合条件的会话。' : '这段时间没有受理的会话。'}</p>}
            {otherMatters.length > 0 && <details className="feishu-other-matters">
              <summary>其他跟进事项 <small>{otherMatters.length}</small></summary>
              {otherMatters.map(matter => <button type="button" className="feishu-row" key={matter.id} aria-pressed={matter.id === focusedMatter}
                onClick={event => viewMatter(matter.id, event.currentTarget)}>
                <span className="feishu-message-lead"><strong>{matter.title}</strong><MatterStatus matter={matter} /></span>
                <small className="feishu-row-meta"><span>{chatLabel(matter.chatId, 'group', matter.groupName)}{allBots && ` · ${ownerOf(matter)?.name ?? '机器人'}`}</span>
                  <span>{formatDateTime(matter.updatedAt, { short: true })}</span></small>
              </button>)}
            </details>}
            {(before || data?.next) && <div className="feishu-pagination" role="group" aria-label="消息翻页">
              <button disabled={!before || loading} onClick={() => pageMessages(null)}>上一页（较新）</button>
              <button disabled={!data?.next || loading} onClick={() => { if (data?.next) pageMessages(data.next); }}>下一页（较早）</button>
            </div>}
          </section>
          <section className="feishu-card feishu-detail" ref={detailPanel} aria-label="会话详情">
            {selectedMatter && detailBot ? <>
              <header className="feishu-detail-header">
                {detailControls('返回会话列表', closeMatter)}
                <div className="feishu-message-lead"><h2 ref={detailHeading} tabIndex={-1}>{selectedMatter.title}</h2><MatterStatus matter={selectedMatter} /></div>
                <small className="feishu-detail-meta"><span>{chatLabel(selectedMatter.chatId, 'group', selectedMatter.groupName)}</span>
                  {allBots && <span>{detailBot.name} · {detailBot.workspace}</span>}
                  <span>发起人 {feishuIdentityLabel(selectedMatter.sender, selectedMatter.senderName, '群成员')}</span></small>
                {matterActions(selectedMatter)}
                <label className="feishu-matter-range">关联消息 <select value={matterDays} onChange={event => {
                  trackAdmin('range'); setMatterDays(Number(event.target.value));
                }}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></label>
              </header>
              <FeishuTimeline key={`${detailBot.id}:${selectedMatter.id}:${matterDays}`} bot={detailBot.id} chatId={selectedMatter.chatId}
                matterId={selectedMatter.id} days={matterDays} revision={revision} render={renderTurn} />
            </> : selectedConversation && detailBot ? <>
              <header className="feishu-detail-header">
                {detailControls('返回会话列表', closeMessages)}
                <div className="feishu-message-lead"><h2 ref={detailHeading} tabIndex={-1}>{conversationName(selectedConversation)}</h2>
                  {selectedConversation.relayStatus ? <ExecutionStatus status={selectedConversation.relayStatus} />
                    : activeMatter && <MatterStatus matter={activeMatter} />}</div>
                <small className="feishu-detail-meta"><span>{conversationChatLabel(selectedConversation)}</span>
                  {allBots && <span>{detailBot.name} · {detailBot.workspace}</span>}<span>{selectedConversation.total} 条请求</span></small>
                {activeMatter && matterActions(activeMatter, true)}
              </header>
              <FeishuTimeline key={`${conversationKey(selectedConversation)}:${days}:${range?.from ?? ''}:${range?.to ?? ''}:${focusSequence ?? ''}`} bot={detailBot.id} chatId={selectedConversation.chatId}
                conversationId={selectedConversation.conversationId} days={days} range={range} revision={revision} focusSequence={focusSequence}
                onLatest={() => setFocusSequence(null)} render={renderTurn} />
            </> : selectedNotices && detailBot ? <>
              <header className="feishu-detail-header">
                {detailControls('返回会话列表', closeMessages)}
                <h2 ref={detailHeading} tabIndex={-1}>机器人主动发送</h2>
                <small className="feishu-detail-meta"><span>{chatLabel(selectedNotices[0].chatId, 'group', selectedNotices[0].groupName)}</span><span>{selectedNotices.length} 条通知{data?.notices?.length === 30 && ' · 显示筛选范围内最近的通知'}</span></small>
              </header>
              <div className="feishu-timeline">{[...selectedNotices].reverse().map(notice => <article className="feishu-bubble is-bot" key={notice.id}>
                <div className="feishu-bubble-meta"><strong>{detailBot.name}</strong><small>{formatDateTime(notice.createdAt)}</small>
                  {!isDeliveryIssue(notice.state) && showDelivery(notice.state)}</div>
                <pre>{notice.body}</pre>
                <DeliveryActions state={notice.state} active={detailBot.active} disabled={actionsDisabled} label="补发原通知"
                  onRetry={() => openRetry({ scope: operationScope, id: notice.id, owner: detailBot, destination: chatLabel(notice.chatId, 'group', notice.groupName) })} />
                <FeishuDiagnostics fields={[
                  ...(notice.errorCode ? [{ label: '发送错误码', value: notice.errorCode }] : []),
                  ...(notice.sentId ? [{ label: '飞书消息 ID', value: notice.sentId, identifier: true }] : []),
                ]} />
              </article>)}</div>
            </> : <div className="feishu-detail-empty"><p>选择一个会话查看消息和回复。</p></div>}
          </section>
        </div>
      </>}
      {view === 'stats' && data?.overview && <FeishuOverview key={JSON.stringify([scopeId, chat, chatType, days, range, revision])}
        overview={data.overview} bots={bots} allBots={allBots}
        days={days} dimension={dimension} metric={dimension === 'model' ? 'tokens' : metric}
        rankingLoading={loading} rankingUnavailable={rankingUnavailable} chatType={chatType}
        onDimension={value => { trackAdmin('filter'); setDimension(value); }}
        onMetric={value => { trackAdmin('filter'); setMetric(value); }} onOpen={openRecords} />}
    </>}
    <ConfirmDialog open={retry !== null} title="补发飞书消息" tone="warning"
      subject={retry ? { label: '发送到', value: `${retry.destination} · ${retry.owner.name}` } : undefined}
      description="确认后会将原消息加入发送队列，并发送到原飞书会话。"
      confirmLabel="确认补发" pendingLabel="正在提交…" confirmDisabled={actionsDisabled || !bots.find(item => item.id === retry?.owner.id)?.active}
      onCancel={() => { trackAdmin('cancel_retry'); setRetry(null); }}
      onConfirm={async () => { if (!retry) return; await change('retry', { id: retry.id }, retry.owner); setRetry(null); }} />
    </>}
    </div>
    </main>
  </div>
  <WorkspaceFilePreview />
  </>;
}
