import { formatDateTime } from '../../utils/date-display.ts';
import { useFeatureView,featureAction,useSearchCommit,localAction } from '../../analytics/features';
import Tooltip from '../ui/Tooltip';
import FailureNotice from '../ui/FailureNotice';
import { workbenchParticipationLabel } from './workspace-console-view-model';
import WorkspaceResponsibilityNotice from './WorkspaceResponsibilityNotice';
import FeishuIdentity from './FeishuIdentity';
import { workItemCurrentNodeLines, workItemCurrentNodeNames, localLedgerLabel } from './workspace-console-view-model';
import DeliveryFeishuNotice from './DeliveryFeishuNotice';
import MatterTaskCard from './MatterTaskCard';
import NewBadge from './NewBadge';
import {snapshotTaskIdentityKeys,retainNewTaskKeys} from './workspace-console-view-model';
import type {CardRelation} from './task-card-model';
import {invalidateWorkspaceDashboard} from './workspace-console-cache';
import { unifyTaskEntries, trackingItemsForMatters, selectMatterEntries,workbenchTaskLanes,isWorkbenchTaskVisible } from './workspace-matters';
import RunRow from './WorkspaceRunRow';
import { describeRunScope } from './run-presentation';
import { trackedOpenFeishuItems, isPersonalProjectComplete, taskEntryConflict, workbenchFlowEnded, feishuWorkItemStatusLabel } from './workspace-console-view-model';
import { localTaskStatusLabel, localTaskLane as localTaskLaneForDisplay, taskEntryProgressAt, type TaskDisplayEntry } from './workspace-console-view-model';
import { progressRecency, withDashboardProgress } from './workspace-task-progress';
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getWorkspaceConsoleDashboard, getWorkspaceConsoleResponsibility, getWorkspaceOperationRecords } from '../../api/workspace-console';
import { useAuth } from '../../auth/AuthContext';
import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto, WorkspaceConsoleRunDto, WorkspaceOperationRecordsDto } from '../../generated/relay-contracts';
import { useChatStore } from '../../stores/chat';
import { useChinaDayGreeting } from '../../hooks/useChinaDayGreeting';
import { useFilePreview } from '../messages/useFilePreview';
import { coalesceWorkspaceRequest, loadWorkspaceDashboard, readWorkspaceConsoleCache, rememberResponsibility } from './workspace-console-cache';
import { buildExecutionCards, buildTaskEntries, buildWorkspaceConsoleView, currentNodeResponsibilityLabel, distributeFocusEntries, feishuUrlForWorkItem, filterTaskEntries, focusColumnCount, formatSessionActivity, groupTaskEntriesByLane, taskRecordCounts, isFinishedProjectIssue, latestTaskRecordAt, localLedgersForParent, newTaskEntryKeys, prioritizeTaskEntries, projectItemsForTask, projectTaskCardDetails, runsForTask, runsForTasks, selectFocusEntries, sortDetailLocalTasks, sortDetailSubtasks, taskDisplayEntryIsNew, taskEntryLane, workbenchSubtaskNodeLabel, workbenchSubtaskStatusLabel, type ObservationCard, type TaskAssociationFilter, type TaskEntry, type TaskGroup, type TaskLane } from './workspace-console-view-model';
import WorkspaceChildSessionActions from './WorkspaceChildSessionActions';
import {Drawer,Block,DetailDisclosure,DetailText} from './WorkspaceDetailUI';
import WorkspaceSourceTimes from './WorkspaceSourceTimes';
import WorkspaceHelpBadge from './WorkspaceHelpBadge';
import {buildSummaryStatusIndex,summaryStatusOptions,filterLanesBySummary} from './workspace-summary-filter';
import {readWorkspaceRefreshTimes,rememberWorkspaceRefreshTime,trackSuccessfulWorkspaceRefresh,type WorkspaceRefreshTimes} from './workspace-source-times';
import { stateFlowResponsibilityLabel } from './workspace-console-view-model';
import WorkspaceCodexResourceCard from './WorkspaceCodexResourceCard';
import { describeRun, describeRunCategory, describeRunMetrics, describeRunMode, describeRunResult, describeRunProgress, runMatchesFilter, type RunFilter, formatRunDuration } from './run-presentation';
import { useWorkspaceTaskLauncher } from './useWorkspaceTaskLauncher';
import { relationSessionCandidates, mergeWorkspaceSessionAssociations } from './workspace-task-launch';
import {workspaceTaskTargetRef,type WorkspaceSessionEntry} from './workspace-task-entry';
import WorkspaceSessionPanel from './WorkspaceSessionPanel';
import { detailSnapshotForSelection, localLedgerNotice, loadWorkbenchDetailSnapshot, loadTaskDetailSnapshot, runForTaskDetail, type WorkbenchDetailSelection } from './workspace-task-detail';
import { taskStatusPresentation } from './task-status';
import { personalIssueCompletionNotice } from './workspace-console-view-model';
import { taskFeishuContext, personalSubtaskSummary, trackedParticipationLabel, taskPrimaryFiles, feishuSubtaskUrl as subtaskUrl } from './workspace-console-view-model';
import { loadWorkbenchTheme, saveWorkbenchTheme, WORKBENCH_THEME_OPTIONS, type WorkbenchTheme } from './workspace-console-theme';
import { buildWorkbenchDayHeader } from './workbench-day-header';
import { CACHE_TTL_MS, RESPONSIBILITY_CACHE_TTL_MS } from './workspace-console-cache';
import { shouldAutoRefreshSnapshot, snapshotNotice, taskCountDisplay } from './workspace-persistent-snapshot';
import { createWorkspaceRefreshTracker } from './workspace-refresh-policy';
import { createWorkbenchWheelHandoff } from './workbench-wheel-scroll';
import './workspace-console-theme.css';

const WorkspaceCalendarPanel = lazy(() => import('./WorkspaceDayPanels').then((module) => ({ default: module.WorkspaceCalendarPanel })));
const WorkspaceWeatherPanel = lazy(() => import('./WorkspaceDayPanels').then((module) => ({ default: module.WorkspaceWeatherPanel })));

