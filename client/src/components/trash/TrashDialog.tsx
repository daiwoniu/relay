import Tooltip from '../ui/Tooltip';
import FailureNotice from '../ui/FailureNotice';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrashImpactDto, TrashProjectDto, TrashSessionDto } from '../../generated/relay-contracts';
import {
  TRASH_PAGE_SIZE,
  getTrashProjectImpact,
  getTrashSessionImpact,
  getTrashSessionPreview,
  listTrashProjectSessions,
  listTrashProjects,
  listTrashSessionMatches,
  listTrashSessionProjects,
  listTrashSessions,
  permanentlyDeleteTrashProject,
  permanentlyDeleteTrashSession,
  restoreTrashProject,
  restoreTrashSession,
  type TrashMessagePreview,
  type TrashSessionProject,
} from '../../api/trash';
import PanelShell from '../ui/PanelShell';
import ConfirmDialog from '../ui/ConfirmDialog';
import { ListPagination, ListState } from '../ui/ListControls';
import { getValidTrashOffset } from './trash-pagination';
import { getTrashRestoreNotice, hasTrashRestoreWarning } from './trash-restore-presentation';
import { invalidateWorkspaceDashboard } from '../workspace-console/workspace-console-cache';
import { splitTrashHighlight } from './trash-search-presentation';
import { runTrashSessionBatch } from './trash-session-batch';

type Tab = 'projects' | 'sessions';
type Action =
  | { kind: 'restore-project'; item: TrashProjectDto }
  | { kind: 'restore-session'; item: TrashSessionDto }
  | { kind: 'delete-project'; item: TrashProjectDto; impact: TrashImpactDto }
  | { kind: 'delete-session'; item: TrashSessionDto; impact: TrashImpactDto };
type BatchAction =
  | { kind: 'restore'; items: TrashSessionDto[] }
  | { kind: 'delete'; items: (TrashSessionDto & { impact: TrashImpactDto })[]; blocked: { item: TrashSessionDto; message: string }[] };

const formatTime = (value: number) => new Date(value).toLocaleString();
const formatPreviewTime = (value: number) => new Date(value).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const formatBytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
const highlight = (value: string, query: string) => splitTrashHighlight(value, query).map((part, index) => part.match ? <mark key={index} className="trash-dialog__highlight">{part.text}</mark> : <span key={index}>{part.text}</span>);
const previewMessages = (messages: TrashMessagePreview[], query = '') => messages.map((message) => <div key={message.id} className={`trash-dialog__preview-message trash-dialog__preview-message--${message.role}`}><div className="trash-dialog__preview-meta"><span>{message.role === 'user' ? '你' : message.role === 'assistant' ? '助手' : '系统'}</span><time dateTime={new Date(message.createdAt).toISOString()}>{formatPreviewTime(message.createdAt)}</time></div><p>{query ? highlight(message.content, query) : message.content || '（空消息）'}</p></div>);

export default function TrashDialog({ open, admin, onClose, onChanged }: {
  open: boolean;
  admin: boolean;
  onClose(): void;
  onChanged(): void;
}) {
  const [tab, setTab] = useState<Tab>('sessions');
  const [projects, setProjects] = useState<TrashProjectDto[]>([]);
  const [sessions, setSessions] = useState<TrashSessionDto[]>([]);
  const [total, setTotal] = useState({ projects: 0, sessions: 0 });
  const [resultTotal, setResultTotal] = useState({ projects: 0, sessions: 0 });
  const [offset, setOffset] = useState({ projects: 0, sessions: 0 });
  const [draftQuery, setDraftQuery] = useState({ projects: '', sessions: '' });
  const [appliedQuery, setAppliedQuery] = useState({ projects: '', sessions: '' });
  const [projectId, setProjectId] = useState('');
  const [projectOptions, setProjectOptions] = useState<TrashSessionProject[]>([]);
  const [expanded, setExpanded] = useState<Record<string, TrashSessionDto[] | undefined>>({});
  const [previews, setPreviews] = useState<Record<string, TrashMessagePreview[] | undefined>>({});
  const [matchViews, setMatchViews] = useState<Record<string, { items: TrashMessagePreview[]; total: number; offset: number }>>({});
  const [viewMode, setViewMode] = useState<Record<string, 'preview' | 'match'>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ message: string; tone: 'success' | 'warning' } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [impactLoadingId, setImpactLoadingId] = useState<string | null>(null);
  const [confirmationName, setConfirmationName] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchAction, setBatchAction] = useState<BatchAction | null>(null);
  const [batchPreparing, setBatchPreparing] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');
  const allSelectedRef = useRef<HTMLInputElement>(null);
  const batchRequestSeq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);
  const matchRequestSeq = useRef<Record<string, number>>({});
  const searchGeneration = useRef(0);

  const load = useCallback(async (targetTab: Tab, targetOffset: number, preserveScroll = false) => {
    const sequence = ++requestSeq.current;
    const scrollTop = preserveScroll ? bodyRef.current?.scrollTop ?? 0 : null;
    if (!preserveScroll) setLoading(true);
    setError('');
    try {
      if (targetTab === 'projects') {
        const response = await listTrashProjects(TRASH_PAGE_SIZE, targetOffset, appliedQuery.projects);
        if (sequence !== requestSeq.current) return;
        const validOffset = getValidTrashOffset(response.total, targetOffset, TRASH_PAGE_SIZE);
        setResultTotal((value) => ({ ...value, projects: response.total }));
        if (!appliedQuery.projects) setTotal((value) => ({ ...value, projects: response.total }));
        if (validOffset !== targetOffset) {
          setOffset((value) => ({ ...value, projects: validOffset }));
          return;
        }
        setProjects(response.items);
      } else {
        const response = await listTrashSessions(TRASH_PAGE_SIZE, targetOffset, appliedQuery.sessions, projectId);
        if (sequence !== requestSeq.current) return;
        const validOffset = getValidTrashOffset(response.total, targetOffset, TRASH_PAGE_SIZE);
        setResultTotal((value) => ({ ...value, sessions: response.total }));
        if (!appliedQuery.sessions && !projectId) setTotal((value) => ({ ...value, sessions: response.total }));
        if (validOffset !== targetOffset) {
          setOffset((value) => ({ ...value, sessions: validOffset }));
          return;
        }
        setSessions(response.items);
        setSelectedIds((value) => new Set(response.items.filter((item) => value.has(item.id)).map((item) => item.id)));
      }
    } catch (cause) { if (sequence === requestSeq.current) setError(cause instanceof Error ? cause.message : '加载回收站失败'); }
    finally {
      if (sequence !== requestSeq.current) return;
      setLoading(false);
      if (scrollTop !== null) {
        requestAnimationFrame(() => {
          if (bodyRef.current) bodyRef.current.scrollTop = scrollTop;
        });
      }
    }
  }, [appliedQuery, projectId]);

  const loadTotal = useCallback(async (targetTab: Tab) => {
    try {
      const response = targetTab === 'projects'
        ? await listTrashProjects(1, 0)
        : await listTrashSessions(1, 0);
      setTotal((value) => ({ ...value, [targetTab]: response.total }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载回收站失败');
    }
  }, []);

  const refreshProjectOptions = useCallback(async () => {
    try {
      const options = await listTrashSessionProjects();
      setProjectOptions(options);
      setProjectId((current) => current && !options.some((project) => project.id === current) ? '' : current);
    } catch { return; }
  }, []);

  useEffect(() => { if (open) void load(tab, offset[tab]); }, [load, offset, open, tab]);
  useEffect(() => { if (open) void loadTotal(tab === 'projects' ? 'sessions' : 'projects'); }, [loadTotal, open, tab]);
  useEffect(() => { if (open) void refreshProjectOptions(); }, [open, refreshProjectOptions]);
  useEffect(() => { if (!open) { setAction(null); setConfirmationName(''); setNotice(null); } }, [open]);
  useEffect(() => {
    batchRequestSeq.current += 1;
    setSelectedIds(new Set()); setBatchAction(null); setBatchPreparing(false); setBatchProgress('');
    return () => { batchRequestSeq.current += 1; };
  }, [open, tab, appliedQuery, projectId, offset.sessions]);
  const selectedSessions = sessions.filter((session) => selectedIds.has(session.id));
  const allSelected = sessions.length > 0 && selectedSessions.length === sessions.length;
  const batchBusy = batchPreparing || batchRunning;
  const batchDisabled = !selectedSessions.length || loading || batchBusy || action !== null || impactLoadingId !== null;
  useEffect(() => {
    if (allSelectedRef.current) allSelectedRef.current.indeterminate = selectedSessions.length > 0 && !allSelected;
  }, [allSelected, selectedSessions.length, loading, open, tab]);

  const toggleSession = (id: string) => setSelectedIds((value) => {
    const next = new Set(value);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const prepareBatch = async (kind: 'restore' | 'delete') => {
    if (!selectedSessions.length || batchPreparing || batchRunning || action || impactLoadingId || (kind === 'delete' && !admin)) return;
    setError(''); setNotice(null);
    if (kind === 'restore') { setBatchAction({ kind, items: selectedSessions }); return; }
    const sequence = ++batchRequestSeq.current;
    setBatchPreparing(true);
    try {
      const result = await runTrashSessionBatch(selectedSessions, (item) => getTrashSessionImpact(item.id), () => {}, () => sequence === batchRequestSeq.current);
      if (sequence !== batchRequestSeq.current) return;
      const items = result.succeeded.map(({ item, value: impact }) => ({ ...item, impact }));
      if (result.failed.length) setError(`${result.failed.length} 个会话无法准备删除，未纳入本次确认。请先恢复相关会话，核对未决追加消息或任务状态。` + result.failed.map(({ item, message }) => `「${item.title}」：${message}`).join('；'));
      if (items.length) setBatchAction({ kind, items, blocked: result.failed });
    } catch (cause) {
      if (sequence === batchRequestSeq.current) setError(cause instanceof Error ? cause.message : '读取批量删除影响失败，请刷新后重试');
    } finally { if (sequence === batchRequestSeq.current) setBatchPreparing(false); }
  };

  const submitSearch = () => {
    const query = draftQuery[tab].trim();
    searchGeneration.current += 1;
    setMatchViews({}); setViewMode({});
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    const filtersChanged = query !== appliedQuery[tab] || offset[tab] !== 0;
    if (filtersChanged) {
      requestSeq.current += 1;
      setLoading(true);
      if (tab === 'projects') setProjects([]);
      else setSessions([]);
    }
    setOffset((value) => value[tab] === 0 ? value : { ...value, [tab]: 0 });
    if (!filtersChanged) void load(tab, 0);
    else setAppliedQuery((value) => ({ ...value, [tab]: query }));
  };
  const changeProject = (value: string) => {
    if (value === projectId) return;
    searchGeneration.current += 1;
    requestSeq.current += 1;
    setLoading(true);
    setProjectId(value);
    setSessions([]);
    setOffset((current) => current.sessions === 0 ? current : { ...current, sessions: 0 });
    setMatchViews({}); setViewMode({});
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  const clearKeyword = () => {
    searchGeneration.current += 1;
    const filtersChanged = Boolean(appliedQuery[tab] || offset[tab] !== 0);
    if (filtersChanged) {
      requestSeq.current += 1;
      setLoading(true);
    }
    setDraftQuery((value) => ({ ...value, [tab]: '' }));
    setAppliedQuery((value) => ({ ...value, [tab]: '' }));
    setOffset((value) => value[tab] === 0 ? value : { ...value, [tab]: 0 });
    setMatchViews({}); setViewMode({});
    if (filtersChanged) {
      if (tab === 'projects') setProjects([]);
      else setSessions([]);
    }
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  const clearFilters = () => {
    clearKeyword();
    if (tab === 'sessions' && projectId) changeProject('');
  };

  const toggleProject = async (project: TrashProjectDto) => {
    if (project.id in expanded) {
      setExpanded((value) => { const next = { ...value }; delete next[project.id]; return next; });
      return;
    }
    setExpanded((value) => ({ ...value, [project.id]: undefined }));
    try {
      const response = await listTrashProjectSessions(project.id);
      setExpanded((value) => ({ ...value, [project.id]: response.items }));
    } catch (cause) {
      setExpanded((value) => { const next = { ...value }; delete next[project.id]; return next; });
      setError(cause instanceof Error ? cause.message : '加载项目会话失败');
    }
  };

  const prepareDelete = async (kind: 'project' | 'session', item: TrashProjectDto | TrashSessionDto) => {
    setImpactLoadingId(item.id); setError('');
    try {
      const impact = kind === 'project' ? await getTrashProjectImpact(item.id) : await getTrashSessionImpact(item.id);
      setConfirmationName('');
      setAction(kind === 'project'
        ? { kind: 'delete-project', item: item as TrashProjectDto, impact }
        : { kind: 'delete-session', item: item as TrashSessionDto, impact });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '读取删除影响失败'); }
    finally { setImpactLoadingId(null); }
  };
  const togglePreview = async (sessionId: string) => {
    if (viewMode[sessionId] === 'preview') { setViewMode((v) => { const n = { ...v }; delete n[sessionId]; return n; }); return; }
    setViewMode((v) => ({ ...v, [sessionId]: 'preview' }));
    if (sessionId in previews) return;
    setPreviews((v) => ({ ...v, [sessionId]: undefined }));
    try { const messages = await getTrashSessionPreview(sessionId); setPreviews((v) => ({ ...v, [sessionId]: messages })); }
    catch (cause) {
      setPreviews((value) => { const next = { ...value }; delete next[sessionId]; return next; });
      setViewMode((value) => { if (value[sessionId] !== 'preview') return value; const next = { ...value }; delete next[sessionId]; return next; });
      setError(cause instanceof Error ? cause.message : '加载消息预览失败');
    }
  };

  const viewMatch = async (sessionId: string, targetOffset = 0) => {
    if (viewMode[sessionId] === 'match' && matchViews[sessionId]?.offset === targetOffset) {
      setViewMode((value) => { const next = { ...value }; delete next[sessionId]; return next; }); return;
    }
    setViewMode((value) => ({ ...value, [sessionId]: 'match' }));
    const generation = searchGeneration.current;
    const sequence = (matchRequestSeq.current[sessionId] ?? 0) + 1;
    matchRequestSeq.current[sessionId] = sequence;
    setMatchViews((value) => { const next = { ...value }; delete next[sessionId]; return next; });
    try {
      const response = await listTrashSessionMatches(sessionId, appliedQuery.sessions, targetOffset);
      if (generation === searchGeneration.current && sequence === matchRequestSeq.current[sessionId]) setMatchViews((value) => ({ ...value, [sessionId]: { ...response, offset: targetOffset } }));
    } catch (cause) {
      if (generation === searchGeneration.current && sequence === matchRequestSeq.current[sessionId]) {
        setViewMode((value) => { const next = { ...value }; delete next[sessionId]; return next; });
        setError(cause instanceof Error ? cause.message : '加载命中消息失败');
      }
    }
  };

  const finishMutation = async (message: string, tone: 'success' | 'warning' = 'success') => {
    setAction(null); setConfirmationName(''); setNotice({ message, tone });
    invalidateWorkspaceDashboard();
    onChanged();
    await load(tab, offset[tab], true);
    if (appliedQuery[tab] || (tab === 'sessions' && projectId)) void loadTotal(tab);
    void loadTotal(tab === 'projects' ? 'sessions' : 'projects');
    void refreshProjectOptions();
  };

  const confirmBatch = async () => {
    if (!batchAction || batchRunning || (batchAction.kind === 'delete' && !admin)) return;
    const batch = batchAction;
    const entries: (TrashSessionDto & { impact?: TrashImpactDto })[] = batch.items;
    setBatchRunning(true); setError('');
    try {
      const result = await runTrashSessionBatch(entries, async (item) => {
        if (batch.kind === 'restore') {
          const restored = await restoreTrashSession(item.id);
          return { warning: hasTrashRestoreWarning(restored), cleanupPending: false };
        }
        if (!item.impact) throw new Error('缺少删除影响，请重新确认');
        const deleted = await permanentlyDeleteTrashSession(item.id, { impactRevision: item.impact.impactRevision });
        return { warning: false, cleanupPending: deleted.cleanupPending };
      }, (completed, count) => setBatchProgress(`已处理 ${completed} / ${count} 个会话`));
      const warnings = result.succeeded.filter(({ value }) => value.warning).length;
      const cleanupPending = result.succeeded.filter(({ value }) => value.cleanupPending).length;
      const failed = [...(batch.kind === 'delete' ? batch.blocked : []), ...result.failed];
      const operation = batch.kind === 'restore' ? '恢复' : '彻底删除';
      const summary = `已${operation} ${result.succeeded.length} 个会话${failed.length ? `，${failed.length} 个未处理或结果待核对` : ''}。`
        + (warnings ? `${warnings} 个会话的 Codex 归档状态需核对。` : '')
        + (cleanupPending ? `${cleanupPending} 个会话的部分空间待后台清理。` : '');
      setSelectedIds(new Set(failed.map(({ item }) => item.id)));
      await finishMutation(summary, failed.length || warnings ? 'warning' : 'success');
      if (failed.length) setError(failed.map(({ item, message }) => `${item.title}：${message}`).join('；'));
      setBatchAction(null);
    } finally { setBatchRunning(false); setBatchProgress(''); }
  };

  const selectTab = (value: Tab) => {
    if (value === tab) return;
    setNotice(null);
    setTab(value);
  };

  const confirmAction = async () => {
    if (!action) return;
    try {
      const project = action.kind.endsWith('project');
      if (action.kind === 'restore-project' || action.kind === 'restore-session') {
        const result = await (project ? restoreTrashProject : restoreTrashSession)(action.item.id);
        await finishMutation(getTrashRestoreNotice(project ? 'project' : 'session', result), hasTrashRestoreWarning(result) ? 'warning' : 'success');
      } else {
        const input = { impactRevision: action.impact.impactRevision };
        const result = project ? await permanentlyDeleteTrashProject(action.item.id, { ...input, confirmationName }) : await permanentlyDeleteTrashSession(action.item.id, input);
        await finishMutation(result.cleanupPending ? '数据已删除，部分空间待后台清理。' : `${project ? '项目' : '会话'}及 Relay 托管附件已彻底删除。`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); throw cause; }
  };

  const currentItems = tab === 'projects' ? projects : sessions;
  const currentOffset = offset[tab];
  const currentTotal = resultTotal[tab];
  const filterActive = Boolean(appliedQuery[tab] || (tab === 'sessions' && projectId));
  const danger = batchAction?.kind === 'delete' || action?.kind === 'delete-project' || action?.kind === 'delete-session';
  const actionImpact = batchAction?.kind === 'delete' ? batchAction.items.reduce((sum, item) => ({
    messageCount: sum.messageCount + item.impact.messageCount, shareCount: sum.shareCount + item.impact.shareCount,
    attachmentCount: sum.attachmentCount + item.impact.attachmentCount, releasableBytes: sum.releasableBytes + item.impact.releasableBytes,
  }), { messageCount: 0, shareCount: 0, attachmentCount: 0, releasableBytes: 0 }) : action && 'impact' in action ? action.impact : null;
  const actionName = action?.kind.endsWith('project') ? (action.item as TrashProjectDto).name : action ? (action.item as TrashSessionDto).title : '';
  const confirmationDescription = <>
    {batchAction ? <>{danger ? '以下可删除会话将彻底删除，无法从 Relay 恢复。' : '所选会话将恢复到各自的原项目中。'}{batchAction.kind === 'delete' && batchAction.blocked.length > 0 && <p>另有 {batchAction.blocked.length} 个会话被阻止，未纳入本次删除。</p>}{batchRunning && <p role="status">{batchProgress}</p>}</>
      : action?.kind === 'delete-project' ? <div><p>输入完整项目名 <strong>{action.item.name}</strong> 以确认：</p><input value={confirmationName} onChange={(event) => setConfirmationName(event.target.value)} autoComplete="off" enterKeyHint="done" className="trash-dialog__confirm-input" /></div>
      : danger ? '彻底删除后无法从 Relay 恢复。'
        : action?.kind === 'restore-project' ? `将恢复项目及其中 ${action.item.sessionCount} 个会话。`
          : '会话会重新出现在原项目中。'}
    {error && <div role="alert" className="trash-dialog__confirm-error"><FailureNotice error={error} /></div>}
  </>;

  return <>
    <PanelShell open={open} onClose={() => { if (!batchRunning) onClose(); }} title="回收站" description="恢复误删内容，或由管理员手动彻底删除" titleId="trash-dialog-title" size="content" navigation={<>
      <div className="trash-dialog__tabs" role="tablist" aria-label="回收站类型">
        {(['sessions', 'projects'] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => selectTab(value)} className={`trash-dialog__tab${tab === value ? ' trash-dialog__tab--active' : ''}`}>{value === 'projects' ? `项目 ${total.projects}` : `会话 ${total.sessions}`}</button>)}
      </div>
      <form className="trash-dialog__filters" onSubmit={(event) => { event.preventDefault(); submitSearch(); }} role="search">
        {tab === 'sessions' && <label className="trash-dialog__project-filter"><span className="sr-only">按项目筛选会话</span><select value={projectId} onChange={(event) => changeProject(event.target.value)} aria-label="按项目筛选会话"><option value="">全部项目</option>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.path}</option>)}</select></label>}
        <div className="trash-dialog__search-field"><input type="search" value={draftQuery[tab]} onChange={(event) => setDraftQuery((value) => ({ ...value, [tab]: event.target.value }))} placeholder={tab === 'sessions' ? '搜索标题或消息内容' : '搜索项目、会话或消息'} aria-label="回收站关键词" enterKeyHint="search" />
          {draftQuery[tab] && <button type="button" className="trash-dialog__search-clear" aria-label="清除关键词" onClick={clearKeyword}>×</button>}
          <Tooltip content="搜索" asChild><button type="submit" className="trash-dialog__search-submit" aria-label="搜索回收站"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" /><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button></Tooltip>
        </div>
      </form>
      {filterActive && <div className="trash-dialog__result-summary">筛选结果 {currentTotal} 条</div>}
      {tab === 'sessions' && sessions.length > 0 && <div className="trash-dialog__batch-bar" aria-label="批量管理会话">
        <label className="trash-dialog__select-all"><input ref={allSelectedRef} type="checkbox" checked={allSelected} disabled={loading || batchBusy} onChange={(event) => setSelectedIds(event.target.checked ? new Set(sessions.map((session) => session.id)) : new Set())} />全选本页</label>
        <span className="trash-dialog__selection-count" aria-live="polite">已选 {selectedSessions.length} 项</span>
        <div className="trash-dialog__actions">
          <button type="button" className="trash-dialog__restore" disabled={batchDisabled} onClick={() => void prepareBatch('restore')}>批量恢复</button>
          {admin && <button type="button" className="trash-dialog__delete" disabled={batchDisabled} onClick={() => void prepareBatch('delete')}>{batchPreparing ? '读取影响…' : '批量彻底删除'}</button>}
        </div>
      </div>}
      <div className="trash-dialog__alerts">
        {notice && <div className={`trash-dialog__alert trash-dialog__alert--${notice.tone}`}>{notice.message}</div>}
        {error && currentItems.length > 0 && <div role="alert" className="trash-dialog__alert trash-dialog__alert--danger"><FailureNotice error={error} /></div>}
      </div>
    </>} bodyRef={bodyRef} bodyClassName="trash-dialog__body" footer={currentTotal > TRASH_PAGE_SIZE ? <ListPagination
      start={currentOffset + 1}
      end={Math.min(currentOffset + TRASH_PAGE_SIZE, currentTotal)}
      total={currentTotal}
      hasPrevious={currentOffset > 0}
      hasNext={currentOffset + TRASH_PAGE_SIZE < currentTotal}
      loading={loading}
      onPrevious={() => setOffset((value) => ({ ...value, [tab]: Math.max(0, value[tab] - TRASH_PAGE_SIZE) }))}
      onNext={() => setOffset((value) => ({ ...value, [tab]: value[tab] + TRASH_PAGE_SIZE }))}
      className="trash-dialog__pagination"
    /> : undefined}>
        {loading ? <ListState kind="loading" title="正在读取回收站…" />
          : error && currentItems.length === 0 ? <ListState kind="error" title="回收站加载失败" detail={error} onRetry={() => void load(tab, offset[tab])} />
            : currentItems.length === 0 ? <ListState kind="empty" icon="✓" title={filterActive ? '没有符合条件的内容' : '这里是空的'} detail={filterActive ? <button type="button" className="trash-dialog__clear-filters" onClick={clearFilters}>清除筛选</button> : <>删除的{tab === 'projects' ? '项目' : '会话'}会出现在这里</>} /> : <div className="trash-dialog__list">
          {tab === 'projects' ? projects.map((project) => <article key={project.id} className="trash-dialog__card">
            <div className="trash-dialog__row">
              <button type="button" onClick={() => void toggleProject(project)} aria-label={`${project.id in expanded ? '收起' : '展开'}项目 ${project.name}`} aria-expanded={project.id in expanded} className="trash-dialog__expand"><svg viewBox="0 0 14 14" aria-hidden="true" className={`trash-dialog__expand-icon${project.id in expanded ? ' trash-dialog__expand-icon--expanded' : ''}`}><path d="m5 3.5 3.5 3.5L5 10.5" /></svg></button>
              <div className="trash-dialog__item">
                <div className="trash-dialog__item-title">{highlight(project.name, appliedQuery.projects)}</div>
                <div className="trash-dialog__item-path">{highlight(project.path, appliedQuery.projects)}</div>
                <div className="trash-dialog__item-meta">{project.sessionCount} 个会话 · 删除于 {formatTime(project.deletedAt)}</div>
              </div>
              <div className="trash-dialog__actions"><button type="button" onClick={() => setAction({ kind: 'restore-project', item: project })} className="trash-dialog__restore">恢复</button>{admin && <button type="button" disabled={impactLoadingId === project.id} onClick={() => void prepareDelete('project', project)} className="trash-dialog__delete">彻底删除</button>}</div>
            </div>
            {project.matchSessionTitle && <div className="trash-dialog__hit"><span>匹配会话：{highlight(project.matchSessionTitle, appliedQuery.projects)}</span>{project.matchSnippet && <span className="trash-dialog__hit-snippet">{highlight(project.matchSnippet, appliedQuery.projects)}</span>}{project.matchCount && <small>该会话 {project.matchCount} 条消息匹配</small>}</div>}
            {project.id in expanded && <div className="trash-dialog__sessions">{expanded[project.id] === undefined ? <div className="trash-dialog__muted">加载会话中…</div> : expanded[project.id]?.length === 0 ? <div className="trash-dialog__muted">项目中没有会话</div> : <>{project.matchSessionId && !expanded[project.id]?.some((session) => session.id === project.matchSessionId) && <div className="trash-dialog__session trash-dialog__session--match"><span>{highlight(project.matchSessionTitle ?? '', appliedQuery.projects)}</span><small>{project.matchSessionMessageCount ?? 0} 条消息 · 位于前 100 条之外</small></div>}{expanded[project.id]?.map((session) => <div key={session.id} className={`trash-dialog__session${session.id === project.matchSessionId ? ' trash-dialog__session--match' : ''}`}><span>{highlight(session.title, appliedQuery.projects)}</span><small>{session.engine || '未知引擎'} · {session.messageCount} 条消息</small></div>)}{project.sessionCount > (expanded[project.id]?.length ?? 0) && <div className="trash-dialog__muted">仅显示前 {expanded[project.id]?.length} 个会话，共 {project.sessionCount} 个</div>}</>}</div>}
          </article>) : sessions.map((session) => <article key={session.id} className="trash-dialog__card">
            <div className="trash-dialog__row">
              <input type="checkbox" className="trash-dialog__checkbox" aria-label={`选择会话 ${session.title}`} checked={selectedIds.has(session.id)} disabled={batchBusy} onChange={() => toggleSession(session.id)} />
              <div className="trash-dialog__item"><div className="trash-dialog__item-title">{highlight(session.title, appliedQuery.sessions)}</div><div className="trash-dialog__item-meta">{highlight(session.projectName, appliedQuery.sessions)} · {session.engine || '未知引擎'} · {session.messageCount} 条消息</div><div className="trash-dialog__item-path">删除于 {formatTime(session.deletedAt)}</div></div>
              <div className="trash-dialog__actions"><button type="button" disabled={batchBusy} onClick={() => setAction({ kind: 'restore-session', item: session })} className="trash-dialog__restore">恢复</button>{admin && <button type="button" disabled={impactLoadingId === session.id || batchBusy} onClick={() => void prepareDelete('session', session)} className="trash-dialog__delete">彻底删除</button>}</div>
            </div>
            {session.matchSnippet && <div className="trash-dialog__hit"><span>匹配消息</span><span className="trash-dialog__hit-snippet">“{highlight(session.matchSnippet, appliedQuery.sessions)}”</span>{session.matchCount && <small>共 {session.matchCount} 条消息匹配</small>}</div>}
            <div className="trash-dialog__secondary-actions"><button type="button" aria-expanded={viewMode[session.id] === 'preview'} className={`trash-dialog__preview-toggle${viewMode[session.id] === 'preview' ? ' trash-dialog__preview-toggle--active' : ''}`} onClick={() => void togglePreview(session.id)}>预览</button>{session.matchMessageId && <button type="button" aria-expanded={viewMode[session.id] === 'match'} className={`trash-dialog__preview-toggle${viewMode[session.id] === 'match' ? ' trash-dialog__preview-toggle--active' : ''}`} onClick={() => void viewMatch(session.id)}>查看命中</button>}</div>
            {viewMode[session.id] && <div className="trash-dialog__preview">
              <div className="trash-dialog__preview-heading">{viewMode[session.id] === 'match' ? `命中消息 ${matchViews[session.id] ? matchViews[session.id].offset + 1 : 1} / ${matchViews[session.id]?.total ?? session.matchCount ?? 1}` : '最近 5 个回合'}</div>
              {viewMode[session.id] === 'match' ? matchViews[session.id] === undefined ? <div className="trash-dialog__muted">加载命中消息中…</div> : <>{previewMessages(matchViews[session.id].items, appliedQuery.sessions)}<div className="trash-dialog__match-pagination"><button type="button" disabled={matchViews[session.id].offset <= 0} onClick={() => void viewMatch(session.id, matchViews[session.id].offset - 1)}>上一处</button><button type="button" disabled={matchViews[session.id].offset + 1 >= matchViews[session.id].total} onClick={() => void viewMatch(session.id, matchViews[session.id].offset + 1)}>下一处</button></div></> : previews[session.id] === undefined ? <div className="trash-dialog__muted">加载消息中…</div> : previews[session.id]?.length ? previewMessages(previews[session.id] ?? []) : <div className="trash-dialog__muted">没有可预览的消息</div>}
            </div>}
          </article>)}
        </div>}
    </PanelShell>
    <ConfirmDialog open={action !== null || batchAction !== null} eyebrow={danger ? '不可撤销' : '恢复确认'} title={batchAction ? `${danger ? '彻底删除' : '恢复'}所选 ${batchAction.items.length} 个会话？` : danger ? `彻底删除${action?.kind === 'delete-project' ? '项目' : '会话'}？` : `恢复${action?.kind === 'restore-project' ? '项目' : '会话'}？`} tone={danger ? 'danger' : 'neutral'} description={confirmationDescription} subject={batchAction ? { label: '所选会话', value: <ul className="trash-dialog__batch-subjects">{batchAction.items.map((item) => <li key={item.id}>{item.title}</li>)}</ul> } : action ? { label: action.kind.endsWith('project') ? '项目' : '会话', value: actionName } : undefined} impacts={actionImpact ? [`删除 ${actionImpact.messageCount} 条消息与 ${actionImpact.shareCount} 条分享`, `删除 ${actionImpact.attachmentCount} 个 Relay 托管附件，预计释放 ${formatBytes(actionImpact.releasableBytes)}`, '用户源文件、项目目录和 Codex JSONL 不会删除'] : []} notice={danger ? { tone: 'danger', title: '恢复会话可能受影响', description: '相关分享与 Relay 托管附件也会删除，后续无法依靠这些数据完整恢复。' } : undefined} confirmLabel={danger ? '彻底删除' : '恢复'} confirmDisabled={action?.kind === 'delete-project' && confirmationName !== action.item.name} onCancel={() => { setAction(null); setBatchAction(null); setConfirmationName(''); setError(''); }} onConfirm={batchAction ? confirmBatch : confirmAction} />
  </>;
}