type Task = WorkspaceConsoleDashboardDto['tasks'][number];
type ProjectItem = WorkspaceConsoleResponsibilityDto['items'][number];
type WorkbenchItem = WorkspaceConsoleResponsibilityDto['workbenchItems'][number];
type WorkbenchEntry = Extract<TaskEntry, { kind: 'parent' | 'subtask' }>;
type WorkbenchDetailSnapshot = Omit<Awaited<ReturnType<typeof loadWorkbenchDetailSnapshot>>, 'responsibility'> & { responsibility: WorkspaceConsoleResponsibilityDto | null };
type CachedOperations = { anchor: string; fetchedAt: number; value: WorkspaceOperationRecordsDto };
const lastChildOperation = (activity: WorkspaceOperationRecordsDto | null | undefined, childId: string): string | null =>
  activity && !activity.hasMore ? activity.events.filter((event) => event.childId === childId)
    .map((event) => event.at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null : null;
const formatTime = (value: string | number | null | undefined) => value ? formatDateTime(value, { seconds: true }) : '未登记';
const formatSummaryTime = (value: string | number | null | undefined) => value
  ? formatDateTime(value)
  : '未登记';
const formatRefreshSeconds = (elapsedMs: number) => `${(Math.max(0, elapsedMs) / 1000).toFixed(1)} 秒`;
const responsibilityText = (value: ProjectItem['actionability']) => ({ current: '当前需我处理', state_responsibility: '负责流程流转', upcoming: '后续需我处理' })[value];
const responsibilityExplanation = (value: ProjectItem['actionability']) => ({ current: '当前流程节点有你的待处理责任。', state_responsibility: '你在工作项的状态流转中承担责任，不代表当前节点需要你操作。', upcoming: '后续流程节点有你的待处理责任。' })[value];
const taskLaneOrder: Array<{ key: TaskLane; title: string; note: string; titleTone: string; headerTone: string }> = [
  { key: 'doing', title: '进行中', note: '已开始且仍需推进的工作', titleTone: 'text-cyan-200', headerTone: 'border-cyan-300/15 bg-cyan-300/[0.07]' },
  { key: 'unstarted', title: '等待中', note: '待处理、待确认，以及等待或暂停的工作', titleTone: 'text-amber-200', headerTone: 'border-amber-300/15 bg-amber-300/[0.07]' },
  { key: 'completed', title: '已结束', note: '仅含本地台账 · 按任务目录更新时间从新到旧', titleTone: 'text-emerald-200', headerTone: 'border-emerald-300/15 bg-emerald-300/[0.07]' },
];

function PersonalCompletionNotice({ item, tasks = [] }: { item: ProjectItem; tasks?: readonly Task[] }) {
  const notice = personalIssueCompletionNotice(item, tasks);
  return notice ? <p className="mt-1 break-words text-xs text-amber-200">{notice}</p> : null;
}

const loadDashboard = (userId: string, force = false) => loadWorkspaceDashboard(userId, () => getWorkspaceConsoleDashboard(undefined, force), force);
const loadResponsibility = (userId: string, force = false,
  trigger: 'open' | 'auto' | 'retry' | 'manual' = 'open') => coalesceWorkspaceRequest(userId, 'responsibility', async () => {
  const value = await getWorkspaceConsoleResponsibility(undefined, force, trigger);
  if (!value.stale && !value.error) rememberResponsibility(userId, value, value.sourceMeta?.lastSuccessAt ?? value.fetchedAt);
  return value;
}, force);

const taskKeysStorageKey = (userId: string) => `relay:workspace-console:task-keys:v3:${userId}`;
const workspaceRefreshStorage=()=>{try{return window.sessionStorage;}catch{return null;}};
const readTaskKeys = (userId: string): string[] | null => {
  try {
    const raw = window.sessionStorage.getItem(taskKeysStorageKey(userId));
    const keys: unknown = raw && JSON.parse(raw);
    return Array.isArray(keys) && keys.every((key) => typeof key === 'string') ? keys : null;
  } catch { return null; }
};

export default function WorkspaceConsolePage() {
  useFeatureView('workbench',true,'sidebar');
  useEffect(() => {
    document.title = '任务工作台 · Relay';
    return () => { document.title = 'Relay'; };
  }, []);

  const { user } = useAuth();
  const userId = user?.id ?? '';
  const sidebarOpen = useChatStore((state) => state.sidebarOpen);
  const relaySessions = useChatStore((state) => state.sessions);
  const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
  const initialCache = useMemo(() => readWorkspaceConsoleCache(userId), [userId]);
  const initialRefreshTimes=useMemo(()=>readWorkspaceRefreshTimes(workspaceRefreshStorage(),userId),[userId]);
  const [sourceRefreshTimes,setSourceRefreshTimes]=useState({userId,times:initialRefreshTimes});
  const { continueSession, launchTaskEntry,continueTaskSession } = useWorkspaceTaskLauncher();
  const [dashboard, setDashboard] = useState<WorkspaceConsoleDashboardDto | null>(initialCache.dashboard);
  const [responsibility, setResponsibility] = useState<WorkspaceConsoleResponsibilityDto | null>(initialCache.responsibility);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectNoticeDismissed, setProjectNoticeDismissed] = useState(false);
  const [projectLoading, setProjectLoading] = useState(!initialCache.responsibilityFresh);
  const [localLoading, setLocalLoading] = useState(!initialCache.dashboardFresh);
  const [refreshTiming, setRefreshTiming] = useState<{
    startedAt: number; observedAt: number; localMs: number | null; projectMs: number | null;
    localRequested: boolean; projectRequested: boolean;
  } | null>(null);
  const [observationSnapshots, setObservationSnapshots] = useState<Partial<Record<ObservationCard, WorkspaceConsoleDashboardDto>>>({});
  const [observationLoading, setObservationLoading] = useState<Partial<Record<ObservationCard, boolean>>>({});
  const [observationErrors, setObservationErrors] = useState<Partial<Record<ObservationCard, string>>>({});
  const observationGeneration = useRef(0);
  const localRefresh = useMemo(() => createWorkspaceRefreshTracker(), [userId]);
  const projectRefresh = useMemo(() => createWorkspaceRefreshTracker(), [userId]);
  const rememberSourceRefresh=(source:keyof WorkspaceRefreshTimes,startedAt:number)=>{
    if(currentUserId.current!==userId)return;
    const times=rememberWorkspaceRefreshTime(workspaceRefreshStorage(),userId,source,startedAt);
    setSourceRefreshTimes(current=>{
      const previous=current.userId===userId?current.times:initialRefreshTimes;
      return {userId,times:{local:Math.max(previous.local??0,times.local??0)||null,project:Math.max(previous.project??0,times.project??0)||null}};
    });
  };
  const readDashboard = (force = false) => localRefresh.track(trackSuccessfulWorkspaceRefresh(()=>loadDashboard(userId, force),
    value=>(force||value.sourceMeta?.state==='live')&&value.errors.length===0&&value.sourceMeta?.state!=='failed_snapshot'&&value.sourceMeta?.state!=='unavailable',at=>rememberSourceRefresh('local',at)));
  const readResponsibility = (force = false, trigger: 'open' | 'auto' | 'retry' | 'manual' = 'open') => projectRefresh.track(trackSuccessfulWorkspaceRefresh(()=>loadResponsibility(userId, force, trigger),
    value=>(force||value.sourceMeta?.state==='live')&&!value.stale&&!value.error&&value.sourceMeta?.state!=='failed_snapshot'&&value.sourceMeta?.state!=='unavailable',at=>rememberSourceRefresh('project',at)));
  const currentUserId = useRef(userId);
  currentUserId.current = userId;
  const projectLoadingRef = useRef(projectLoading);
  projectLoadingRef.current = projectLoading;
  const localLoadingRef = useRef(localLoading);
  localLoadingRef.current = localLoading;
  const observationInFlight = useRef(new Set<ObservationCard>());
  const [desktopLayout, setDesktopLayout] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  const [wide, setWide] = useState(false);
  const workbenchRef = useRef<HTMLElement>(null);
  const focusScrollRef = useRef<HTMLDivElement>(null);
  const [focusViewportWidth, setFocusViewportWidth] = useState(0);
  const [focusCardHeights, setFocusCardHeights] = useState<Record<string, number>>({});
  const [workbenchTheme, setWorkbenchTheme] = useState<WorkbenchTheme>(() => {
    try { return loadWorkbenchTheme(typeof window === 'undefined' ? null : window.localStorage); }
    catch { return 'daylight'; }
  });
  const { now, today, day, greeting, rotateGreeting } = useChinaDayGreeting();
  const dayHeader = buildWorkbenchDayHeader(today, day, now.getHours());
  const themePicker = useRef<HTMLDetailsElement>(null);
  const refreshPicker = useRef<HTMLDetailsElement>(null);
  const [associationFilter, setAssociationFilter] = useState<TaskAssociationFilter>('all');
  const [laneStatusFilters, setLaneStatusFilters] = useState<Record<TaskLane, string>>({ unstarted: '', doing: '', completed: '' });
  const [search, setSearch] = useState('');const commitSearch=useSearchCommit('workbench','workbench');
  const [completedVisibleCount, setCompletedVisibleCount] = useState(10);
  const completedScrollRef = useRef<HTMLDivElement>(null);
  const [mobileTaskLane, setMobileTaskLane] = useState<TaskLane>('doing');
  const [detailSelection, setDetailSelection] = useState<WorkbenchDetailSelection | null>(null);
  const [detailSnapshot, setDetailSnapshot] = useState<WorkbenchDetailSnapshot | null>(null);
  const [refreshingDetail, setRefreshingDetail] = useState(false);
  const [detailRefreshError, setDetailRefreshError] = useState<string | null>(null);
  const [activities, setActivities] = useState<Record<string, CachedOperations>>({});
  const [operationRefreshVersion, setOperationRefreshVersion] = useState(0);
  const forceOperationRefresh = useRef(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const requestedOperationSelection = useRef<string | null>(null);
  const activityGeneration = useRef(0);
  const detailRefreshGeneration = useRef(0);
  const [selectedRun, setSelectedRun] = useState<{ runId: string; taskId: string | null; snapshot:WorkspaceConsoleDashboardDto } | null>(null);
  const [detailHistory,setDetailHistory]=useState<Array<{selection:WorkbenchDetailSelection|null;snapshot:WorkbenchDetailSnapshot|null;run:typeof selectedRun}>>([]);
  const detailScrollPositions=useMemo(()=>new Map<string,number>(),[userId]);
  const [detailPreview,setDetailPreview]=useState(false);
  const panelVisible=useChatStore(state=>state.panelVisible);
  useEffect(()=>{if(!panelVisible)setDetailPreview(false);},[panelVisible]);
  const [dayPanel, setDayPanel] = useState<'calendar' | 'weather' | null>(null);
  const calendarButtonRef = useRef<HTMLButtonElement>(null);
  const weatherButtonRef = useRef<HTMLButtonElement>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [highlightedTasks, setHighlightedTasks] = useState<{ userId: string; keys: Set<string> }>({ userId, keys: new Set() });
  const taskKeyBaseline = useRef<{ userId: string; keys: string[] | null } | null>(null);
  const lastComparedSources = useRef<{ userId: string; dashboard: WorkspaceConsoleDashboardDto | null; responsibility: WorkspaceConsoleResponsibilityDto | null } | null>(null);

  useLayoutEffect(() => { setSidebarOpen(false); }, [setSidebarOpen]);
  useEffect(() => {
    const closePickers = (event: PointerEvent) => {
      for (const picker of [refreshPicker.current, themePicker.current]) {
        if (event.target instanceof Node && !picker?.contains(event.target)) picker?.removeAttribute('open');
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      for (const picker of [refreshPicker.current, themePicker.current]) {
        if (!picker?.open) continue;
        picker.removeAttribute('open');
        if (picker.contains(document.activeElement)) picker.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', closePickers);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', closePickers);
      document.removeEventListener('keydown', onEscape);
    };
  }, []);
  useEffect(() => {
    if (localLoading || projectLoading) refreshPicker.current?.removeAttribute('open');
  }, [localLoading, projectLoading]);
  useEffect(() => {
    const page = workbenchRef.current;
    if (!page) return;
    const handoffWheel = createWorkbenchWheelHandoff();
    const onWheel = (event: WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const panel = target.closest<HTMLElement>('.workspace-workbench__focus-scroll, .workspace-workbench__task-lane-scroll');
      if (panel && page.contains(panel)) handoffWheel(event, panel, page);
    };
    page.addEventListener('wheel', onWheel, { passive: false });
    return () => page.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    const viewport = focusScrollRef.current;
    if (!viewport) return;
    const updateWidth = () => setFocusViewportWidth(viewport.clientWidth);
    updateWidth();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const update = () => setDesktopLayout(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!desktopLayout) setDayPanel(null);
  }, [desktopLayout]);

  useEffect(() => {
    let active = true;
    observationGeneration.current += 1;
    observationInFlight.current.clear();
    setObservationSnapshots({});
    setObservationLoading({});
    setObservationErrors({});
    detailRefreshGeneration.current += 1;
    setDetailSelection(null);
    setDetailHistory([]);setDetailPreview(false);
    setDetailSnapshot(null);
    setActivities({});
    activityGeneration.current += 1;
    requestedOperationSelection.current = null;
    forceOperationRefresh.current = false;
    setActivityLoading(false);
    setActivityError(null);
    const cached = readWorkspaceConsoleCache(userId);
    setDashboard(cached.dashboard);
    setResponsibility(cached.responsibility);
    setDashboardError(null);
    setProjectError(null);
    setProjectNoticeDismissed(false);
    const startedAt = performance.now();
    setRefreshTiming(null);
    setLocalLoading(true);
    setProjectLoading(true);
    void readDashboard()
      .then(async (value) => {
        if (!active) return;
        setDashboard(value); setDashboardError(null);
        if (shouldAutoRefreshSnapshot(value.sourceMeta, Date.now(), CACHE_TTL_MS)) {
          const refreshed = await readDashboard(true);
          if (active) setDashboard(refreshed);
        }
      })
      .catch((error) => { if (active) setDashboardError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setLocalLoading(false); });
    void readResponsibility()
      .then(async (value) => {
        if (!active) return;
        setResponsibility(value);
        setProjectError(null);
        if (value.servedFromCache === false && !value.stale) {
          const finishedAt = performance.now();
          setRefreshTiming({ startedAt, observedAt: finishedAt, localMs: null,
            projectMs: finishedAt - startedAt, localRequested: false, projectRequested: true });
        }
        if (shouldAutoRefreshSnapshot(value.sourceMeta, Date.now(), RESPONSIBILITY_CACHE_TTL_MS, value.servedFromCache)) {
          const refreshed = await readResponsibility(true, 'auto');
          if (active) setResponsibility(refreshed);
        }
      })
      .catch((error) => { if (active) setProjectError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setProjectLoading(false); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    if (responsibility?.sourceMeta?.state === 'live') setProjectNoticeDismissed(false);
  }, [responsibility?.sourceMeta?.state]);

  useEffect(() => {
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;
    const refreshCurrentAssociations=()=>{
      if(document.visibilityState!=='visible'||localLoadingRef.current)return;
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{
        void readDashboard().then(value=>{if(active&&!localLoadingRef.current)setDashboard(current=>mergeWorkspaceSessionAssociations(current,value));})
          .catch(error=>{if(active)setDashboardError(error instanceof Error?error.message:String(error));});
      },150);
    };
    refreshCurrentAssociations();
    window.addEventListener('focus',refreshCurrentAssociations);
    document.addEventListener('visibilitychange',refreshCurrentAssociations);
    return()=>{active=false;if(timer)clearTimeout(timer);window.removeEventListener('focus',refreshCurrentAssociations);document.removeEventListener('visibilitychange',refreshCurrentAssociations);};
  },[userId,relaySessions]);

  const refreshSource = (source: 'local' | 'project', trigger: 'auto' | 'retry' = 'retry') => {
    const loading = source === 'local' ? localLoadingRef : projectLoadingRef;
    if (loading.current) return;
    loading.current = true;
    setRefreshTiming(null);
    if (source === 'local') {
      setLocalLoading(true);
      void readDashboard(true)
        .then((value) => { if (currentUserId.current === userId) { setDashboard(value); setDashboardError(null); } })
        .catch((error) => { if (currentUserId.current === userId) setDashboardError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (currentUserId.current === userId) { loading.current = false; setLocalLoading(false); } });
    } else {
      setProjectLoading(true);
      void readResponsibility(true, trigger)
        .then((value) => { if (currentUserId.current === userId) { setResponsibility(value); setProjectError(null); } })
        .catch((error) => { if (currentUserId.current === userId) setProjectError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (currentUserId.current === userId) { loading.current = false; setProjectLoading(false); } });
    }
  };
  useEffect(() => {
    const refreshDue = () => {
      if (document.visibilityState !== 'visible') return;
      const local = localRefresh.reason(dashboard?.sourceMeta, CACHE_TTL_MS);
      const project = projectRefresh.reason(responsibility?.sourceMeta, RESPONSIBILITY_CACHE_TTL_MS);
      if (local) refreshSource('local', local);
      if (project) refreshSource('project', project);
    };
    const interval = window.setInterval(refreshDue, 30_000);
    document.addEventListener('visibilitychange', refreshDue);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', refreshDue); };
  }, [userId, dashboard?.sourceMeta, responsibility?.sourceMeta]);

  useEffect(() => {
    if (!refreshTiming || (!localLoading && !projectLoading)) return;
    const interval = window.setInterval(() => setRefreshTiming((current) => current
      ? { ...current, observedAt: performance.now() } : null), 1_000);
    return () => window.clearInterval(interval);
  }, [refreshTiming?.startedAt, localLoading, projectLoading]);

  const refresh = (scope: 'all' | 'local' | 'project') => {
    refreshPicker.current?.removeAttribute('open');
    if (localLoadingRef.current || projectLoadingRef.current) return;
    const localRequested = scope !== 'project';
    const projectRequested = scope !== 'local';
    setHighlightedTasks({userId,keys:new Set()});
    if (projectRequested) setProjectNoticeDismissed(false);
    const startedAt = performance.now();
    setRefreshTiming({ startedAt, observedAt: startedAt, localMs: null, projectMs: null,
      localRequested, projectRequested });
    if (localRequested) {
      observationGeneration.current += 1;
      observationInFlight.current.clear();
      setObservationSnapshots({});
      setObservationLoading({});
      setObservationErrors({});
    }
    if (projectRequested && operationParentId) {
      forceOperationRefresh.current = true;
      setOperationRefreshVersion((version) => version + 1);
    }
    if (localRequested) {
      localLoadingRef.current = true;
      setLocalLoading(true);
      void readDashboard(true)
      .then((value) => { if (currentUserId.current === userId) { setDashboard(value); setDashboardError(null); } })
      .catch((error) => { if (currentUserId.current === userId) setDashboardError(error instanceof Error ? error.message : String(error)); })
      .finally(() => {
        if (currentUserId.current !== userId) return;
        setRefreshTiming((current) => current?.startedAt === startedAt
          ? { ...current, localMs: performance.now() - startedAt } : current);
        localLoadingRef.current = false;
        setLocalLoading(false);
      });
    }
    if (projectRequested) {
      projectLoadingRef.current = true;
      setProjectLoading(true);
      void readResponsibility(true, 'manual')
      .then((value) => { if (currentUserId.current === userId) { setResponsibility(value); setProjectError(null); } })
      .catch((error) => { if (currentUserId.current === userId) setProjectError(error instanceof Error ? error.message : String(error)); })
      .finally(() => {
        if (currentUserId.current !== userId) return;
        setRefreshTiming((current) => current?.startedAt === startedAt
          ? { ...current, projectMs: performance.now() - startedAt } : current);
        projectLoadingRef.current = false;
        setProjectLoading(false);
      });
    }
  };

  const refreshObservation = async (card: ObservationCard) => {
    if (observationInFlight.current.has(card)) return;
    observationInFlight.current.add(card);
    const generation = observationGeneration.current;
    setObservationLoading((current) => ({ ...current, [card]: true }));
    setObservationErrors((current) => ({ ...current, [card]: undefined }));
    try {
      const latest = await readDashboard(card !== 'sessions');
      if (observationGeneration.current === generation) {
        setDashboard(latest);
        setDashboardError(null);
        setObservationSnapshots({});
      }
    } catch (cause) {
      if (observationGeneration.current === generation) setObservationErrors((current) => ({ ...current, [card]: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      if (observationGeneration.current === generation) {
        observationInFlight.current.delete(card);
        setObservationLoading((current) => ({ ...current, [card]: false }));
      }
    }
  };

  const model = useMemo(() => buildWorkspaceConsoleView(dashboard, responsibility), [dashboard, responsibility]);
  const observation = useMemo(() => buildExecutionCards(dashboard, observationSnapshots), [dashboard, observationSnapshots]);
  const snapshotReady = !localLoading && !projectLoading && !dashboardError && !projectError
    && dashboard?.sourceAvailable.registry === true && !!responsibility && responsibility.stale === false && !responsibility.error;
  const localRefreshFailed = !!dashboardError || dashboard?.sourceMeta?.state === 'failed_snapshot' || dashboard?.sourceAvailable.registry !== true;
  const projectRefreshFailed = !!projectError || !responsibility || responsibility.sourceMeta?.state === 'failed_snapshot' || !!responsibility.stale || !!responsibility.error;
  const hasLocalData = dashboard?.sourceAvailable.registry === true;
  const hasProjectData = !!responsibility;
  const localRefreshPartial = !localRefreshFailed && (dashboard?.errors.length ?? 0) > 0;
  const refreshBannerTone = (refreshTiming?.localRequested && localLoading) || (refreshTiming?.projectRequested && projectLoading && refreshTiming.projectMs === null)
    ? 'border-cyan-300/30 bg-cyan-300/[0.12]'
    : (refreshTiming?.localRequested && localRefreshFailed) || (refreshTiming?.projectRequested && projectRefreshFailed)
      ? 'border-rose-300/40 bg-rose-400/[0.18]'
      : refreshTiming?.localRequested && localRefreshPartial
        ? 'border-amber-300/40 bg-amber-400/[0.18]'
        : 'border-emerald-300/40 bg-emerald-400/[0.18]';
  const comparisonReady = snapshotReady;
  const allEntries = useMemo(() => buildTaskEntries(model, 'all'), [model]);
  const allMatters = useMemo(() => unifyTaskEntries(allEntries, responsibility), [allEntries, responsibility]);
  const trackedItems = useMemo(() => trackingItemsForMatters(responsibility,model.tasks,allMatters), [responsibility, model.tasks, allMatters]);
  const focusEntries = useMemo(() => selectFocusEntries(allMatters, now.getTime()), [allMatters, now]);
  const focusColumns = useMemo(() => distributeFocusEntries(focusEntries, focusColumnCount(focusViewportWidth, focusEntries.length),
    (entry) => focusCardHeights[entry.key] ?? 240), [focusEntries, focusViewportWidth, focusCardHeights]);
  useLayoutEffect(() => {
    const cards = focusScrollRef.current?.querySelectorAll<HTMLElement>('.workspace-workbench__focus-item[data-focus-key]');
    if (!cards) return;
    const measure = () => {
      const heights: Record<string, number> = {};
      cards.forEach((card) => { if (card.dataset.focusKey) heights[card.dataset.focusKey] = Math.ceil(card.getBoundingClientRect().height); });
      setFocusCardHeights((current) => Object.keys(heights).length === Object.keys(current).length
        && Object.entries(heights).every(([key, height]) => current[key] === height) ? current : heights);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [focusColumns]);
  const recordCounts = { ...taskRecordCounts(allEntries), cards: allMatters.filter(isWorkbenchTaskVisible).length };
  useEffect(() => {
    if (!snapshotReady) return;
    const compared = lastComparedSources.current;
    if (compared?.userId === userId && compared.dashboard === dashboard && compared.responsibility === responsibility) return;
    lastComparedSources.current = { userId, dashboard, responsibility };
    const previous = taskKeyBaseline.current?.userId === userId ? taskKeyBaseline.current.keys : readTaskKeys(userId);
    const keys = snapshotTaskIdentityKeys(allEntries,responsibility);
    setHighlightedTasks(current=>({userId,keys:retainNewTaskKeys(current.userId===userId?current.keys:new Set(),previous,keys)}));
    const knownKeys=[...new Set([...(previous??[]),...keys])];
    taskKeyBaseline.current = { userId, keys:knownKeys };
    try { window.sessionStorage.setItem(taskKeysStorageKey(userId), JSON.stringify(knownKeys)); } catch { /* Session storage may be disabled. */ }
  }, [allEntries, snapshotReady, dashboard, responsibility, userId]);
  const newTaskKeys = highlightedTasks.userId === userId ? highlightedTasks.keys : new Set<string>();
  const entries = useMemo(() => (associationFilter !== 'local' && associationFilter !== 'uncertain') || comparisonReady
    ? buildTaskEntries(model, associationFilter) : [], [model, associationFilter, comparisonReady]);
  const displayEntries = useMemo(() => selectMatterEntries(allMatters, entries), [allMatters, entries]);
  const visibleEntries = useMemo(() => prioritizeTaskEntries(filterTaskEntries(displayEntries, 'all', search), newTaskKeys), [displayEntries, search, newTaskKeys]);
  const summaryStatusIndex = useMemo(() => buildSummaryStatusIndex(displayEntries, responsibility), [displayEntries, responsibility]);
  const laneStatusOptions = useMemo(() => {
    const lanes = workbenchTaskLanes(visibleEntries);
    const optionsFor = (lane: TaskLane) => summaryStatusOptions(lanes[lane], summaryStatusIndex);
    return { unstarted: optionsFor('unstarted'), doing: optionsFor('doing'), completed: optionsFor('completed') };
  }, [visibleEntries, summaryStatusIndex]);
  useEffect(() => {
    setLaneStatusFilters(current => {
      const next = {...current};
      for (const lane of ['doing','unstarted','completed'] as const) {
        if (next[lane] && !laneStatusOptions[lane].some(option => option.label === next[lane])) next[lane] = '';
      }
      return next.doing === current.doing && next.unstarted === current.unstarted && next.completed === current.completed ? current : next;
    });
  }, [laneStatusOptions]);
  const taskLanes = useMemo(() => filterLanesBySummary(workbenchTaskLanes(visibleEntries), laneStatusFilters, summaryStatusIndex), [visibleEntries, laneStatusFilters, summaryStatusIndex]);
  useEffect(() => {
    setCompletedVisibleCount(10);
    if (completedScrollRef.current) completedScrollRef.current.scrollTop = 0;
  }, [userId, search, associationFilter, laneStatusFilters.completed]);
  const visibleTaskCount = taskLanes.unstarted.length + taskLanes.doing.length + taskLanes.completed.length;
  const activeDetail = detailSelection && detailSnapshot?.selection.kind === detailSelection.kind && detailSnapshot.selection.id === detailSelection.id ? detailSnapshot : null;
  const openFilePreview = useFilePreview(selectedRun?.snapshot?.workspacePath??activeDetail?.dashboard.workspacePath??dashboard?.workspacePath);
  const taskDashboard = useMemo(() => {
    const source = activeDetail?.dashboard ?? dashboard;
    return source ? source === dashboard ? {...source, tasks:model.tasks} : withDashboardProgress(source) : null;
  }, [activeDetail?.dashboard, dashboard, model.tasks]);
  const detailResponsibility = activeDetail?.responsibility ?? responsibility;
  const detailTaskId = detailSelection?.kind === 'local' ? detailSelection.id : activeDetail?.taskId;
  const task = detailTaskId ? taskDashboard?.tasks.find((item) => item.id === detailTaskId) : null;
  const project = useMemo(() => {
    if (task || detailSelection?.kind !== 'project') return null;
    const view = activeDetail ? buildWorkspaceConsoleView(taskDashboard, detailResponsibility) : model;
    return [...view.responsibility.current, ...view.responsibility.stateResponsibility, ...view.responsibility.upcoming]
      .find((item) => item.workItemId === detailSelection.id) ?? null;
  }, [task, detailSelection, activeDetail, taskDashboard, detailResponsibility, model]);
  const projectLocalTasks = project ? sortDetailLocalTasks(taskDashboard?.tasks.filter((item) => project.localTaskIds.includes(item.id)) ?? []) : [];
  const projectRuns=runsForTasks(taskDashboard,projectLocalTasks.map(task=>task.id));
  const workbenchParent = detailSelection?.kind === 'parent' || detailSelection?.kind === 'group' ? detailResponsibility?.workbenchItems.find((item) => item.workItemId === detailSelection.id) :
    detailSelection?.kind === 'subtask' ? detailResponsibility?.workbenchItems.find((item) => item.mySubtasks.some((child) => `${item.workItemId}:${child.id}` === detailSelection.id)) : null;
  const operationParentId = project?.workItemId ?? workbenchParent?.workItemId ?? null;
  const operationAnchor = project?.updatedAt ?? workbenchParent?.updatedAt ?? detailResponsibility?.generatedAt ?? null;
  const operationRefresh = useMemo(() => createWorkspaceRefreshTracker(), [userId, operationParentId, operationAnchor]);
  const operationSelectionKey = detailSelection ? `${detailSelection.kind}:${detailSelection.id}` : null;
  const activeOperations = operationParentId && operationAnchor && activities[operationParentId]?.anchor === operationAnchor
    ? activities[operationParentId].value : null;
  useEffect(() => {
    const generation = ++activityGeneration.current;
    if (!operationSelectionKey) { forceOperationRefresh.current = false; requestedOperationSelection.current = null; setActivityLoading(false); setActivityError(null); return; }
    if (!operationParentId || !operationAnchor) { requestedOperationSelection.current = null; setActivityLoading(false); setActivityError(null); return; }
    const requestKey = `${operationSelectionKey}:${operationParentId}:${operationAnchor}:${operationRefreshVersion}`;
    if (requestedOperationSelection.current === requestKey) { setActivityLoading(false); return; }
    requestedOperationSelection.current = requestKey;
    const force = forceOperationRefresh.current;
    forceOperationRefresh.current = false;
    const cached = activities[operationParentId];
    if (!force && cached?.anchor === operationAnchor && Date.now() - cached.fetchedAt < 10 * 60_000) { setActivityLoading(false); setActivityError(null); return; }
    const controller = new AbortController();
    setActivityLoading(true);
    setActivityError(null);
    void operationRefresh.track(getWorkspaceOperationRecords(operationParentId, operationAnchor, null, controller.signal, force))
      .then((value) => { if (!controller.signal.aborted && generation === activityGeneration.current) setActivities((current) => ({ ...current,
        [operationParentId]: { anchor: operationAnchor, fetchedAt: Date.now(), value } })); })
      .catch((error) => { if (!controller.signal.aborted && generation === activityGeneration.current) setActivityError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!controller.signal.aborted && generation === activityGeneration.current) setActivityLoading(false); });
    return () => controller.abort();
  }, [operationSelectionKey, operationParentId, operationAnchor, operationRefreshVersion]);
  useEffect(() => {
    if (!operationParentId || !operationAnchor) return;
    const refreshExpired = () => {
      if (document.visibilityState !== 'visible' || activityLoading) return;
      const cached = activities[operationParentId];
      const meta = cached?.anchor === operationAnchor
        ? { state: 'live' as const, lastSuccessAt: cached.fetchedAt, lastAttemptAt: cached.fetchedAt, error: null }
        : undefined;
      if (operationRefresh.reason(meta, 10 * 60_000)) {
        forceOperationRefresh.current = true;
        setOperationRefreshVersion((version) => version + 1);
      }
    };
    const timer = window.setInterval(refreshExpired, 30_000);
    document.addEventListener('visibilitychange', refreshExpired);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshExpired); };
  }, [operationParentId, operationAnchor, activities, activityLoading]);
  const loadMoreOperations = async () => {
    if (!operationParentId || !operationAnchor || !activeOperations?.cursor || activityLoading) return;
    const generation = activityGeneration.current;
    featureAction('workbench','load_more','workbench');const cursor = activeOperations.cursor;
    setActivityLoading(true);
    setActivityError(null);
    try {
      const page = await getWorkspaceOperationRecords(operationParentId, operationAnchor, cursor);
      if (generation === activityGeneration.current) setActivities((current) => {
        const cached = current[operationParentId];
        if (cached?.anchor !== operationAnchor || cached.value.cursor !== cursor) return current;
        return { ...current, [operationParentId]: { anchor: operationAnchor, fetchedAt: Date.now(),
          value: { ...page, events: [...cached.value.events, ...page.events] } } };
      });
    } catch (error) { if (generation === activityGeneration.current) setActivityError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === activityGeneration.current) setActivityLoading(false); }
  };
  const refreshOperations = async () => {
    if (!operationParentId || !operationAnchor || activityLoading) return;
    const generation = activityGeneration.current;
    setActivityLoading(true);
    setActivityError(null);
    try {
      const value = await operationRefresh.track(getWorkspaceOperationRecords(operationParentId, operationAnchor, null, undefined, true));
      if (generation === activityGeneration.current) setActivities((current) => ({ ...current,
        [operationParentId]: { anchor: operationAnchor, fetchedAt: Date.now(), value } }));
    } catch (error) { if (generation === activityGeneration.current) setActivityError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === activityGeneration.current) setActivityLoading(false); }
  };
  const workbenchSubtask = detailSelection?.kind === 'subtask' ? workbenchParent?.mySubtasks.find((child) => `${workbenchParent.workItemId}:${child.id}` === detailSelection.id) : null;
  const relatedGroupIssues = workbenchParent ? detailResponsibility?.items.filter((item) => item.typeName === '缺陷'
    && item.linkedStoryIds?.length === 1 && item.linkedStoryIds[0] === workbenchParent.workItemId
    && !detailResponsibility.workbenchItems.some((parent) => parent.workItemId === item.workItemId && parent.mySubtasks.length > 0)) ?? [] : [];
  const subtaskLocalTasks = workbenchSubtask ? sortDetailLocalTasks(taskDashboard?.tasks.filter((item) => workbenchSubtask.localTaskIds?.includes(item.id)) ?? []) : [];
  const parentLocalTasks = workbenchParent ? localLedgersForParent(workbenchParent, taskDashboard?.tasks ?? []) : [];
  const detailMatter = useMemo(() => workbenchParent ? unifyTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(taskDashboard,detailResponsibility)),detailResponsibility)
    .find((entry): entry is TaskGroup => entry.kind==='group'&&entry.parent.workItemId===workbenchParent.workItemId) : null,[taskDashboard,detailResponsibility,workbenchParent]);
  const matterLocalTasks = detailMatter ? sortDetailLocalTasks(detailMatter.members.flatMap(entry=>entry.kind==='local'?[entry.task]:[])) : parentLocalTasks;
  const matterRegisteredLocalIds=[...new Set([...(workbenchParent?.localTaskIds??[]),...(workbenchParent?.mySubtasks.flatMap(child=>child.localTaskIds??[])??[]),...relatedGroupIssues.flatMap(item=>item.localTaskIds)])];
  const matterRuns = runsForTasks(taskDashboard,(workbenchSubtask?subtaskLocalTasks:matterLocalTasks).map(task=>task.id));
  const childOperationTimes = new Map(workbenchParent?.mySubtasks.flatMap((child) => {
    const at = lastChildOperation(activeOperations, child.id);
    return at ? [[child.id, at] as const] : [];
  }) ?? []);
  const childTimeText = (id: string) => {
    const at = lastChildOperation(activeOperations, id);
    return at ? `飞书子任务近期操作 ${formatTime(at)}` : '飞书更新时间未提供';
  };
  const sortedParentChildren = workbenchParent ? sortDetailSubtasks(workbenchParent, taskDashboard?.tasks ?? [], childOperationTimes) : [];
  const parentChildrenNeedingAttention = sortedParentChildren.filter(child=>!child.passed);
  const finishedParentChildren = sortedParentChildren.filter(child=>child.passed);
  const projectDetails = project ? projectTaskCardDetails(project) : null;
  const projectUnfinishedChildren=project?.personalSubtasks.filter(child=>!child.passed)??[];
  const projectFinishedChildren=project?.personalSubtasks.filter(child=>child.passed)??[];
  const projectNativeParent = project ? detailResponsibility?.workbenchItems.find(item=>item.workItemId===project.workItemId) : undefined;
  const run = selectedRun ? runForTaskDetail(selectedRun) : null;
  const runSource = selectedRun?.snapshot??null;
  const runTask = run?.taskId ? runSource?.tasks.find((item) => item.id === run.taskId) ?? null : null;
  const projectForTask = task ? projectItemsForTask(task, detailResponsibility) : [];
  const taskContextItems = task ? taskFeishuContext(task,detailResponsibility) : [];
  const taskRuns = task && taskDashboard ? runsForTask(taskDashboard, task) : [];
  const taskFiles = task ? taskPrimaryFiles(task) : [];
  const displayedDetailSnapshot=detailSelection&&taskDashboard?detailSnapshotForSelection(detailSelection,taskDashboard,detailResponsibility):detailSnapshot;
  const rememberDetail=()=>{if(detailSelection||selectedRun)setDetailHistory(history=>[...history,{selection:detailSelection,snapshot:displayedDetailSnapshot,run:selectedRun}]);};
  const backDetail=()=>{const previous=detailHistory[detailHistory.length-1];if(!previous)return;detailRefreshGeneration.current++;setDetailHistory(history=>history.slice(0,-1));setDetailSelection(previous.selection);setDetailSnapshot(previous.snapshot);setSelectedRun(previous.run);setRefreshingDetail(false);setDetailRefreshError(null);};
  const previewDetailFile=(path:string)=>{setDetailPreview(true);void openFilePreview(path);};
  const openDetail = (selection: WorkbenchDetailSelection) => {
    const source=selectedRun?runSource:detailSelection?taskDashboard:null;
    rememberDetail();setSelectedRun(null);featureAction('workbench','details','workbench');detailRefreshGeneration.current++;
    setDetailSelection(selection);setDetailSnapshot(source?detailSnapshotForSelection(selection,source,detailResponsibility):null);setRefreshingDetail(false);setDetailRefreshError(null);
  };
  const closeDetail = (keepSnapshot = false) => { detailRefreshGeneration.current += 1; setDetailSelection(null); setRefreshingDetail(false); setDetailRefreshError(null); if (!keepSnapshot) {setDetailSnapshot(null);setSelectedRun(null);setDetailHistory([]);setDetailPreview(false);} };
  const openRunDetail=(item:WorkspaceConsoleRunDto,source:WorkspaceConsoleDashboardDto|null)=>{
    if(!source){setActionError('执行记录来源不可用，请刷新后重试。');return;}
    rememberDetail();closeDetail(true);setSelectedRun({runId:item.runId,taskId:item.taskId,snapshot:source});
  };
  const renderRunSection=(runs:WorkspaceConsoleRunDto[],source:WorkspaceConsoleDashboardDto|null)=>{
    if(!runs.length&&source?.sourceAvailable.runs!==false)return null;
    return <DetailDisclosure title={`执行记录 · ${source?.sourceAvailable.runs?runs.length:'来源不可用'}`} open><TaskRunRecords key={detailSelection?`${detailSelection.kind}:${detailSelection.id}`:'runs'} runs={runs} available={source?.sourceAvailable.runs} onOpen={item=>openRunDetail(item,source)}/></DetailDisclosure>;
  };
  const openTask = (taskId: string, source?: WorkspaceConsoleDashboardDto) => {
    const selection: WorkbenchDetailSelection = { kind: 'local', id: taskId };
    openDetail(selection);
    const selectedDashboard=source??dashboard;
    if (selectedDashboard) setDetailSnapshot({ selection, taskId, dashboard: selectedDashboard, responsibility:source?detailResponsibility:responsibility });
    if(selectedDashboard?.tasks.find(task=>task.id===taskId)?.feishuWorkItemIds.length){
      const generation=detailRefreshGeneration.current;
      setRefreshingDetail(true);
      void getWorkspaceConsoleResponsibility(undefined,false,'detail',taskId).then(value=>{
        if(generation===detailRefreshGeneration.current)setDetailSnapshot({selection,taskId,dashboard:selectedDashboard,responsibility:value});
      }).catch(cause=>{if(generation===detailRefreshGeneration.current)setDetailRefreshError(cause instanceof Error?cause.message:String(cause));})
        .finally(()=>{if(generation===detailRefreshGeneration.current)setRefreshingDetail(false);});
    }
  };
  const openProject = (workItemId: string) => openDetail({ kind: 'project', id: workItemId });
  const openWorkbenchEntry = (entry: WorkbenchEntry) => openDetail(entry.kind === 'parent'
    ? { kind: 'parent', id: entry.item.workItemId }
    : { kind: 'subtask', id: `${entry.parent.workItemId}:${entry.subtask.id}` });
  const openTaskGroup = (entry: TaskGroup) => openDetail({ kind: 'group', id: entry.parent.workItemId });
  const reloadSelectedDetail = async (selection: WorkbenchDetailSelection) => {
    const generation = ++detailRefreshGeneration.current;
    setRefreshingDetail(true);
    setDetailRefreshError(null);
    try {
      const snapshot = await loadWorkbenchDetailSnapshot(selection, () => getWorkspaceConsoleDashboard(undefined, true),
        (force) => getWorkspaceConsoleResponsibility(undefined, force, 'detail',selection.kind==='local'?selection.id:undefined), detailResponsibility);
      if (detailRefreshGeneration.current === generation) {setDetailSnapshot(snapshot);forceOperationRefresh.current=true;setOperationRefreshVersion(version=>version+1);}
    } catch (cause) {
      if (detailRefreshGeneration.current === generation) setDetailRefreshError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      if (detailRefreshGeneration.current === generation) setRefreshingDetail(false);
    }
  };
  const reloadChangedTask = async (selection: WorkbenchDetailSelection, taskId: string, currentResponsibility: WorkspaceConsoleResponsibilityDto | null) => {
    const generation = ++detailRefreshGeneration.current;
    setRefreshingDetail(true);
    setDetailRefreshError(null);
    try {
      const snapshot = await loadTaskDetailSnapshot(taskId, () => getWorkspaceConsoleDashboard(undefined, true));
      if (detailRefreshGeneration.current === generation) setDetailSnapshot({ selection, ...snapshot, responsibility: currentResponsibility });
    } catch (cause) {
      if (detailRefreshGeneration.current === generation) setDetailRefreshError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      if (detailRefreshGeneration.current === generation) setRefreshingDetail(false);
    }
  };
  const openCardEntry=(entry:TaskEntry)=>entry.kind==='local'?openTask(entry.task.id):entry.kind==='project'?openProject(entry.item.workItemId):entry.kind==='parent'?openTaskGroup({kind:'group',key:`group:${entry.item.workItemId}`,parent:entry.item,members:[entry]}):openWorkbenchEntry(entry);
  const continueCardRelation=(_item:CardRelation,id:string,isCurrent:()=>boolean)=>continueTaskSession(dashboard,id,()=>isCurrent()&&currentUserId.current===userId);
  const newCardRelation=(item:CardRelation)=>{if(item.target)setActionError(launchTaskEntry(item.target,dashboard));};
  const renderSessionActions=(entry:WorkspaceSessionEntry,source=dashboard)=><WorkspaceChildSessionActions key={workspaceTaskTargetRef(entry)} sessions={relationSessionCandidates({targetRef:workspaceTaskTargetRef(entry)},source)} onContinue={(id,isCurrent)=>continueTaskSession(source,id,()=>isCurrent()&&currentUserId.current===userId)} onNew={()=>setActionError(launchTaskEntry(entry,source))}/>;
  const renderTaskCard=(entry:Extract<TaskDisplayEntry,{kind:'group'|'local'|'project'}>)=><MatterTaskCard entry={entry} responsibility={responsibility} runs={dashboard?.runs??[]} dashboard={dashboard} isNew={taskDisplayEntryIsNew(entry,newTaskKeys)} newKeys={newTaskKeys} onContinueRelation={continueCardRelation} onNewRelation={newCardRelation} onOpen={()=>entry.kind==='group'?openTaskGroup(entry):openCardEntry(entry)} onOpenEntry={openCardEntry} onOpenFile={path=>void openFilePreview(path)}/>;
  const renderNativeChild=(child:WorkbenchItem['mySubtasks'][number])=>{
    if(!workbenchParent)return null;
    const selection:WorkbenchDetailSelection={kind:'subtask',id:`${workbenchParent.workItemId}:${child.id}`};
    const local=taskDashboard?.tasks.filter(task=>child.localTaskIds?.includes(task.id))??[];
    return <div key={child.id} className="workspace-detail__related-row">
      <div className="flex flex-wrap items-start justify-between gap-2"><button type="button" onClick={()=>openDetail(selection)} className="min-w-0 flex-1 break-words text-left font-medium text-slate-100 hover:text-cyan-300">{child.title}</button><span className="text-xs text-slate-400">{workbenchSubtaskStatusLabel(child)}</span></div>
      {newTaskKeys.has(`subtask:${workbenchParent.workItemId}:${child.id}`)&&!child.passed&&<NewBadge/>}
      <FeishuIdentity label="子任务" id={child.id} title={child.title} url={subtaskUrl(workbenchParent,child)}/>
      <p className="text-xs text-slate-400">{workbenchSubtaskNodeLabel(child)}</p><p className="text-xs text-slate-500">{childTimeText(child.id)}{child.finishedAt?` · 完成 ${formatTime(child.finishedAt)}`:''}</p>
      {local.length>0&&<p className="text-xs text-slate-400">关联本地台账 {local.length} 份{local.some(task=>localTaskLaneForDisplay(task)!=='completed')?' · 本地仍有未结束交付':''}</p>}
      {renderSessionActions({kind:'subtask',key:selection.id,parent:workbenchParent,subtask:child,localTasks:local},taskDashboard)}
    </div>;
  };
  const chooseWorkbenchTheme = (theme: WorkbenchTheme) => {
    setWorkbenchTheme(theme);
    try { saveWorkbenchTheme(window.localStorage, theme); } catch { /* Storage can be disabled. */ }
    themePicker.current?.removeAttribute('open');
  };

  return <main ref={workbenchRef} data-workbench-theme={workbenchTheme} className="workspace-workbench min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-slate-950 p-3 text-slate-100 sm:p-6">
    <div className={`mx-auto space-y-4 ${wide ? 'max-w-[1920px]' : 'max-w-7xl'}`}>
      <header className="rounded-2xl border border-white/10 bg-[#111927] p-4 sm:p-5">
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,340px)] lg:items-stretch">
          <div className="relative flex min-w-0 flex-col justify-between">
            <div className="workspace-workbench__hero-art" aria-hidden="true" />
            <div className="relative z-10 xl:max-w-[520px]">
              <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xl font-semibold tracking-tight sm:text-3xl"><span>{dayHeader.date}</span><span className="text-base font-medium text-slate-300 sm:text-lg">{dayHeader.weekday}</span></h1>
              {(desktopLayout || dayHeader.lunar || dayHeader.occasion) && <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-300">
                {desktopLayout ? <button ref={calendarButtonRef} type="button" onClick={() => setDayPanel('calendar')} aria-label="打开万年历" aria-haspopup="dialog" aria-expanded={dayPanel === 'calendar'} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 hover:border-cyan-300/50 hover:text-cyan-300">{dayHeader.lunar || '查看日历'}</button> : dayHeader.lunar && <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">{dayHeader.lunar}</span>}
                {dayHeader.occasion && <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-cyan-200">{dayHeader.occasion}</span>}
              </div>}
              {desktopLayout ? <button ref={weatherButtonRef} type="button" onClick={() => setDayPanel('weather')} aria-label="查看最近天气" aria-haspopup="dialog" aria-expanded={dayPanel === 'weather'} className="mt-2 block text-left text-sm text-slate-300 hover:text-cyan-300 hover:underline">{dayHeader.weather || '天气暂未提供'}</button> : <p className="mt-2 text-sm text-slate-300">{dayHeader.weather || '天气暂未提供'}</p>}
            </div>
            <Tooltip content="换一句" asChild><button type="button" onClick={rotateGreeting} className="relative z-10 mt-2 block max-w-[520px] text-left text-sm text-slate-400 hover:text-slate-200">{greeting}</button></Tooltip>
          </div>
          {desktopLayout && <WorkspaceCodexResourceCard key={userId} userId={userId} />}
        </div>
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="workspace-workbench__header-toolbar">
              <div className="workspace-workbench__header-actions">
              <button type="button" onClick={() => setSidebarOpen(!sidebarOpen)} aria-pressed={sidebarOpen} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/10">{sidebarOpen ? '隐藏左侧面板' : '展开左侧面板'}</button>
              <details ref={refreshPicker} className="workspace-workbench__theme-picker relative" onToggle={(event) => { if (event.currentTarget.open) themePicker.current?.removeAttribute('open'); }}>
                <summary aria-disabled={localLoading || projectLoading} onClick={(event) => { if (localLoading || projectLoading) event.preventDefault(); }} className="workspace-workbench__theme-trigger workspace-workbench__refresh-trigger cursor-pointer rounded-lg border px-3 py-1.5 text-xs aria-disabled:cursor-wait aria-disabled:opacity-50"><span>{localLoading || projectLoading ? '同步中…' : '刷新任务'}</span><svg className="workspace-workbench__theme-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg></summary>
                <div className="workspace-workbench__theme-menu absolute left-0 top-full z-30 mt-2 w-40 rounded-xl border p-1.5 shadow-xl" role="group" aria-label="任务刷新范围">
                  <button type="button" onClick={() => refresh('all')} disabled={localLoading || projectLoading} className="workspace-workbench__theme-option block w-full rounded-lg px-2 py-2 text-left text-xs disabled:opacity-50">全部刷新</button>
                  <button type="button" onClick={() => refresh('local')} disabled={localLoading || projectLoading} className="workspace-workbench__theme-option block w-full rounded-lg px-2 py-2 text-left text-xs disabled:opacity-50">刷新本地</button>
                  <button type="button" onClick={() => refresh('project')} disabled={localLoading || projectLoading} className="workspace-workbench__theme-option block w-full rounded-lg px-2 py-2 text-left text-xs disabled:opacity-50">刷新飞书</button>
                </div>
              </details>
              </div>
            <div className="workspace-workbench__header-display">
              <button type="button" onClick={() => setWide((value) => !value)} aria-pressed={wide} className="hidden rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/10 lg:inline-flex">{wide ? '标准宽度' : '宽屏显示'}</button>
              <details ref={themePicker} className="workspace-workbench__theme-picker relative" onToggle={(event) => { if (event.currentTarget.open) refreshPicker.current?.removeAttribute('open'); }}>
                <summary className="workspace-workbench__theme-trigger cursor-pointer rounded-lg border px-3 py-1.5 text-xs"><span>主题：{WORKBENCH_THEME_OPTIONS.find((option) => option.id === workbenchTheme)?.label}</span><svg className="workspace-workbench__theme-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg></summary>
                <div className="workspace-workbench__theme-menu absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border p-1.5 shadow-xl" role="group" aria-label="任务工作台主题">
                  {WORKBENCH_THEME_OPTIONS.map((option) => <button key={option.id} type="button" onClick={() => chooseWorkbenchTheme(option.id)} aria-pressed={workbenchTheme === option.id} className="workspace-workbench__theme-option flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs" data-theme-choice={option.id}><span className="workspace-workbench__theme-preview shrink-0" aria-hidden="true"><span className="workspace-workbench__theme-preview-card"><i /><i /><b /></span></span><span><strong className="block font-medium">{option.label}</strong><small className="block">{option.note}</small></span></button>)}
                </div>
              </details>
            </div>
            <div className="workspace-workbench__header-meta space-y-1 text-xs text-slate-400">
                  <div className="workspace-workbench__header-counts">
                    <span>本地交付：{taskCountDisplay(hasLocalData, recordCounts.deliveries, localLoading, false)}</span>
                    <span>飞书工作项：{taskCountDisplay(hasProjectData, recordCounts.workItems, projectLoading, false)}</span>
                    <WorkspaceHelpBadge label="任务计数" content={`本地交付与飞书工作项分别计数，不能相加；飞书工作项去重。本人子任务 ${recordCounts.children} 项，责任节点 ${recordCounts.nodes} 个。`} />
                  </div>
              </div>
          </div>
          <WorkspaceSourceTimes dashboard={dashboard} responsibility={responsibility} localFailed={localRefreshFailed && !localLoading} projectFailed={projectRefreshFailed && !projectLoading} localRequestFailed={!!dashboardError} projectRequestFailed={!!projectError} localRefreshAt={(sourceRefreshTimes.userId===userId?sourceRefreshTimes.times:initialRefreshTimes).local} projectRefreshAt={(sourceRefreshTimes.userId===userId?sourceRefreshTimes.times:initialRefreshTimes).project} />
          {refreshTiming && (localLoading || projectLoading || ((!refreshTiming.localRequested || !localRefreshFailed) && (!refreshTiming.projectRequested || !projectRefreshFailed))) && <div className={`workspace-workbench__refresh-banner mt-2 flex w-fit max-w-full items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${refreshBannerTone}`}>
            <p role="status" className="min-w-0 break-words">{refreshTiming.localRequested && <>本地台账：{localLoading ? '同步中' : localRefreshFailed ? '失败' : localRefreshPartial ? '部分失败' : '已更新'} · {localLoading ? '已耗时' : '耗时'} {formatRefreshSeconds(refreshTiming.localMs ?? refreshTiming.observedAt - refreshTiming.startedAt)} · </>}任务报表：{refreshTiming.projectRequested
              ? <>{projectLoading && refreshTiming.projectMs === null ? '同步中' : projectRefreshFailed ? '失败' : '已更新'} · {projectLoading && refreshTiming.projectMs === null ? '已耗时' : '耗时'} {formatRefreshSeconds(refreshTiming.projectMs ?? refreshTiming.observedAt - refreshTiming.startedAt)}</>
              : '未刷新'}</p>
            <Tooltip content="关闭刷新提示" asChild><button type="button" onClick={() => setRefreshTiming(null)} aria-label="关闭刷新提示" className="shrink-0 rounded px-0.5 text-base leading-4 text-slate-400 hover:bg-white/10 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">×</button></Tooltip>
          </div>}
        </div>
      </header>

      {(dashboardError || dashboard?.sourceMeta?.state === 'failed_snapshot') && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-950/30 p-3 text-sm">{dashboard?.sourceMeta?.lastSuccessAt ? `台账更新失败，显示 ${formatSummaryTime(dashboard.sourceMeta.lastSuccessAt)} 的上次成功数据。` : dashboard ? `台账更新失败，显示上次成功数据。` : '本地台账暂不可用。'} <FailureNotice error={dashboardError || (dashboard?.sourceMeta?.state === 'failed_snapshot' ? dashboard.sourceMeta.error : undefined)} /> <button type="button" onClick={() => refreshSource('local')} className="underline underline-offset-2">重试</button></p>}
      {dashboard?.sourceMeta?.state !== 'failed_snapshot' && dashboard?.errors.map((error) => <p key={error} role="status" className="rounded-xl border border-amber-400/25 bg-amber-950/25 p-3 text-sm"><FailureNotice error={error} /></p>)}
      {responsibility?.associationMeta && responsibility.associationMeta.state !== 'complete' && <p role="status" className="text-sm text-amber-300">{responsibility.associationMeta.state === 'unbound' ? '本地台账未绑定飞书连接，分别展示两侧数据。' : responsibility.associationMeta.error || '部分台账关联尚未核实。'}</p>}
      {!projectNoticeDismissed && (projectError || responsibility?.sourceMeta?.state === 'failed_snapshot' || responsibility?.stale) && <div className="mt-2 flex w-fit max-w-full items-start gap-1.5 rounded-lg border border-amber-400/25 bg-amber-950/25 px-2.5 py-1.5 text-sm">
        <p role="status" className="min-w-0 break-words">{snapshotNotice('飞书', responsibility?.sourceMeta) ?? (responsibility ? `任务报表本次未完成更新，显示 ${formatSummaryTime(responsibility.fetchedAt)} 的上次成功数据。` : '任务报表暂不可用。')} {(projectError || responsibility?.sourceMeta?.state === 'failed_snapshot') && <FailureNotice error={projectError || (responsibility?.sourceMeta?.state === 'failed_snapshot' ? responsibility.sourceMeta.error : undefined)} />} <button type="button" onClick={() => refreshSource('project')} className="underline underline-offset-2">重试</button></p>
        <Tooltip content="关闭任务报表提示" asChild><button type="button" onClick={() => setProjectNoticeDismissed(true)} aria-label="关闭任务报表提示" className="shrink-0 rounded px-0.5 text-base leading-4 text-slate-400 hover:bg-white/10 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">×</button></Tooltip>
      </div>}
      <WorkspaceResponsibilityNotice responsibility={responsibility} />
      <div className="min-w-0 space-y-4">
        {!desktopLayout && <WorkspaceCodexResourceCard key={userId} userId={userId} />}
        <section aria-labelledby="focus-heading" className="workspace-workbench__focus-container min-w-0 rounded-2xl border border-white/10 bg-[#111927] p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2"><h2 id="focus-heading" className="flex flex-wrap items-center text-base font-semibold">当前焦点 <span className="ml-2 text-xs font-normal text-slate-400">{focusEntries.length} 个事项</span><WorkspaceHelpBadge label="当前焦点" content="同一飞书父项归为一个事项，优先显示进行中任务；等待事项靠后，只有暂停工作的事项不占焦点。" /></h2><a href="#task-search" className="text-xs text-cyan-300 hover:underline">查看全部任务 ↓</a></div>
          <div ref={focusScrollRef} aria-label="当前焦点任务" tabIndex={0} className="workspace-workbench__focus-scroll min-w-0">
          <div className="workspace-workbench__focus-columns min-w-0">
            {focusEntries.length > 0 && focusColumns.map((column, index) => <div key={index} className="workspace-workbench__focus-column">{column.map((entry) => <div key={entry.key} data-focus-key={entry.key} className="workspace-workbench__focus-item">{renderTaskCard(entry)}</div>)}</div>)}
            {!localLoading && !projectLoading && focusEntries.length === 0 && <p className="py-6 text-sm text-slate-400">当前没有未完成事项。</p>}
            {localLoading && !dashboard && <p className="py-6 text-sm text-slate-400">正在读取任务台账…</p>}
          </div>
          </div>
        </section>

      </div>

        <section id="task-search" aria-labelledby="all-heading" className="workspace-workbench__task-list min-w-0 scroll-mt-3 rounded-2xl border border-white/10 bg-[#111927]">
          <div className="shrink-0 space-y-3 border-b border-white/10 p-4">
            <h2 id="all-heading" className="font-semibold">任务列表 <span className="ml-1 text-xs font-normal text-slate-400">{visibleTaskCount} / {displayEntries.filter(isWorkbenchTaskVisible).length} 项</span><WorkspaceHelpBadge label="任务列表" content={`同一事项的父项、子项和明确关联台账合为一张卡，三个列表互不重复。${taskLaneOrder.map(({title,note})=>`${title}：${note}`).join('；')}。计数为筛选后显示数 / 总数；焦点与底部流转跟踪不另计任务数。`} /></h2>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row"><select aria-label="任务关联筛选" value={associationFilter} onChange={(event) => { featureAction('workbench','filter','workbench');setAssociationFilter(event.target.value as TaskAssociationFilter); setLaneStatusFilters({ unstarted: '', doing: '', completed: '' }); }} className="w-full shrink-0 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs text-slate-100 sm:w-52"><option value="all">全部</option><option value="feishu">飞书任务及关联台账</option><option value="local">未关联飞书的台账</option><option value="uncertain">关联待确认的台账</option></select><input aria-label="搜索任务" onBlur={()=>commitSearch(search)} onKeyDown={event=>{if(event.key==='Enter')commitSearch(search);}} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或 ID" enterKeyHint="search" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs text-slate-100" /></div>
            <div className="flex gap-1.5 lg:hidden" aria-label="任务状态列表">{taskLaneOrder.map(({ key, title }) => <button key={key} type="button" onClick={() => {if(mobileTaskLane!==key)featureAction('workbench','mode','workbench');setMobileTaskLane(key);}} aria-pressed={mobileTaskLane === key} className={`min-h-10 min-w-0 flex-1 rounded-md border px-2 py-2 text-[13px] font-normal sm:text-sm ${mobileTaskLane === key ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-200' : 'border-white/10 text-slate-400'}`}>{title} <span className="tabular-nums">{taskLanes[key].length}</span></button>)}</div>
          </div>
           <div className="workspace-workbench__task-lanes grid min-w-0 gap-3 p-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1.15fr)_minmax(260px,0.75fr)]">
            {(associationFilter === 'local' || associationFilter === 'uncertain') && !comparisonReady && <p role="status" className="col-span-full rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100">需本地台账与飞书工作项均成功读取，才能判断台账关联状态。</p>}
            {associationFilter === 'all' && !localLoading && !projectLoading && entries.length === 0 && !dashboard?.sourceAvailable.registry && !responsibility && <p className="col-span-full p-3 text-sm text-slate-400">任务来源暂不可用。</p>}
             {taskLaneOrder.map(({ key, title, note, titleTone, headerTone }) => <section key={key} id={`task-lane-${key}`} aria-label={`${title}任务`} data-mobile-active={mobileTaskLane === key} className="workspace-workbench__task-lane min-w-0 rounded-xl border border-white/10 bg-slate-950/40 p-2.5 scroll-mt-4">
              <div className={`mb-3 ${laneStatusOptions[key].length > 1 ? 'flex' : 'hidden'} min-w-0 items-center justify-between lg:flex lg:min-h-14 lg:gap-2 lg:rounded-lg lg:border lg:px-2.5 lg:py-2 ${headerTone} ${key === 'doing' ? 'workspace-workbench__lane-doing' : ''}`}>
                <div className="hidden shrink-0 items-center lg:flex"><h3 className={`whitespace-nowrap text-sm font-semibold ${titleTone}`}>{title} <span className="ml-1 font-normal tabular-nums text-slate-400">{taskLanes[key].length}</span></h3><WorkspaceHelpBadge label={title} content={`${note}。筛选按卡片右上角汇总状态；只有一种状态时不显示筛选。`} /></div>
                {laneStatusOptions[key].length > 1 && <select aria-label={`${title}状态筛选`} value={laneStatusFilters[key]} onChange={(event) => {featureAction('workbench','filter','workbench');setLaneStatusFilters((current) => ({ ...current, [key]: event.target.value }));}} className="min-h-9 w-full min-w-0 rounded-md border border-white/15 bg-slate-950 px-2 py-1 text-xs text-slate-100 lg:w-auto lg:max-w-40 lg:flex-1"><option value="">全部状态</option>{laneStatusOptions[key].map(({label,count}) => <option key={label} value={label}>{label} · {count} 项</option>)}</select>}
              </div>
               <div ref={key === 'completed' ? completedScrollRef : undefined} aria-label={`${title}任务卡片`} tabIndex={0} className="workspace-workbench__task-lane-scroll min-w-0 space-y-2">
                 {(key === 'completed' ? taskLanes[key].slice(0, completedVisibleCount) : taskLanes[key]).map((entry, index) => <Fragment key={entry.key}>
                  {key === 'completed' && index % 10 === 0 && <p className="border-b border-white/10 py-2 text-center text-[11px] text-slate-400">第 {index / 10 + 1} 页 · 第 {index + 1}–{Math.min(index + 10, taskLanes.completed.length)} 项</p>}
                  {renderTaskCard(entry)}</Fragment>)}
                {!localLoading && !projectLoading && taskLanes[key].length === 0 && (associationFilter === 'all' || comparisonReady) && <p className="p-3 text-xs text-slate-500">{search || laneStatusFilters[key] ? '没有匹配任务' : '暂无任务'}</p>}
                {key === 'completed' && taskLanes.completed.length > 0 && <div className="space-y-2 py-2 text-center">
                  <p role="status" className="text-[11px] text-slate-500">{completedVisibleCount < taskLanes.completed.length ? `已显示 ${completedVisibleCount} / ${taskLanes.completed.length} 项` : `已显示全部 ${taskLanes.completed.length} 项`}</p>
                  {completedVisibleCount < taskLanes.completed.length && <button type="button" onClick={() => {featureAction('workbench','load_more','workbench');setCompletedVisibleCount((count) => Math.min(taskLanes.completed.length, count + 10));}} className="min-h-10 w-full rounded-lg border border-white/15 px-3 py-2 text-xs text-cyan-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">加载下一页</button>}
                </div>}
              </div>
            </section>)}
            {(localLoading || projectLoading) && entries.length === 0 && <p className="p-3 text-sm text-slate-400">正在读取任务…</p>}
          </div>
        </section>
        <details aria-label="我参与的流转中事项" className="min-w-0 rounded-2xl border border-white/10 bg-[#111927]">
          <summary className="flex min-h-14 w-full cursor-pointer list-none flex-col items-start gap-1 rounded-2xl p-4 text-sm font-semibold hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:p-5">
            <span className="min-w-0 break-words">我参与的流转中事项 <span className="ml-1 font-normal text-slate-400">{trackedItems.length} 项</span><WorkspaceHelpBadge label="我参与的流转中事项" content="本人已完成、共同参与或后续负责，整体仍流转的事项。本人完成的事项可同时保留在已结束列表；此处不另计任务数。当前有待办的事项在主卡查看。" /></span>
            <span className="min-w-0 break-words text-xs font-normal text-slate-500">{responsibility?.generatedAt ? `飞书 ${formatSummaryTime(responsibility.generatedAt)}` : '飞书数据未读取'}{responsibility?.stale && ' · 旧数据'} <span aria-hidden="true">⌄</span></span>
          </summary>
          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <div className="space-y-2">
            {trackedItems.map((entry) => <div key={`${entry.kind}:${entry.item.workItemId}`} className="min-w-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-stretch gap-x-3">
                <div className="min-w-0">
                  <p className="mb-1 text-[11px] text-slate-500">{trackedParticipationLabel(entry, model.tasks)}</p>
                  <button type="button" onClick={() => openDetail({kind:entry.kind === 'parent' ? 'group' : 'project',id:entry.item.workItemId})} className="min-w-0 break-all text-left font-medium leading-5 text-slate-100 hover:text-cyan-300">{entry.item.typeName || '飞书事项'} · {entry.item.title}</button>
                  <div className="mt-1.5 space-y-1 text-slate-400">
                    <p className="min-w-0 break-words">{entry.kind === 'parent' ? currentNodeResponsibilityLabel(entry.item) : stateFlowResponsibilityLabel(entry.item)}</p>
                    {entry.kind === 'parent' && entry.item.myNodes?.some((node) => node.phase === 'upcoming') && <p className="text-slate-500">后续参与：{entry.item.myNodes.filter((node) => node.phase === 'upcoming').map((node) => node.name).filter(Boolean).join('、')}（未激活）</p>}
                    {entry.kind === 'project' && <PersonalCompletionNotice item={entry.item} tasks={model.tasks} />}
                    <p className="text-slate-500">更新 {formatTime(entry.item.updatedAt)}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5 whitespace-nowrap py-0.5">
                  {entry.item.url && <a href={entry.item.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline" aria-label={`在飞书打开${entry.item.title}（${entry.item.workItemId}）`} onClick={()=>{localAction('workbench','open_external','workbench')(true);}}>{entry.item.workItemId} ↗</a>}
                  <div className="mt-auto">{renderSessionActions(entry.kind==='parent'?{kind:'parent',key:`parent:${entry.item.workItemId}`,item:entry.item}:entry)}</div>
                </div>
              </div>
            </div>)}
            {trackedItems.length === 0 && <p className="text-xs text-slate-500">{projectLoading ? '正在读取…' : responsibility ? '暂无符合条件的流转事项。' : '飞书数据暂不可用。'}</p>}
          </div>
          </div>
        </details>
        <details aria-label="执行记录与会话" className="workspace-workbench__observation min-w-0 rounded-2xl border border-white/10 bg-[#111927]">
          <summary className="flex min-h-14 w-full cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-2xl p-4 hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 sm:p-5"><span className="text-sm font-semibold">执行记录与会话<WorkspaceHelpBadge label="执行记录与会话" content="执行按开始时间倒序，会话按最近活动展示。执行记录反映本机登记的运行情况，任务是否交付与验收仍以所属任务为准。" /></span><span className="text-xs text-slate-400">执行 {observation.runs.items.length} 条 · 会话 {observation.sessions.items.length} 条 <span aria-hidden="true">⌄</span></span></summary>
          <div className="grid min-w-0 gap-3 px-4 pb-4 sm:px-5 sm:pb-5 lg:grid-cols-2">
            <ObservationSection title="最近执行记录" count={observation.runs.items.length} tone="text-violet-200" empty={observation.runs.available ? '暂无记录' : '来源不可用'} onRefresh={() => void refreshObservation('runs')} refreshing={observationLoading.runs === true} error={observationErrors.runs}>
              {observation.runs.items.map((item) => <RunRow key={`${item.taskId}:${item.runId}`} run={item} taskTitle={observation.runs.tasks.find((task) => task.id === item.taskId)?.title || undefined} onOpen={() => openRunDetail(item,observationSnapshots.runs??dashboard)} />)}
            </ObservationSection>
            <ObservationSection title="最近会话" count={observation.sessions.items.length} tone="text-cyan-200" empty={observation.sessions.available ? '暂无记录' : '来源不可用'} onRefresh={() => void refreshObservation('sessions')} refreshing={observationLoading.sessions === true} error={observationErrors.sessions}>
              {observation.sessions.items.map((item) => {
                const titles=[...new Set(((observationSnapshots.sessions??dashboard)?.tasks??[]).filter(task=>task.sessionIds.includes(item.sessionId)).map(task=>task.title||task.id))];
                return <a key={item.sessionId} href={item.url} className="block min-w-0 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 hover:border-cyan-300/40"><span className="block break-words text-xs font-medium text-slate-100">{item.title || item.sessionId}</span><Tooltip content={item.updatedAt ? formatTime(item.updatedAt) : undefined} asChild><span className="mt-1 block text-[11px] text-slate-400">{formatSessionActivity(item.updatedAt, Date.now())}</span></Tooltip><Tooltip overflowOnly content={titles.join('、')||undefined} asChild><span className="mt-1 block line-clamp-2 break-words text-[11px] text-slate-500">{titles.length?`曾处理：${titles.slice(0,2).join('、')}${titles.length>2?` 等${titles.length}项`:''}`:observation.sessions.unlinkedSessionIds.has(item.sessionId)?'未关联任务':'已有任务关联历史'}</span></Tooltip></a>;
              })}
            </ObservationSection>
          </div>
        </details>
    </div>

    {actionError && <div role="alert" className="fixed bottom-4 left-4 right-4 z-[60] mx-auto flex max-w-xl items-start justify-between gap-3 rounded-xl border border-rose-300/30 bg-slate-900 p-3 text-sm text-rose-200 shadow-xl"><span><FailureNotice error={actionError} /></span><button type="button" onClick={() => setActionError(null)} className="shrink-0 text-xs underline">关闭</button></div>}
    {task && taskDashboard && detailSelection && <Drawer key={`local:${task.id}`} viewKey={`local:${task.id}`} positions={detailScrollPositions} suspended={detailPreview&&panelVisible} onBack={detailHistory.length?backDetail:undefined} title={task.title || task.id} subtitle={`任务 ID：${task.id}`} onClose={() => closeDetail()} onRefresh={() => void reloadSelectedDetail(detailSelection).catch(() => undefined)} refreshing={refreshingDetail}>
      {detailRefreshError && <p role="alert" className="text-xs text-rose-300">刷新任务失败：<FailureNotice error={detailRefreshError} /></p>}
      <DetailAvailability dashboard={taskDashboard} responsibility={projectForTask.length?detailResponsibility:null}/><FeishuContextAlerts items={projectForTask} />
      <Block title="任务概况">
        <p>{localTaskStatusLabel(task)}<span className="ml-2 text-xs text-slate-500">最近记录 {formatTime(latestTaskRecordAt(task))}</span></p>
        <TaskProgressNotice entry={{kind:'local',key:task.id,task}}/>
        {!!task.diagnostics?.length&&<p role="status" className="text-xs text-amber-200">台账需核对：{task.diagnostics.join('；')}</p>}
        <DetailText label="任务说明" text={task.description}/><DetailText label="当前情况" text={task.statusBasis}/>
        {localTaskLaneForDisplay(task)!=='completed'&&<><DetailText label="等待事项" text={task.waitingOn}/><DetailText label="下一步" text={task.nextAction}/></>}
      </Block>
      {taskFiles.length>0&&<Block title="任务资料"><TaskFileLinks files={taskFiles} onOpen={previewDetailFile}/></Block>}
      <WorkspaceSessionPanel taskId={task.id} dashboard={taskDashboard} userId={userId} onNew={()=>launchTaskEntry({kind:'local',key:task.id,task},taskDashboard)} onOpen={continueSession} onChanged={()=>reloadChangedTask(detailSelection,task.id,detailResponsibility)}/>
      {taskContextItems.length>0&&<Block title="关联飞书任务"><DeliveryFeishuNotice linkedFeishu={taskContextItems} completed={localTaskLaneForDisplay(task)==='completed'} needsRecheck={false} inDetail/></Block>}
      {renderRunSection(taskRuns,taskDashboard)}
      <DetailDisclosure title="补充信息">
        <p>最后核验：{formatTime(task.lastVerifiedAt)}</p>{task.completedAt&&<p>完成时间：{formatTime(task.completedAt)}</p>}
        {localTaskLaneForDisplay(task)==='completed'&&<><DetailText label="历史等待事项" text={task.waitingOn}/><DetailText label="历史下一步" text={task.nextAction}/></>}
        <p className="break-all">任务路径：{task.taskPath||'未登记'}</p>
        {projectForTask.map(item=><div key={item.workItemId}><p className="text-xs text-slate-500">{item.title} · {item.workItemId}</p><FeishuContext item={item}/></div>)}
        {task.activityEvidence?.incomplete&&<p className="text-xs text-amber-300">活动观测不完整，用时只累计至最后可靠心跳。</p>}
        <DetailSourceTimes dashboard={taskDashboard} responsibility={projectForTask.length?detailResponsibility:null}/>
      </DetailDisclosure>
    </Drawer>}
    {project && projectDetails && detailSelection && <Drawer key={`project:${project.workItemId}`} viewKey={`project:${project.workItemId}`} positions={detailScrollPositions} suspended={detailPreview&&panelVisible} onBack={detailHistory.length?backDetail:undefined} title={project.title} subtitle={`工作项 ID：${project.workItemId}`} onClose={() => closeDetail()} onRefresh={() => void reloadSelectedDetail(detailSelection).catch(() => undefined)} refreshing={refreshingDetail}>
      {detailRefreshError && <p role="alert" className="text-xs text-rose-300">刷新工作项失败：<FailureNotice error={detailRefreshError} /></p>}
      <DetailAvailability dashboard={taskDashboard} responsibility={detailResponsibility}/><FeishuContextAlerts items={[project]} />
       <Block title="任务概况"><p className="break-words">{feishuWorkItemStatusLabel(project)}</p><p>{isPersonalProjectComplete(project)?'历史责任关系':'个人责任'}：{responsibilityText(project.actionability)} · {project.typeName || '工作项'}</p>{!isPersonalProjectComplete(project)&&<p className="text-slate-400">{responsibilityExplanation(project.actionability)}</p>}<p>{feishuUrlForWorkItem(project)&&<a href={feishuUrlForWorkItem(project)!} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline" onClick={()=>localAction('workbench','open_external','workbench')(true)}>在飞书打开 ↗</a>}</p>{!isPersonalProjectComplete(project)&&<><p className="break-words">个人事项：{projectDetails.current}</p><p className="break-words">下一步：{projectDetails.next}</p></>}<FeishuBusinessSummary item={project}/></Block>
      {taskDashboard && <WorkspaceSessionPanel taskId={`feishu:${project.workItemId}`} targetRef={`feishu:${project.workItemId}`} dashboard={taskDashboard} userId={userId} localTaskIds={project.localTaskIds} onOpen={continueSession} onNew={()=>launchTaskEntry({kind:'project',item:project},taskDashboard)} onChanged={()=>reloadSelectedDetail(detailSelection)} />}
      {project.personalSubtasks.length>0&&<Block title={`本人子任务 · ${project.personalSubtasks.length}`}>
        <p className="text-xs text-slate-400">已完成 {projectFinishedChildren.length} · 未完成 {projectUnfinishedChildren.length}<WorkspaceHelpBadge label="本人子任务" content="子任务定位信息以飞书详情为准；飞书与本地台账分别记录状态。" /></p>
        {projectUnfinishedChildren.map(child=><ProjectSubtaskRow key={child.id} child={child} parent={projectNativeParent} onOpen={()=>openDetail({kind:'subtask',id:`${project.workItemId}:${child.id}`})} />)}
        {projectFinishedChildren.length>0&&<details open={projectUnfinishedChildren.length===0}><summary className="cursor-pointer text-xs text-slate-400">已完成子任务 · {projectFinishedChildren.length}</summary><div className="mt-2 space-y-2">{projectFinishedChildren.map(child=><ProjectSubtaskRow key={child.id} child={child} parent={projectNativeParent} onOpen={()=>openDetail({kind:'subtask',id:`${project.workItemId}:${child.id}`})} />)}</div></details>}
      </Block>}
      <PersonalCompletionNotice item={project} tasks={taskDashboard?.tasks} />
      {!!project.linkedStoryIds?.length && <Block title="关联需求">{project.linkedStoryIds.map((id) => {
        const story = detailResponsibility?.workbenchItems.find((item) => item.workItemId === id)
          ?? detailResponsibility?.items.find((item) => item.workItemId === id);
        return <p key={id} className="break-words">{story?.url ? <a href={story.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline" onClick={()=>{localAction('workbench','open_external','workbench')(true);}}>{story.title} · {id}</a> : `${story?.title ?? '需求'} · ${id}（链接未核验）`}</p>;
      })}</Block>}
      <Block title={`本地台账 · ${projectLocalTasks.length}`}><DetailLocalLedgerList tasks={projectLocalTasks} registeredIds={project.localTaskIds} available={taskDashboard?.sourceAvailable.registry} renderRow={(local) => <GroupedLocalRow key={local.id} task={local} onOpen={() => openTask(local.id, taskDashboard ?? undefined)} sessionActions={renderSessionActions({kind:'local',key:local.id,task:local},taskDashboard)} onOpenDocument={(filePath) => { previewDetailFile(filePath); }} />} /></Block>
      {renderRunSection(projectRuns,taskDashboard)}
      <OperationHistory available={!!operationParentId&&!!operationAnchor} key={detailSelection.id} activity={activeOperations} loading={activityLoading} error={activityError} onMore={() => void loadMoreOperations()} onRefresh={() => void refreshOperations()} childTitles={Object.fromEntries(project.personalSubtasks.map((child) => [child.id, child.name]))} />
      <DetailDisclosure title="补充信息"><p>飞书最近更新：{formatTime(project.updatedAt)}</p><FeishuContext item={project}/>{project.version&&<p>版本：{project.version}</p>}<DetailSourceTimes dashboard={taskDashboard} responsibility={detailResponsibility}/></DetailDisclosure>
    </Drawer>}
    {workbenchParent && detailSelection && <Drawer key={`${detailSelection.kind}:${detailSelection.id}`} viewKey={`${detailSelection.kind}:${detailSelection.id}`} positions={detailScrollPositions} suspended={detailPreview&&panelVisible} onBack={detailHistory.length?backDetail:undefined} title={workbenchSubtask?.title ?? workbenchParent.title} subtitle={workbenchSubtask ? `子任务 ID：${workbenchSubtask.id}` : `父工作项 ID：${workbenchParent.workItemId}`} onClose={() => closeDetail()} onRefresh={() => void reloadSelectedDetail(detailSelection).catch(() => undefined)} refreshing={refreshingDetail}>
      {detailRefreshError && <p role="alert" className="text-xs text-rose-300">刷新飞书任务失败：<FailureNotice error={detailRefreshError} /></p>}
      <DetailAvailability dashboard={taskDashboard} responsibility={detailResponsibility}/><FeishuContextAlerts items={[workbenchParent]} />
      <Block title="任务概况">
        {workbenchSubtask?<><p>子任务状态：{workbenchSubtaskStatusLabel(workbenchSubtask)}</p><p>{workbenchSubtaskNodeLabel(workbenchSubtask)}</p><p className="text-xs text-slate-500">{childTimeText(workbenchSubtask.id)}{workbenchSubtask.finishedAt?` · 完成 ${formatTime(workbenchSubtask.finishedAt)}`:''}</p><p>所属父项：<button type="button" onClick={()=>openDetail({kind:'group',id:workbenchParent.workItemId})} className="text-cyan-300 hover:underline">{workbenchParent.title}</button></p><p className="text-xs text-slate-400">父项流程：{feishuWorkItemStatusLabel(workbenchParent)}</p></>:<><p>{feishuWorkItemStatusLabel(workbenchParent)}</p><p>参与关系：{workbenchParticipationLabel(workbenchParent,detailResponsibility?.sourceUserKey)}</p><p>{workItemCurrentNodeLines(workbenchParent).join('；')||'当前节点未返回'}</p></>}
        <p>{(workbenchSubtask?subtaskUrl(workbenchParent,workbenchSubtask):workbenchParent.url)&&<a href={(workbenchSubtask?subtaskUrl(workbenchParent,workbenchSubtask):workbenchParent.url)!} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline" onClick={()=>localAction('workbench','open_external','workbench')(true)}>在飞书打开 ↗</a>}</p>
        <FeishuBusinessSummary item={workbenchParent}/>
      </Block>
      {taskDashboard && <WorkspaceSessionPanel taskId={workbenchSubtask?`feishu-subtask:${workbenchParent.workItemId}:${workbenchSubtask.id}`:`feishu:${workbenchParent.workItemId}`} targetRef={workbenchSubtask?`feishu-subtask:${workbenchParent.workItemId}:${workbenchSubtask.id}`:`feishu:${workbenchParent.workItemId}`} dashboard={taskDashboard} userId={userId} localTaskIds={(workbenchSubtask?subtaskLocalTasks:parentLocalTasks).map(task=>task.id)} onOpen={continueSession} onNew={()=>launchTaskEntry(workbenchSubtask?{kind:"subtask",key:workbenchSubtask.id,parent:workbenchParent,subtask:workbenchSubtask,localTasks:subtaskLocalTasks}:{kind:"parent",key:workbenchParent.workItemId,item:workbenchParent},taskDashboard)} onChanged={()=>reloadSelectedDetail(detailSelection)} />}
      {(detailSelection.kind === 'group' || detailSelection.kind === 'parent') && workbenchParent.mySubtasks.length>0 && <Block title={`我的飞书子任务 · ${workbenchParent.mySubtasks.length}`}>
        <p className="text-xs text-slate-400">飞书已完成 {personalSubtaskSummary(workbenchParent).completed} · 未完成 {personalSubtaskSummary(workbenchParent).unfinished}<WorkspaceHelpBadge label="子任务状态" content="飞书与本地台账分别记录状态，不自动修改任一来源。" /></p>
        {parentChildrenNeedingAttention.map(renderNativeChild)}
        {finishedParentChildren.length>0&&<details open={parentChildrenNeedingAttention.length===0}><summary className="cursor-pointer text-xs text-slate-400">已完成子任务 · {finishedParentChildren.length}</summary><div className="mt-2 space-y-2">{finishedParentChildren.map(renderNativeChild)}</div></details>}
      </Block>}
      {(detailSelection.kind === 'group' || detailSelection.kind === 'parent') && (matterLocalTasks.length>0||matterRegisteredLocalIds.length>0||taskDashboard?.sourceAvailable.registry===false) && <Block title={`本地台账 · ${matterLocalTasks.length}`}><DetailLocalLedgerList tasks={matterLocalTasks} registeredIds={matterRegisteredLocalIds} available={taskDashboard?.sourceAvailable.registry} renderRow={(local) => {
        const children = workbenchParent.mySubtasks.filter((child) => child.localTaskIds?.includes(local.id));
        const relationLabel = children.length ? `关联子任务：${children.map((child) => child.title).join('、')}` : local.feishuWorkItemIds.includes(workbenchParent.workItemId) ? '关联父项' : '归属本事项的关联交付';
        return <GroupedLocalRow key={local.id} task={local} relationLabel={relationLabel} onOpen={() => openTask(local.id, taskDashboard ?? undefined)} sessionActions={renderSessionActions({kind:'local',key:local.id,task:local},taskDashboard)} onOpenDocument={(filePath) => { previewDetailFile(filePath); }} />;
      }} /></Block>}
      {(detailSelection.kind === 'group' || detailSelection.kind === 'parent') && relatedGroupIssues.length > 0 && <Block title={`责任清单内关联缺陷 · ${relatedGroupIssues.length}`} help="仅展示当前账号责任清单中已核实的关联，不代表需求全部缺陷。">
        <DetailIssueList items={relatedGroupIssues} onOpen={id=>openProject(id)} />
      </Block>}
      {workbenchSubtask && <Block title={`关联本地台账 · ${subtaskLocalTasks.length}`}><DetailLocalLedgerList tasks={subtaskLocalTasks} registeredIds={workbenchSubtask.localTaskIds??[]} available={taskDashboard?.sourceAvailable.registry} renderRow={(local) => <GroupedLocalRow key={local.id} task={local} childTitle={workbenchSubtask.title} onOpen={() => openTask(local.id, taskDashboard ?? undefined)} sessionActions={renderSessionActions({kind:'local',key:local.id,task:local},taskDashboard)} onOpenDocument={(filePath) => { previewDetailFile(filePath); }} />} /></Block>}
      {renderRunSection(matterRuns,taskDashboard)}
      <OperationHistory available={!!operationParentId&&!!operationAnchor} activity={activeOperations} loading={activityLoading} error={activityError} onMore={() => void loadMoreOperations()} onRefresh={() => void refreshOperations()} childId={workbenchSubtask?.id} childTitles={Object.fromEntries(workbenchParent.mySubtasks.map((child) => [child.id, child.title]))} />
      <DetailDisclosure title="补充信息"><FeishuContext item={workbenchParent}/><p>父项更新：{formatTime(workbenchParent.updatedAt)}</p><DetailSourceTimes dashboard={taskDashboard} responsibility={detailResponsibility}/></DetailDisclosure>
    </Drawer>}
    {run && <Drawer key={`run:${run.taskId}:${run.runId}`} viewKey={`run:${run.taskId}:${run.runId}`} positions={detailScrollPositions} suspended={detailPreview&&panelVisible} onBack={detailHistory.length?backDetail:undefined} title="执行详情" onClose={() => closeDetail()}><RunDetail run={run} taskTitle={runTask?.title || null} onOpenTask={runTask ? () => { setSelectedRun(null); openTask(runTask.id, runSource ?? undefined); } : undefined} onOpenFile={run.detailFilePath ? () => previewDetailFile(run.detailFilePath!) : undefined} /></Drawer>}
    {desktopLayout && dayPanel && <Suspense fallback={null}>{dayPanel === 'calendar'
      ? <WorkspaceCalendarPanel today={today} anchorRef={calendarButtonRef} onClose={() => setDayPanel((current) => current === 'calendar' ? null : current)} />
      : <WorkspaceWeatherPanel city={day?.location?.city} today={today} anchorRef={weatherButtonRef} onClose={() => setDayPanel((current) => current === 'weather' ? null : current)} />}</Suspense>}
  </main>;
}

function TaskProgressNotice({entry}: {entry: TaskDisplayEntry}) {
  if (taskEntryLane(entry) !== 'doing') return null;
  const at = taskEntryProgressAt(entry);
  const {label, stale} = progressRecency(at);
  return <Tooltip content={at === null ? '无有效推进时间' : `${formatTime(at)}（任务开始/核验及关联执行，不取父项/会话更新时间）`} asChild><p className={`mt-1 text-[11px] ${stale ? 'text-amber-200' : 'text-slate-500'}`}>{label}</p></Tooltip>;
}

function DetailLocalLedgerList({ tasks, renderRow, registeredIds=[],available=true }: { tasks: Task[]; renderRow: (task: Task) => ReactNode;registeredIds?:readonly string[];available?:boolean }) {
  const notice=localLedgerNotice(registeredIds,tasks,available);
  const sorted = sortDetailLocalTasks(tasks);
  const unfinished = sorted.filter(task=>localTaskLaneForDisplay(task)!=='completed');
  const completed = sorted.filter(task=>localTaskLaneForDisplay(task)==='completed');
  return <>
    {notice&&<p role="status" className={available?'text-xs text-slate-400':'text-xs text-amber-200'}>{notice}</p>}
    {tasks.length>0&&<p className="text-xs text-slate-400">未结束 {unfinished.length} 份 · 已结束 {completed.length} 份（含取消）</p>}
    {unfinished.map(renderRow)}
    {completed.length > 0 && <details className="group" open={unfinished.length===0}><summary className="cursor-pointer text-xs text-slate-400">已结束本地交付 · {completed.length}</summary><div className="mt-2 space-y-2">{completed.map(renderRow)}</div></details>}
  </>;
}

function GroupedLocalRow({ task, childTitle, relationLabel, onOpen, sessionActions, onOpenDocument }: { task: Task; childTitle?: string; relationLabel?: string; onOpen: () => void; sessionActions: ReactNode; onOpenDocument: (path: string) => void }) {
  const recordAt = latestTaskRecordAt(task);
  const recordSource = recordAt === task.lastVerifiedAt ? '核验' : recordAt === task.completedAt ? '完成' : recordAt === task.startedAt ? '开始' : null;
  return <div className="workspace-workbench__local-row min-w-0 rounded-md border border-white/10 p-2">
    <div className="flex flex-wrap items-start justify-between gap-1"><div className="min-w-0 flex-1"><span className="text-[10px] text-slate-500">本地台账</span><Tooltip overflowOnly={task.title !== childTitle} content={task.title || task.id} asChild><button type="button" onClick={onOpen} className="block break-words text-left text-xs font-medium text-slate-100 hover:text-cyan-300">{task.title === childTitle ? task.id : task.title || task.id}</button></Tooltip></div><span className="text-[11px] text-slate-400">{localTaskStatusLabel(task)}</span></div>
    {relationLabel && <p className="mt-1 break-words text-[11px] text-slate-500">{relationLabel}</p>}
    {localTaskLaneForDisplay(task)!=='completed'&&(task.nextAction || task.waitingOn) && <p className="mt-1 line-clamp-2 break-words text-[11px] text-slate-300">{task.waitingOn?'等待：':'下一步：'}{task.waitingOn || task.nextAction}</p>}
    <p className="mt-1 text-[11px] text-slate-500">{recordAt ? `本地最近记录（${recordSource}）：${formatTime(recordAt)}` : '本地更新时间未登记'}</p>
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"><TaskFileLinks files={taskPrimaryFiles(task)} onOpen={onOpenDocument}/>{sessionActions}</div>
  </div>;
}

function OperationHistory({ activity, loading, error, onMore, onRefresh, childId, childTitles,available=true }: {
  activity: WorkspaceOperationRecordsDto | null; loading: boolean; error: string | null;available?:boolean;
  onMore: () => void; onRefresh: () => void; childId?: string; childTitles: Record<string, string>;
}) {
  if(!available)return <DetailDisclosure title="飞书操作记录 · 暂不可查询"><p className="text-xs text-slate-400">缺少查询定位信息，可刷新任务资料后重试。</p></DetailDisclosure>;
  const events = (activity?.events ?? []).filter((event) => !childId || event.childId === childId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return <DetailDisclosure title={`飞书操作记录 · ${loading?'读取中':error?'读取失败':events.length}${activity?.hasMore?'（部分记录）':''}`}><p className="text-xs text-slate-500">{`${activity ? `查询范围：${formatTime(activity.rangeStart)} 至 ${formatTime(activity.rangeEnd)}` : '打开详情后按需读取近期记录'}；仅展示操作类型。`}</p>
    {loading && <p className="text-xs text-slate-400">正在读取操作记录…</p>}
    {error && <p role="alert" className="text-xs text-rose-300">操作记录读取失败：<FailureNotice error={error} /></p>}
    {!loading && activity && events.length === 0 && <p className="text-xs text-slate-400">当前查询窗口未查到相关操作。</p>}
    {activity?.hasMore && <p className="text-xs text-amber-200">查询窗口尚未查全，当前列表和子任务时间可能不是最新。</p>}
    {events.slice(0, 10).map((event, index) => <p key={`${event.at}:${event.childId ?? 'parent'}:${index}`} className="break-words text-xs text-slate-300">
      {formatTime(event.at)} · {event.childId ? `${childTitles[event.childId] ?? `子任务 ${event.childId}`}：` : ''}{event.label}
    </p>)}
    {events.length > 10 && <details><summary className="cursor-pointer text-xs text-cyan-300">查看其余 {events.length - 10} 条已载入记录</summary><div className="mt-2 space-y-1">{events.slice(10).map((event, index) => <p key={`${event.at}:${event.childId ?? 'parent'}:${index}`} className="break-words text-xs text-slate-400">{formatTime(event.at)} · {event.childId ? `${childTitles[event.childId] ?? `子任务 ${event.childId}`}：` : ''}{event.label}</p>)}</div></details>}
    <div className="flex gap-3 text-xs">{activity?.hasMore && <button type="button" disabled={loading} onClick={onMore} className="text-cyan-300 disabled:opacity-50">继续加载 →</button>}<button type="button" disabled={loading} onClick={onRefresh} className="text-cyan-300 disabled:opacity-50">刷新操作记录</button></div>
  </DetailDisclosure>;
}

function ProjectSubtaskRow({child,parent,onOpen}:{child:ProjectItem['personalSubtasks'][number];parent:WorkbenchItem|undefined;onOpen:()=>void}) {
  const native=parent?.mySubtasks.find(item=>item.id===child.id);
  const url=parent&&native?subtaskUrl(parent,native):null;
  return <div className="break-words text-xs"><p>{native?<button type="button" onClick={onOpen} className="text-slate-100 hover:text-cyan-300">{child.name}</button>:child.name} · {child.passed?'已完成':'未完成'}</p><p className="mt-1 text-slate-500">子任务 · {url?<a href={url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline" onClick={()=>localAction('workbench','open_external','workbench')(true)}>{child.id}</a>:`${child.id}（定位链接未核实）`}</p></div>;
}

function DetailIssueList({items,onOpen}:{items:ProjectItem[];onOpen:(id:string)=>void}) {
  const unfinished=items.filter(item=>!isFinishedProjectIssue(item));
  const completed=items.filter(isFinishedProjectIssue);
  const row=(item:ProjectItem)=><div key={item.workItemId} className="min-w-0 rounded-lg border border-white/10 p-2.5">
    <button type="button" onClick={()=>onOpen(item.workItemId)} className="block break-words text-left text-sm font-medium hover:text-cyan-300">{item.title}</button>
    <p className="mt-1 break-words text-xs text-slate-400">飞书状态：{item.statusName||'未返回'}</p>
    <p className="mt-1 break-words text-xs text-slate-500">{isFinishedProjectIssue(item)?'缺陷已结束':responsibilityText(item.actionability)} · {item.url?<a href={item.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline" onClick={()=>localAction('workbench','open_external','workbench')(true)}>{item.workItemId}</a>:`${item.workItemId}（链接未核验）`}</p>
  </div>;
  return <><p className="text-xs text-slate-400">未结束或待核实 {unfinished.length} · 已结束 {completed.length}</p>{unfinished.map(row)}{completed.length>0&&<details open={unfinished.length===0}><summary className="cursor-pointer text-xs text-slate-400">已结束缺陷 · {completed.length}</summary><div className="mt-2 space-y-2">{completed.map(row)}</div></details>}</>;
}

function TaskFileLinks({files,onOpen}:{files:ReturnType<typeof taskPrimaryFiles>;onOpen:(path:string)=>void}) {
  if(!files.length)return null;
  return <div aria-label="主要文件预览" className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1">{files.map(file=><Tooltip key={file.path} content={file.path} asChild><button type="button" onClick={()=>onOpen(file.path)} className="min-w-0 break-all text-left text-[11px] text-cyan-300 hover:underline">{file.label} · {file.path.split(/[\\\\/]/).pop()}</button></Tooltip>)}</div>;
}

function DetailAvailability({dashboard,responsibility}:{dashboard:WorkspaceConsoleDashboardDto|null;responsibility:WorkspaceConsoleResponsibilityDto|null}) {
  return <>{dashboard?.sourceAvailable.registry===false&&<p role="status" className="text-xs text-amber-200">本地台账来源不可用，关联列表不代表没有台账。</p>}{responsibility?.stale&&<p role="status" className="text-xs text-amber-200">飞书资料未更新，当前保留上次结果。</p>}</>;
}
function DetailSourceTimes({dashboard,responsibility}:{dashboard:WorkspaceConsoleDashboardDto|null;responsibility:WorkspaceConsoleResponsibilityDto|null}) {
  return <div className="text-xs text-slate-500"><p>台账最近获取：{formatTime(dashboard?.sourceMeta?.lastSuccessAt)}</p>{responsibility&&<p>飞书报表同步：{formatTime(responsibility.generatedAt)}</p>}<p>刷新会更新当前任务资料；飞书操作记录独立显示读取结果。</p></div>;
}
function FeishuBusinessSummary({item}:{item:Pick<WorkbenchItem,'release'|'applications'>}) {
  const pending=item.applications?.filter(app=>app.reconciliationRequired||app.unfinishedSubtasks.length>0)??[];
  return <>{item.release&&<p>发布：{item.release.mode==='canary'?'金丝雀':'普通'} · {item.release.version||'版本未核实'}</p>}{pending.length>0&&<p className="text-xs text-amber-200">需关注申请：{pending.map(app=>app.title).join('、')}</p>}</>;
}
function FeishuContextAlerts({items}:{items:Array<Pick<WorkbenchItem,'reasons'|'release'|'applicationCoverage'>>}) {
  const messages=[...new Set(items.flatMap(item=>[
    ...(item.reasons?.some(reason=>reason!=='unmapped_role')?['部分责任证据待核实，详见来源信息。']:[]),
    ...(item.release?.error?[`发布信息未核实：${item.release.error}`]:[]),
    ...(item.release?.conflict?['关联发布字段存在冲突。']:[]),
    ...(item.applicationCoverage==='partial'?['关联申请信息尚未全部核实。']:[]),
  ]))];
  return <>{messages.map(message=><p key={message} role="status" className="break-words text-xs text-amber-200">{message}</p>)}</>;
}

function FeishuContext({ item }: { item: Pick<WorkbenchItem, 'typeKey' | 'reasons' | 'release' | 'applications' | 'applicationCoverage'> }) {
  return <div className="space-y-1 text-xs text-slate-400">
    {item.typeKey && <p>原生类型：{item.typeKey}</p>}
    {!!item.reasons?.length && <p className="text-amber-300">{item.reasons.every(reason => reason === 'unmapped_role') ? '参与角色名称尚未取得；原生节点、子任务和流程状态分别保留。' : `证据待核实：${item.reasons.map(reason=>reason==='unverified_role_responsibility'?'角色已识别，当前处理责任尚未核实':reason).join('、')}`}</p>}
    {item.release && <p>发布：{item.release.mode === 'canary' ? '金丝雀' : '普通'} · {item.release.version || '版本未核实'}{item.release.source === 'linked_story' && ' · 来自关联需求'}{item.release.conflict && ' · 发布字段冲突'}{item.release.error && ' · ' + item.release.error}</p>}
    {item.applicationCoverage && <p>申请覆盖：{{not_configured:'未配置',not_queried:'未查询',complete:'已核实',partial:'部分未核实'}[item.applicationCoverage]}</p>}
    {item.applications?.map(app => <p key={app.workItemId}>申请：{app.title} · {app.workItemId} · {app.status} · {app.source === 'native_relation' ? '原生关联' : '台账绑定'}{app.finishedAt && ' · 完成 ' + formatTime(app.finishedAt)}{app.reconciliationRequired && ' · 申请已完成，请核对需求发布节点'}{app.unfinishedSubtasks.length > 0 && ' · 未完子任务：' + app.unfinishedSubtasks.map(task => task.name).join('、')}</p>)}
  </div>;
}

function ObservationSection({ title, count, tone, empty, onRefresh, refreshing, error, children }: { title: string; count: number; tone: string; empty: string; onRefresh: () => void; refreshing: boolean; error?: string; children: React.ReactNode }) { return <section aria-label={title} className="min-w-0 rounded-xl border border-white/10 bg-slate-950/35 p-3"><div className="mb-2 flex items-center justify-between gap-2"><h3 className={`text-xs font-semibold ${tone}`}>{title}</h3><div className="flex shrink-0 items-center gap-2"><Tooltip content={`刷新${title}`} asChild><button type="button" onClick={onRefresh} disabled={refreshing} aria-label={`刷新${title}`} className="rounded-md border border-white/15 px-1.5 py-0.5 text-xs text-slate-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:opacity-50"><span aria-hidden="true">{refreshing ? '刷新中…' : '↻'}</span></button></Tooltip><span className="text-[11px] tabular-nums text-slate-500">{count}</span></div></div>{error && <p role="alert" className="mb-2 text-xs text-rose-300">刷新失败：<FailureNotice error={error} /></p>}<div className="space-y-2">{count ? children : <p className="rounded-lg border border-white/5 p-2.5 text-xs text-slate-500">{empty}</p>}</div></section>; }
export function TaskRunRecords({ runs, onOpen,available=true }: { runs: WorkspaceConsoleRunDto[];available?:boolean; onOpen: (run: WorkspaceConsoleRunDto) => void }) {
  const [filter, setFilter] = useState<RunFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const filtered = runs.filter((run) => runMatchesFilter(run, filter));
  const options: Array<{ value: RunFilter; label: string }> = [{ value: 'all', label: '全部' }, { value: 'abnormal', label: '异常' }, { value: 'running', label: '执行中' }];
  if(!available&&!runs.length)return <p role="status" className="text-xs text-amber-200">执行记录来源不可用，暂无可靠结果。</p>;
  if(!runs.length)return <p className="text-xs text-slate-500">暂无执行记录。</p>;
  return <div className="min-w-0 space-y-2">
    {!available&&<p role="status" className="text-xs text-amber-200">执行来源更新失败，以下为已有记录。</p>}
    <div role="group" aria-label="筛选执行记录" className="flex flex-wrap gap-1.5">{options.map(({ value, label }) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setExpanded(false); }} className={`rounded-md border px-2 py-1 text-xs ${filter === value ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-200' : 'border-white/10 text-slate-400 hover:bg-white/5'}`}>{label} {runs.filter((run) => runMatchesFilter(run, value)).length}</button>)}</div>
    {(expanded ? filtered : filtered.slice(0, 3)).map((item) => <RunRow key={`${item.taskId}:${item.runId}`} run={item} onOpen={() => onOpen(item)} />)}
    {!filtered.length && <p className="py-2 text-xs text-slate-500">{runs.length ? '没有符合筛选的执行记录' : '暂无可识别的执行记录'}</p>}
    {filtered.length > 3 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="text-xs text-cyan-300 hover:underline">{expanded ? '收起，仅看最近 3 条' : `查看其余 ${filtered.length - 3} 条记录`}</button>}
  </div>;
}

export function RunDetail({ run, taskTitle, onOpenTask, onOpenFile }: { run: WorkspaceConsoleRunDto; taskTitle: string | null; onOpenTask?: () => void; onOpenFile?: () => void }) {
  const description = describeRun(run);
  const result = describeRunResult(run);
  const metrics = describeRunMetrics(run);
  const duration = formatRunDuration(run.durationSeconds);
  const hasPlannedRepair = run.resultMetrics?.items.some((item) => item.label === '计划修复') ?? false;
  const conditions = metrics?.conditions ?? [];
  const visibleConditions = (hasPlannedRepair ? conditions.filter((item) => !item.startsWith('符合修复条件 ')) : conditions).slice(0, 3);
  const extraConditions = conditions.filter((item) => !visibleConditions.includes(item));
  return <>
    <Block title="本次执行">
      <p className="break-words font-medium text-slate-100">{description.title}</p>
      <p className="break-words">所属任务：{onOpenTask ? <button type="button" onClick={onOpenTask} className="text-cyan-300 hover:underline">{taskTitle || run.taskId} →</button> : taskTitle || run.taskContext?.title || (run.taskId ? `未匹配任务（${run.taskId}）` : run.taskContext?.directory||'未记录')}</p>
      {run.taskContext?.association!=='registered'&&run.taskContext&&<p className="text-xs text-amber-200">任务目录已识别 · {run.taskContext.association==='ambiguous'?'多份台账归属待核实':'尚未登记台账'}</p>}
      {run.businessResult?.object && <p className="break-words">处理对象：{run.businessResult.object}</p>}
      <p>{describeRunCategory(run)}{run.mode ? ` · ${describeRunMode(run)}` : ''}</p>
    </Block>
    <Block title="本轮结果" help="以下为本机已登记或已收集的执行信息；任务交付与验收以所属任务为准。">
      <p className="font-medium text-slate-100">运行记录：{result.outcome}</p>
      {result.facts.map((fact) => <p key={fact} className="break-words">{fact}</p>)}
      {metrics && <><p className="text-xs text-slate-400">{metrics.sourceLabel}（本机已收集文件）</p>{metrics.totals.map((item) => <p key={item}>{item}</p>)}{conditions.length > 0 && <p className="pt-1 text-xs text-slate-400">条件分类</p>}{visibleConditions.map((item) => <p key={item}>{item}</p>)}{extraConditions.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-cyan-300">展开其余 {extraConditions.length} 项条件</summary><div className="mt-2 space-y-1.5 text-sm text-slate-300">{extraConditions.map((item) => <p key={item}>{item}</p>)}</div></details>}</>}
      {describeRunProgress(run).map((fact) => <p key={fact} className="break-words text-xs text-slate-400">{fact}</p>)}
      {describeRunScope(run).map((fact) => <p key={fact} className="break-words text-xs text-slate-400">{fact}</p>)}
      {run.collectedAt && <p className="text-xs text-slate-500">结果收集时间：{formatTime(run.collectedAt)}</p>}
      {run.source === 'remote-runner' && !run.evidenceFiles.length && <p className="text-xs text-amber-200">本机尚未收集执行结果文件。</p>}
      {onOpenFile && <p className="pt-2"><button type="button" onClick={onOpenFile} className="text-cyan-300 underline-offset-2 hover:underline focus-visible:underline">打开本地执行文件（{run.detailFilePath?.split(/[\\/]/).pop()}）→</button></p>}
    </Block>
    <Block title="执行信息">
      <p>开始：{run.startedAt ? formatTime(run.startedAt) : '未记录'}</p>
      {run.finishedAt && <p>结束：{formatTime(run.finishedAt)}</p>}
      {run.durationSeconds !== null && <p>用时：{duration}</p>}
      <p>位置：{run.executionLocation === 'local' ? '本机' : run.executionLocation === 'remote' ? '服务器' : '未记录'}</p>
      <p>{run.executionLocation === 'remote' ? '最近核查' : '状态更新时间'}：{run.observedAt ? formatTime(run.observedAt) : '未记录'}</p>
    </Block>
    <details className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300"><summary className="cursor-pointer font-medium text-slate-100">排查信息与本地文件</summary><div className="mt-3 space-y-2 break-words">
      {run.serverName && <p>服务器配置：{run.serverName}</p>}
      {run.target && <p>原始执行目标：{run.target}</p>}
      <p>原始运行状态：{run.status}</p>
      {run.businessResult?.status && <p>原始业务状态：{run.businessResult.status}</p>}
      {run.mode && <p>原始模式：{run.mode}</p>}
      {description.detail && <p>记录摘要：{description.detail}</p>}
      {run.exitCode !== null && <p>进程退出码：{run.exitCode}</p>}
      <p className="break-all">Run ID：{run.runId}</p>
      {run.taskId && <p className="break-all">任务 ID：{run.taskId}</p>}
      {run.taskContext&&<p className="break-all">任务目录：{run.taskContext.directory}</p>}
      <p className="text-xs text-slate-400">本地文件：{run.evidenceFiles.length ? run.evidenceFiles.join('、') : run.executionLocation === 'remote' ? '尚未收集到本机' : '无'}</p>
    </div></details>
  </>;
}
