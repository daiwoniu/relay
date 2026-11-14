import FailureNotice from '../ui/FailureNotice';
import { isWorkbenchItemOwner } from './workspace-console-view-model';
import { trackedOpenFeishuItems, isPersonalProjectComplete, taskEntryConflict, workbenchFlowEnded } from './workspace-console-view-model';
import { localTaskStatusLabel, taskEntryProgressAt, workbenchActionCompleted, type TaskDisplayEntry } from './workspace-console-view-model';
import { progressRecency, withDashboardProgress } from './workspace-task-progress';
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getWorkspaceConsoleDashboard, getWorkspaceConsoleResponsibility, getWorkspaceOperationRecords } from '../../api/workspace-console';
import { useAuth } from '../../auth/AuthContext';
import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto, WorkspaceConsoleRunDto, WorkspaceOperationRecordsDto } from '../../generated/relay-contracts';
import { useChatStore } from '../../stores/chat';
import { useChinaDayGreeting } from '../../hooks/useChinaDayGreeting';
import { useFilePreview } from '../messages/useFilePreview';
import { coalesceWorkspaceRequest, loadWorkspaceDashboard, readWorkspaceConsoleCache, rememberResponsibility } from './workspace-console-cache';
import { buildExecutionCards, buildTaskEntries, buildWorkspaceConsoleView, currentNodeResponsibilityLabel, distributeFocusEntries, feishuLinksForTask, feishuRelationshipLabel, feishuTypeName, feishuUrlForWorkItem, filterTaskEntries, filterTaskLanesByStatus, focusColumnCount, formatFocusCurrent, formatSessionActivity, groupTaskEntries, groupTaskEntriesByLane, isFinishedProjectIssue, latestTaskRecordAt, localLedgersForParent, newTaskEntryKeys, prioritizeTaskEntries, projectItemsForTask, projectTaskCardDetails, runsForTask, selectFocusEntries, selectGroupPrimaryEntry, selectTaskAction, sortDetailLocalTasks, sortDetailSubtasks, splitDetailLocalTasks, taskDisplayEntryFinishedAt, taskDisplayEntryIsNew, taskDisplayEntryUpdatedAt, taskEntryFilterStatuses, taskEntryLane, taskEntryStatusLabel, taskEntryUpdatedAt, workbenchChildNeedsAttention, workbenchParentStatusLabel, workbenchSubtaskNodeLabel, workbenchSubtaskStatusLabel, type ObservationCard, type TaskAssociationFilter, type TaskEntry, type TaskGroup, type TaskLane } from './workspace-console-view-model';
import WorkspaceTaskPanel from './WorkspaceTaskPanel';
import { stateFlowResponsibilityLabel } from './workspace-console-view-model';
import WorkspaceCodexResourceCard from './WorkspaceCodexResourceCard';
import { describeRun, describeRunCategory, describeRunListMetrics, describeRunMetrics, describeRunMode, describeRunResult, formatRunDuration } from './run-presentation';
import { useWorkspaceTaskLauncher } from './useWorkspaceTaskLauncher';
import { mergeWorkspaceSessionAssociations, resolveFeishuWorkItemPrimaryAction } from './workspace-task-launch';
import { loadWorkbenchDetailSnapshot, loadTaskDetailSnapshot, runForTaskDetail, type WorkbenchDetailSelection } from './workspace-task-detail';
import { taskStatusPresentation } from './task-status';
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
const formatTime = (value: string | number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN') : '未登记';
const formatSummaryTime = (value: string | number | null | undefined) => value
  ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  : '未登记';
const formatRefreshSeconds = (elapsedMs: number) => `${(Math.max(0, elapsedMs) / 1000).toFixed(1)} 秒`;
const statusText = (status: string | null) => taskStatusPresentation(status).label;
const responsibilityText = (value: ProjectItem['actionability']) => ({ current: '当前需我处理', state_responsibility: '负责流程流转', upcoming: '后续需我处理' })[value];
const responsibilityExplanation = (value: ProjectItem['actionability']) => ({ current: '当前流程节点有你的待处理责任。', state_responsibility: '你在工作项的状态流转中承担责任，不代表当前节点需要你操作。', upcoming: '后续流程节点有你的待处理责任。' })[value];
const subtaskUrl = (parent: WorkbenchItem, subtask: WorkbenchItem['mySubtasks'][number]): string | null => {
  if (!parent.url) return null;
  try {
    const url = new URL(parent.url);
    url.searchParams.set('activeStateId', subtask.nodeId);
    url.searchParams.set('subTaskId', subtask.id);
    return url.toString();
  } catch { return null; }
};
const taskLaneOrder: Array<{ key: TaskLane; title: string; note: string; titleTone: string; headerTone: string }> = [
  { key: 'doing', title: '处理中', note: '已开始未收口，含等待、阻塞及暂停', titleTone: 'text-cyan-200', headerTone: 'border-cyan-300/15 bg-cyan-300/[0.07]' },
  { key: 'unstarted', title: '待处理／待确认', note: '含本地未开启、待复核、等待及飞书后续或待核对项', titleTone: 'text-amber-200', headerTone: 'border-amber-300/15 bg-amber-300/[0.07]' },
  { key: 'completed', title: '已完成／已结束', note: '含本轮个人已完成、流程结束、关闭及取消', titleTone: 'text-emerald-200', headerTone: 'border-emerald-300/15 bg-emerald-300/[0.07]' },
];

const loadDashboard = (userId: string, force = false) => loadWorkspaceDashboard(userId, () => getWorkspaceConsoleDashboard(undefined, force), force);
const loadResponsibility = (userId: string, force = false,
  trigger: 'open' | 'auto' | 'retry' | 'manual' = 'open') => coalesceWorkspaceRequest(userId, 'responsibility', async () => {
  const value = await getWorkspaceConsoleResponsibility(undefined, force, trigger);
  if (!value.stale && !value.error) rememberResponsibility(userId, value, value.sourceMeta?.lastSuccessAt ?? value.fetchedAt);
  return value;
}, force);

const taskKeysStorageKey = (userId: string) => `relay:workspace-console:task-keys:v2:${userId}`;
const readTaskKeys = (userId: string): string[] | null => {
  try {
    const raw = window.sessionStorage.getItem(taskKeysStorageKey(userId));
    const keys: unknown = raw && JSON.parse(raw);
    return Array.isArray(keys) && keys.every((key) => typeof key === 'string') ? keys : null;
  } catch { return null; }
};

export default function WorkspaceConsolePage() {
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
  const openFilePreview = useFilePreview();
  const { continueSession, launchTask, executePrimary, launchFeishuWorkItem } = useWorkspaceTaskLauncher();
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
  const readDashboard = (force = false) => localRefresh.track(loadDashboard(userId, force));
  const readResponsibility = (force = false, trigger: 'open' | 'auto' | 'retry' | 'manual' = 'open') => projectRefresh.track(loadResponsibility(userId, force, trigger));
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
  const [search, setSearch] = useState('');
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
  const [selectedRun, setSelectedRun] = useState<{ runId: string; taskId: string | null; source?: 'observation' } | null>(null);
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
  const trackedItems = useMemo(() => trackedOpenFeishuItems(responsibility, model.tasks), [responsibility, model]);
  const observation = useMemo(() => buildExecutionCards(dashboard, observationSnapshots), [dashboard, observationSnapshots]);
  const snapshotReady = !localLoading && !projectLoading && !dashboardError && !projectError
    && dashboard?.sourceAvailable.registry === true && !!responsibility && responsibility.stale === false && !responsibility.error;
  const localRefreshFailed = !!dashboardError || dashboard?.sourceMeta?.state === 'failed_snapshot' || dashboard?.sourceAvailable.registry !== true;
  const projectRefreshFailed = !!projectError || !responsibility || responsibility.sourceMeta?.state === 'failed_snapshot' || !!responsibility.stale || !!responsibility.error;
  const hasLocalData = dashboard?.sourceAvailable.registry === true;
  const hasProjectData = !!responsibility;
  const displayingOldData = (hasLocalData && localRefreshFailed) || (hasProjectData && projectRefreshFailed);
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
  const focusEntries = useMemo(() => selectFocusEntries(groupTaskEntries(allEntries), now.getTime()), [allEntries, now]);
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
  const totalTaskCount = allEntries.length;
  const feishuTaskCount = allEntries.filter((entry) => entry.kind === 'parent' || entry.kind === 'subtask' || entry.kind === 'project').length;
  const compactTaskCounts = hasLocalData && hasProjectData
    && totalTaskCount === (dashboard?.counts.total ?? 0) + feishuTaskCount;
  useEffect(() => {
    if (!snapshotReady) return;
    const compared = lastComparedSources.current;
    if (compared?.userId === userId && compared.dashboard === dashboard && compared.responsibility === responsibility) return;
    lastComparedSources.current = { userId, dashboard, responsibility };
    const previous = taskKeyBaseline.current?.userId === userId ? taskKeyBaseline.current.keys : readTaskKeys(userId);
    const keys = allEntries.map((entry) => entry.key);
    setHighlightedTasks({ userId, keys: new Set(newTaskEntryKeys(previous, allEntries)) });
    taskKeyBaseline.current = { userId, keys };
    try { window.sessionStorage.setItem(taskKeysStorageKey(userId), JSON.stringify(keys)); } catch { /* Session storage may be disabled. */ }
  }, [allEntries, snapshotReady, dashboard, responsibility, userId]);
  const newTaskKeys = highlightedTasks.userId === userId ? highlightedTasks.keys : new Set<string>();
  const entries = useMemo(() => (associationFilter !== 'local' && associationFilter !== 'uncertain') || comparisonReady
    ? buildTaskEntries(model, associationFilter) : [], [model, associationFilter, comparisonReady]);
  const displayEntries = useMemo(() => groupTaskEntries(entries), [entries]);
  const visibleEntries = useMemo(() => prioritizeTaskEntries(filterTaskEntries(displayEntries, 'all', search), newTaskKeys), [displayEntries, search, newTaskKeys]);
  const laneStatusOptions = useMemo(() => {
    const lanes = groupTaskEntriesByLane(displayEntries);
    const optionsFor = (lane: TaskLane) => [...new Set(lanes[lane].flatMap(taskEntryFilterStatuses))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    return { unstarted: optionsFor('unstarted'), doing: optionsFor('doing'), completed: optionsFor('completed') };
  }, [displayEntries]);
  const taskLanes = useMemo(() => filterTaskLanesByStatus(groupTaskEntriesByLane(visibleEntries), laneStatusFilters), [visibleEntries, laneStatusFilters]);
  useEffect(() => {
    setCompletedVisibleCount(10);
    if (completedScrollRef.current) completedScrollRef.current.scrollTop = 0;
  }, [userId, search, associationFilter, laneStatusFilters.completed]);
  const visibleTaskCount = taskLanes.unstarted.length + taskLanes.doing.length + taskLanes.completed.length;
  const activeDetail = detailSelection && detailSnapshot?.selection.kind === detailSelection.kind && detailSnapshot.selection.id === detailSelection.id ? detailSnapshot : null;
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
  const projectLocalTasks = project ? sortDetailLocalTasks(taskDashboard?.tasks.filter((item) => project.localTaskIds.includes(item.id)
    || item.feishuWorkItemIds.includes(project.workItemId)) ?? []) : [];
  const workbenchParent = detailSelection?.kind === 'parent' || detailSelection?.kind === 'group' ? detailResponsibility?.workbenchItems.find((item) => item.workItemId === detailSelection.id) :
    detailSelection?.kind === 'subtask' ? detailResponsibility?.workbenchItems.find((item) => item.mySubtasks.some((child) => `${item.workItemId}:${child.id}` === detailSelection.id)) : null;
  const operationParentId = project?.workItemId ?? workbenchParent?.workItemId ?? null;
  const operationAnchor = project?.updatedAt ?? workbenchParent?.updatedAt ?? detailResponsibility?.generatedAt ?? null;
  const operationRefresh = useMemo(() => createWorkspaceRefreshTracker(), [userId, operationParentId, operationAnchor]);
  const operationSelectionKey = detailSelection ? `${detailSelection.kind}:${detailSelection.id}` : null;
  const activeOperations = operationParentId && operationAnchor && activities[operationParentId]?.anchor === operationAnchor
    ? activities[operationParentId].value : null;
  const activityForParent = (id: string, updatedAt: string | null | undefined) => {
    const cached = activities[id];
    return cached?.anchor === (updatedAt ?? responsibility?.generatedAt) && Date.now() - cached.fetchedAt < 10 * 60_000
      ? cached.value : null;
  };
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
    const cursor = activeOperations.cursor;
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
  const subtaskLocalTasks = workbenchSubtask ? sortDetailLocalTasks(taskDashboard?.tasks.filter((item) => item.feishuWorkItemIds.includes(workbenchSubtask.id)) ?? []) : [];
  const parentLocalTasks = workbenchParent ? localLedgersForParent(workbenchParent, taskDashboard?.tasks ?? []) : [];
  const childOperationTimes = new Map(workbenchParent?.mySubtasks.flatMap((child) => {
    const at = lastChildOperation(activeOperations, child.id);
    return at ? [[child.id, at] as const] : [];
  }) ?? []);
  const childTimeText = (id: string) => {
    const at = lastChildOperation(activeOperations, id);
    return at ? `飞书子任务近期操作 ${formatTime(at)}` : '飞书更新时间未提供';
  };
  const sortedParentChildren = workbenchParent ? sortDetailSubtasks(workbenchParent, taskDashboard?.tasks ?? [], childOperationTimes) : [];
  const parentChildrenNeedingAttention = sortedParentChildren.filter((child) => workbenchChildNeedsAttention(child,
    taskDashboard?.tasks.filter((local) => local.feishuWorkItemIds.includes(child.id)) ?? [])) ?? [];
  const finishedParentChildren = sortedParentChildren.filter((child) => !parentChildrenNeedingAttention.includes(child));
  const projectDetails = project ? projectTaskCardDetails(project) : null;
  const run = selectedRun ? runForTaskDetail(selectedRun, selectedRun.source === 'observation' ? observationSnapshots.runs ?? dashboard : dashboard,
    selectedRun.source === 'observation' ? null : detailSnapshot?.taskId ? { taskId: detailSnapshot.taskId, dashboard: detailSnapshot.dashboard } : null) : null;
  const runSource = selectedRun?.source === 'observation' ? observationSnapshots.runs ?? dashboard : detailSnapshot?.dashboard ?? dashboard;
  const runTask = run?.taskId ? runSource?.tasks.find((item) => item.id === run.taskId) ?? null : null;
  const projectForTask = task ? projectItemsForTask(task, detailResponsibility) : [];
  const taskFeishuLinks = task ? feishuLinksForTask(task, detailResponsibility) : [];
  const taskFeishuIds = task ? [...new Set([...task.feishuWorkItemIds, ...projectForTask.map((item) => item.workItemId)])] : [];
  const taskRuns = task && taskDashboard ? runsForTask(taskDashboard, task) : [];
  const taskSessions = task ? taskDashboard?.sessions.filter((item) => task.sessionIds.includes(item.sessionId)) ?? [] : [];
  const openDetail = (selection: WorkbenchDetailSelection) => { detailRefreshGeneration.current += 1; setDetailSelection(selection); setDetailSnapshot(null); setRefreshingDetail(false); setDetailRefreshError(null); };
  const closeDetail = (keepSnapshot = false) => { detailRefreshGeneration.current += 1; setDetailSelection(null); setRefreshingDetail(false); setDetailRefreshError(null); if (!keepSnapshot) setDetailSnapshot(null); };
  const openTask = (taskId: string, source?: WorkspaceConsoleDashboardDto) => {
    const selection: WorkbenchDetailSelection = { kind: 'local', id: taskId };
    openDetail(selection);
    if (source) setDetailSnapshot({ selection, taskId, dashboard: source, responsibility });
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
      const snapshot = await loadWorkbenchDetailSnapshot(selection, () => getWorkspaceConsoleDashboard(undefined, selection.kind === 'local'),
        (force) => getWorkspaceConsoleResponsibility(undefined, force, 'detail'), detailResponsibility);
      if (detailRefreshGeneration.current === generation) setDetailSnapshot(snapshot);
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
  const startTask = (item: Task, source = dashboard) => { if (source) setActionError(executePrimary(item, source)); };
  const startProjectItem = (item: ProjectItem, source = dashboard) => {
    const { current, next } = projectTaskCardDetails(item);
    setActionError(launchFeishuWorkItem({ workItemId: item.workItemId, title: item.title, url: feishuUrlForWorkItem(item), current, next }, source,isPersonalProjectComplete(item)));
  };
  const startWorkbenchEntry = (entry: WorkbenchEntry, source = dashboard, followFlow = false) => {
    const parent = entry.kind === 'parent' ? entry.item : entry.parent;
    const child = entry.kind === 'subtask' ? entry.subtask : null;
    const ended = workbenchActionCompleted(entry, followFlow);
    setActionError(launchFeishuWorkItem({ workItemId: child?.id ?? parent.workItemId,
      title: child ? `${child.title}｜父项 ${parent.title}` : parent.title,
      url: child ? subtaskUrl(parent, child) : parent.url,
      current: child ? `子任务 ${workbenchSubtaskStatusLabel(child)}；父项 ${parent.workItemId}` : `父项 ${taskEntryStatusLabel(entry)}`,
      next: ended ? `回顾飞书${child ? '子任务' : '父工作项'} ${child?.id ?? parent.workItemId}`
        : child ? `核对飞书子任务 ${child.id}` : `跟踪父工作项 ${parent.workItemId} 的状态` }, source,ended));
  };
  const actionLabel = (item: Task, source = dashboard) => ({ start: '开始处理', continue: '继续处理', history: '重新处理' })[selectTaskAction(item, source?.sessions ?? [])];
  const feishuActionLabel = (id: string, completed = false, source = dashboard) => ({start:'开始处理',continue:'继续处理',restart:'重新处理'})[resolveFeishuWorkItemPrimaryAction(id,source,completed).kind];
  const entryActionLabel = (entry: TaskEntry) => entry.kind==='local' ? actionLabel(entry.task)
    : feishuActionLabel(entry.kind==='subtask'?entry.subtask.id:entry.item.workItemId,taskEntryLane(entry)==='completed');
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
            <button type="button" onClick={rotateGreeting} title="换一句" className="relative z-10 mt-2 block max-w-[520px] text-left text-sm text-slate-400 hover:text-slate-200">{greeting}</button>
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
                {compactTaskCounts ? <p className="workspace-workbench__header-counts" title="本地台账、本人父项和本人子任务各自计数；同一事项可能有多条记录">
                  <span className="font-medium text-slate-300">任务记录 {totalTaskCount} 条</span>
                  <span className="text-slate-500">台账 {dashboard?.counts.total}{localRefreshFailed ? '（旧数据）' : ''}</span>
                  <span className="text-slate-500">飞书 {feishuTaskCount}{projectRefreshFailed ? '（旧数据）' : ''}</span>
                </p> : <div className="workspace-workbench__header-counts">
                  <span title="本地台账、本人父项和本人子任务各自计数">任务记录：{taskCountDisplay(hasLocalData || hasProjectData, totalTaskCount, localLoading || projectLoading, displayingOldData)}</span>
                  <span>本地台账：{taskCountDisplay(hasLocalData, dashboard?.counts.total ?? 0, localLoading, hasLocalData && localRefreshFailed)}</span>
                  <span>飞书任务：{taskCountDisplay(hasProjectData, feishuTaskCount, projectLoading, hasProjectData && projectRefreshFailed)}</span>
                </div>}
                {(dashboard?.registryGeneratedAt || responsibility?.generatedAt) && <div className="workspace-workbench__header-times text-slate-500">
                  <span>数据时间</span>
                  <div>
                    {dashboard?.registryGeneratedAt && <span>台账 {formatSummaryTime(dashboard.registryGeneratedAt)}</span>}
                    {responsibility?.generatedAt && <span>飞书 {formatSummaryTime(responsibility.generatedAt)}</span>}
                  </div>
                </div>}
              </div>
          </div>
          {refreshTiming && (localLoading || projectLoading || ((!refreshTiming.localRequested || !localRefreshFailed) && (!refreshTiming.projectRequested || !projectRefreshFailed))) && <div className={`workspace-workbench__refresh-banner mt-2 flex w-fit max-w-full items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${refreshBannerTone}`}>
            <p role="status" className="min-w-0 break-words">{refreshTiming.localRequested && <>本地台账：{localLoading ? '同步中' : localRefreshFailed ? '失败' : localRefreshPartial ? '部分失败' : '已更新'} · {localLoading ? '已耗时' : '耗时'} {formatRefreshSeconds(refreshTiming.localMs ?? refreshTiming.observedAt - refreshTiming.startedAt)} · </>}任务报表：{refreshTiming.projectRequested
              ? <>{projectLoading && refreshTiming.projectMs === null ? '同步中' : projectRefreshFailed ? '失败' : '已更新'} · {projectLoading && refreshTiming.projectMs === null ? '已耗时' : '耗时'} {formatRefreshSeconds(refreshTiming.projectMs ?? refreshTiming.observedAt - refreshTiming.startedAt)}</>
              : '未刷新'}</p>
            <button type="button" onClick={() => setRefreshTiming(null)} aria-label="关闭刷新提示" title="关闭刷新提示" className="shrink-0 rounded px-0.5 text-base leading-4 text-slate-400 hover:bg-white/10 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">×</button>
          </div>}
        </div>
      </header>

      {(dashboardError || dashboard?.sourceMeta?.state === 'failed_snapshot') && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-950/30 p-3 text-sm">{dashboard?.sourceMeta?.lastSuccessAt ? `台账更新失败，显示 ${formatSummaryTime(dashboard.sourceMeta.lastSuccessAt)} 的上次成功数据。` : dashboard ? `台账更新失败，显示上次成功数据。` : '本地台账暂不可用。'} <FailureNotice error={dashboardError || (dashboard?.sourceMeta?.state === 'failed_snapshot' ? dashboard.sourceMeta.error : undefined)} /> <button type="button" onClick={() => refreshSource('local')} className="underline underline-offset-2">重试</button></p>}
      {dashboard?.sourceMeta?.state !== 'failed_snapshot' && dashboard?.errors.map((error) => <p key={error} role="status" className="rounded-xl border border-amber-400/25 bg-amber-950/25 p-3 text-sm"><FailureNotice error={error} /></p>)}
      {!projectNoticeDismissed && (projectError || responsibility?.sourceMeta?.state === 'failed_snapshot' || responsibility?.stale) && <div className="mt-2 flex w-fit max-w-full items-start gap-1.5 rounded-lg border border-amber-400/25 bg-amber-950/25 px-2.5 py-1.5 text-sm">
        <p role="status" className="min-w-0 break-words">{snapshotNotice('飞书', responsibility?.sourceMeta) ?? (responsibility ? `任务报表本次未完成更新，显示 ${formatSummaryTime(responsibility.fetchedAt)} 的上次成功数据。` : '任务报表暂不可用。')} {(projectError || responsibility?.sourceMeta?.state === 'failed_snapshot') && <FailureNotice error={projectError || (responsibility?.sourceMeta?.state === 'failed_snapshot' ? responsibility.sourceMeta.error : undefined)} />} <button type="button" onClick={() => refreshSource('project')} className="underline underline-offset-2">重试</button></p>
        <button type="button" onClick={() => setProjectNoticeDismissed(true)} aria-label="关闭任务报表提示" title="关闭任务报表提示" className="shrink-0 rounded px-0.5 text-base leading-4 text-slate-400 hover:bg-white/10 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">×</button>
      </div>}
      <div className="min-w-0 space-y-4">
        {!desktopLayout && <WorkspaceCodexResourceCard key={userId} userId={userId} />}
        <section aria-labelledby="focus-heading" className="workspace-workbench__focus-container min-w-0 rounded-2xl border border-white/10 bg-[#111927] p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2"><h2 id="focus-heading" className="flex flex-wrap items-baseline text-base font-semibold">当前焦点 <span className="ml-2 text-xs font-normal text-slate-400">{focusEntries.length} 个事项</span><span className="mt-1 w-full text-xs font-normal text-slate-500 lg:ml-3 lg:mt-0 lg:w-auto">同一飞书父项归为一个事项，优先显示处理中任务</span></h2><a href="#task-search" className="text-xs text-cyan-300 hover:underline">查看全部任务 ↓</a></div>
          <div ref={focusScrollRef} aria-label="当前焦点任务" tabIndex={0} className="workspace-workbench__focus-scroll min-w-0">
          <div className="workspace-workbench__focus-columns min-w-0">
            {focusEntries.length > 0 && focusColumns.map((column, index) => <div key={index} className="workspace-workbench__focus-column">{column.map((entry) => <div key={entry.key} data-focus-key={entry.key} className="workspace-workbench__focus-item">{entry.kind === 'group'
              ? <TaskGroupCard key={entry.key} group={entry} activity={activityForParent(entry.parent.workItemId, entry.parent.updatedAt)} reportGeneratedAt={responsibility?.generatedAt ?? null} isNew={taskDisplayEntryIsNew(entry, newTaskKeys)} newKeys={newTaskKeys} onOpen={() => openTaskGroup(entry)} onOpenChild={openWorkbenchEntry} onOpenTask={openTask} onOpenProject={openProject} onStartTask={startTask} onStartChild={startWorkbenchEntry} onStartProject={startProjectItem} actionLabel={actionLabel} entryActionLabel={entryActionLabel} onOpenDocument={(filePath) => void openFilePreview(filePath)} prominent />
              : entry.kind === 'local'
                ? <FocusTaskCard key={entry.key} task={entry.task} responsibility={responsibility} isNew={taskDisplayEntryIsNew(entry, newTaskKeys)} onOpen={() => openTask(entry.task.id)} onStart={() => startTask(entry.task)} actionLabel={actionLabel(entry.task)} onOpenDocument={(filePath) => void openFilePreview(filePath)} />
                : <ProjectTaskCard key={entry.key} item={entry.item} actionLabel={entryActionLabel(entry)} reportGeneratedAt={responsibility?.generatedAt ?? null} isNew={taskDisplayEntryIsNew(entry, newTaskKeys)} onOpen={() => openProject(entry.item.workItemId)} onStart={() => startProjectItem(entry.item)} />}</div>)}</div>)}
            {!localLoading && !projectLoading && focusEntries.length === 0 && <p className="py-6 text-sm text-slate-400">当前没有未完成事项。</p>}
            {localLoading && !dashboard && <p className="py-6 text-sm text-slate-400">正在读取任务台账…</p>}
          </div>
          </div>
        </section>

      </div>

        <section id="task-search" aria-labelledby="all-heading" className="workspace-workbench__task-list min-w-0 scroll-mt-3 rounded-2xl border border-white/10 bg-[#111927]">
          <div className="shrink-0 space-y-3 border-b border-white/10 p-4">
            <h2 id="all-heading" className="font-semibold">任务列表 <span className="ml-1 text-xs font-normal text-slate-400">{visibleTaskCount} / {displayEntries.length} 组或独立项</span></h2>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row"><select aria-label="任务关联筛选" value={associationFilter} onChange={(event) => { setAssociationFilter(event.target.value as TaskAssociationFilter); setLaneStatusFilters({ unstarted: '', doing: '', completed: '' }); }} className="w-full shrink-0 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs text-slate-100 sm:w-52"><option value="all">全部</option><option value="feishu">飞书任务及关联台账</option><option value="local">未关联飞书的台账</option><option value="uncertain">关联待确认的台账</option></select><input aria-label="搜索任务" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或 ID" enterKeyHint="search" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs text-slate-100" /></div>
            <div className="flex gap-1.5 lg:hidden" aria-label="任务状态列表">{taskLaneOrder.map(({ key, title }) => <button key={key} type="button" onClick={() => setMobileTaskLane(key)} aria-pressed={mobileTaskLane === key} className={`min-w-0 flex-1 rounded-md border px-2 py-1.5 text-xs font-medium ${mobileTaskLane === key ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-200' : 'border-white/10 text-slate-400'}`}>{key === 'unstarted' ? '待处理' : title} <span className="tabular-nums">{taskLanes[key].length}</span></button>)}</div>
          </div>
           <div className="workspace-workbench__task-lanes grid min-w-0 gap-3 p-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1.15fr)_minmax(260px,0.75fr)]">
            {(associationFilter === 'local' || associationFilter === 'uncertain') && !comparisonReady && <p role="status" className="col-span-full rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100">需本地台账与飞书工作项均成功读取，才能判断台账关联状态。</p>}
            {associationFilter === 'all' && !localLoading && !projectLoading && entries.length === 0 && !dashboard?.sourceAvailable.registry && !responsibility && <p className="col-span-full p-3 text-sm text-slate-400">任务来源暂不可用。</p>}
             {taskLaneOrder.map(({ key, title, note, titleTone, headerTone }) => <section key={key} id={`task-lane-${key}`} aria-label={`${title}任务`} data-mobile-active={mobileTaskLane === key} className="workspace-workbench__task-lane min-w-0 rounded-xl border border-white/10 bg-slate-950/40 p-2.5 scroll-mt-4">
              <div className={`mb-3 min-w-0 rounded-lg border px-2.5 py-2 ${headerTone} ${key === 'doing' ? 'workspace-workbench__lane-doing' : ''}`}><div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><h3 className={`text-sm font-semibold ${titleTone}`}>{title} <span className="ml-1 font-normal tabular-nums text-slate-400">{taskLanes[key].length}</span></h3><select aria-label={`${title}状态筛选`} value={laneStatusFilters[key]} onChange={(event) => setLaneStatusFilters((current) => ({ ...current, [key]: event.target.value }))} className="max-w-full rounded-md border border-white/15 bg-slate-950 px-2 py-1 text-xs text-slate-100"><option value="">全部状态</option>{laneStatusOptions[key].map((status) => <option key={status} value={status}>{status}</option>)}</select></div><p className="mt-0.5 text-[11px] text-slate-400">{note}</p></div>
               <div ref={key === 'completed' ? completedScrollRef : undefined} aria-label={`${title}任务卡片`} tabIndex={0} className="workspace-workbench__task-lane-scroll min-w-0 space-y-2">
                 {(key === 'completed' ? taskLanes[key].slice(0, completedVisibleCount) : taskLanes[key]).map((entry, index) => <Fragment key={entry.key}>
                  {key === 'completed' && index % 10 === 0 && <p className="border-b border-white/10 py-2 text-center text-[11px] text-slate-400">第 {index / 10 + 1} 页 · 第 {index + 1}–{Math.min(index + 10, taskLanes.completed.length)} 项</p>}
                  {entry.kind === 'group'
                    ? <TaskGroupCard key={entry.key} group={entry} activity={activityForParent(entry.parent.workItemId, entry.parent.updatedAt)} reportGeneratedAt={responsibility?.generatedAt ?? null} isNew={taskDisplayEntryIsNew(entry, newTaskKeys)} newKeys={newTaskKeys} onOpen={() => openTaskGroup(entry)} onOpenChild={openWorkbenchEntry} onOpenTask={openTask} onOpenProject={openProject} onStartTask={startTask} onStartChild={startWorkbenchEntry} onStartProject={startProjectItem} actionLabel={actionLabel} entryActionLabel={entryActionLabel} onOpenDocument={(filePath) => void openFilePreview(filePath)} />
                  : entry.kind === 'local'
                     ? <LocalTaskCard key={entry.key} task={entry.task} responsibility={responsibility} compact isNew={taskDisplayEntryIsNew(entry, newTaskKeys)} onOpen={() => openTask(entry.task.id)} onStart={() => startTask(entry.task)} actionLabel={actionLabel(entry.task)} onOpenDocument={(filePath) => void openFilePreview(filePath)} />
                  : <ProjectTaskCard key={entry.key} item={entry.item} actionLabel={entryActionLabel(entry)} reportGeneratedAt={responsibility?.generatedAt ?? null} isNew={taskDisplayEntryIsNew(entry, newTaskKeys)} onOpen={() => openProject(entry.item.workItemId)} onStart={() => startProjectItem(entry.item)} />}</Fragment>)}
                {!localLoading && !projectLoading && taskLanes[key].length === 0 && (associationFilter === 'all' || comparisonReady) && <p className="p-3 text-xs text-slate-500">{search || laneStatusFilters[key] ? '没有匹配任务' : '暂无任务'}</p>}
                {key === 'completed' && taskLanes.completed.length > 0 && <div className="space-y-2 py-2 text-center">
                  <p role="status" className="text-[11px] text-slate-500">{completedVisibleCount < taskLanes.completed.length ? `已显示 ${completedVisibleCount} / ${taskLanes.completed.length} 项` : `已显示全部 ${taskLanes.completed.length} 项`}</p>
                  {completedVisibleCount < taskLanes.completed.length && <button type="button" onClick={() => setCompletedVisibleCount((count) => Math.min(taskLanes.completed.length, count + 10))} className="min-h-10 w-full rounded-lg border border-white/15 px-3 py-2 text-xs text-cyan-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">加载下一页</button>}
                </div>}
              </div>
            </section>)}
            {(localLoading || projectLoading) && entries.length === 0 && <p className="p-3 text-sm text-slate-400">正在读取任务…</p>}
          </div>
        </section>
        <details aria-label="我参与的流转中事项" className="min-w-0 rounded-2xl border border-white/10 bg-[#111927] p-4 sm:p-5">
          <summary className="flex cursor-pointer list-none flex-col items-start gap-1 text-sm font-semibold sm:flex-row sm:items-center sm:justify-between sm:gap-2">
            <span className="min-w-0 break-words">我参与的流转中事项 <span className="ml-1 font-normal text-slate-400">{trackedItems.length} 项</span></span>
            <span className="min-w-0 break-words text-xs font-normal text-slate-500">{responsibility?.generatedAt ? `飞书 ${formatSummaryTime(responsibility.generatedAt)}` : '飞书数据未读取'}{responsibility?.stale && ' · 旧数据'} <span aria-hidden="true">⌄</span></span>
          </summary>
          <p className="mt-3 text-xs text-slate-500">个人已完成或后续负责、整体仍流转的事项，仅跟踪，不重复计数。</p>
          <div className="mt-3 space-y-2">
            {trackedItems.map((entry) => <div key={`${entry.kind}:${entry.item.workItemId}`} className="min-w-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-stretch gap-x-3">
                <div className="min-w-0">
                  <button type="button" onClick={() => openDetail({kind:entry.kind === 'parent' ? 'group' : 'project',id:entry.item.workItemId})} className="min-w-0 break-all text-left font-medium leading-5 text-slate-100 hover:text-cyan-300">{entry.item.typeName || '飞书事项'} · {entry.item.title}</button>
                  <div className="mt-1.5 space-y-1 text-slate-400">
                    <p className="min-w-0 break-words">{entry.kind === 'parent' ? currentNodeResponsibilityLabel(entry.item) : stateFlowResponsibilityLabel(entry.item)}</p>
                    {entry.kind === 'parent' && entry.item.myNodes?.some((node) => node.phase === 'upcoming') && <p className="text-slate-500">后续参与：{entry.item.myNodes.filter((node) => node.phase === 'upcoming').map((node) => node.name).filter(Boolean).join('、')}（未激活）</p>}
                    <p className="text-slate-500">更新 {formatTime(entry.item.updatedAt)}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5 whitespace-nowrap py-0.5">
                  {entry.item.url && <a href={entry.item.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline" aria-label={`在飞书打开${entry.item.title}（${entry.item.workItemId}）`}>{entry.item.workItemId} ↗</a>}
                  <button type="button" onClick={() => entry.kind === 'parent'
                    ? startWorkbenchEntry({kind:'parent',key:`parent:${entry.item.workItemId}`,item:entry.item}, dashboard, true)
                    : startProjectItem(entry.item)} aria-label={`处理${entry.item.title}`} title="打开会话，带入任务标题和飞书链接，核查最新情况" className="mt-auto rounded-md border border-cyan-300/35 px-2 py-1 font-medium text-cyan-200 hover:bg-cyan-300/10">处理 →</button>
                </div>
              </div>
            </div>)}
            {trackedItems.length === 0 && <p className="text-xs text-slate-500">{projectLoading ? '正在读取…' : responsibility ? '暂无符合条件的流转事项。' : '飞书数据暂不可用。'}</p>}
          </div>
        </details>
        <details aria-label="执行记录与会话" className="workspace-workbench__observation min-w-0 rounded-2xl border border-white/10 bg-[#111927] p-4 sm:p-5">
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">执行记录与会话 <span className="ml-1 text-xs font-normal text-slate-500">展开追溯执行与查找会话</span></span><span className="text-xs text-slate-400">执行 {observation.runs.items.length} · 会话 {observation.sessions.items.length} <span aria-hidden="true">⌄</span></span></summary>
          <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
            <ObservationSection title="最近执行记录" count={observation.runs.items.length} tone="text-violet-200" empty={observation.runs.available ? '暂无记录' : '来源不可用'} onRefresh={() => void refreshObservation('runs')} refreshing={observationLoading.runs === true} error={observationErrors.runs}>
              {observation.runs.items.map((item) => <RunRow key={`${item.taskId}:${item.runId}`} run={item} taskTitle={observation.runs.tasks.find((task) => task.id === item.taskId)?.title || (item.taskId ? item.taskId : '未匹配任务')} onOpen={() => setSelectedRun({ runId: item.runId, taskId: item.taskId, source: 'observation' })} />)}
            </ObservationSection>
            <ObservationSection title="最近会话" count={observation.sessions.items.length} tone="text-cyan-200" empty={observation.sessions.available ? '暂无记录' : '来源不可用'} onRefresh={() => void refreshObservation('sessions')} refreshing={observationLoading.sessions === true} error={observationErrors.sessions}>
              {observation.sessions.items.map((item) => <a key={item.sessionId} href={item.url} className="block min-w-0 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 hover:border-cyan-300/40"><span className="block break-words text-xs font-medium text-slate-100">{item.title || item.sessionId}</span><span className="mt-1 block text-[11px] text-slate-400" title={item.updatedAt ? formatTime(item.updatedAt) : undefined}>{formatSessionActivity(item.updatedAt, Date.now())}{observation.sessions.unlinkedSessionIds.has(item.sessionId) && ' · 未关联任务'}</span></a>)}
            </ObservationSection>
          </div>
        </details>
    </div>

    {actionError && <div role="alert" className="fixed bottom-4 left-4 right-4 z-[60] mx-auto flex max-w-xl items-start justify-between gap-3 rounded-xl border border-rose-300/30 bg-slate-900 p-3 text-sm text-rose-200 shadow-xl"><span><FailureNotice error={actionError} /></span><button type="button" onClick={() => setActionError(null)} className="shrink-0 text-xs underline">关闭</button></div>}
    {task && taskDashboard && detailSelection && <Drawer title={task.title || task.id} subtitle={`任务 ID：${task.id}`} onClose={() => closeDetail()} onRefresh={() => void reloadSelectedDetail(detailSelection).catch(() => undefined)} refreshing={refreshingDetail}>
      {detailRefreshError && <p role="alert" className="text-xs text-rose-300">刷新任务失败：<FailureNotice error={detailRefreshError} /></p>}
      <Block title="当前状态"><p>{localTaskStatusLabel(task)} · 最近记录 {formatTime(latestTaskRecordAt(task))}</p><TaskProgressNotice entry={{kind:'local',key:task.id,task}} />{(task.waitingOn || task.nextAction) && <p className="break-words">{task.waitingOn ? '等待事项：' : '下一步：'}{task.waitingOn || task.nextAction}</p>}{task.taskDocumentPath && <button type="button" onClick={() => { closeDetail(); void openFilePreview(task.taskDocumentPath!); }} className="text-left text-cyan-300 hover:underline">预览本地台账</button>}</Block>
      {taskFeishuIds.length > 0 && <Block title={`关联飞书任务 · ${taskFeishuIds.length}`}>{taskFeishuLinks.map((item) => <p key={item.workItemId} className="break-words"><a href={item.url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">{item.title} · {item.workItemId}</a></p>)}{taskFeishuIds.filter((id) => !taskFeishuLinks.some((link) => link.workItemId === id)).map((id) => <p key={id} className="break-words">{projectForTask.find((item) => item.workItemId === id)?.title ?? '工作项'} · {id}（链接未核验）</p>)}</Block>}
      <WorkspaceTaskPanel task={task} dashboard={taskDashboard} userId={userId} onLaunch={launchTask} onContinue={continueSession} onChanged={() => reloadChangedTask(detailSelection, task.id, detailResponsibility)} />
      <details className="rounded-xl border border-white/10 bg-white/5 p-3"><summary className="cursor-pointer text-sm font-medium">完整本地台账摘要</summary><div className="mt-3 space-y-2 text-sm text-slate-300"><p className="break-words">任务说明：{task.description || '未登记'}</p><p className="break-words">当前情况：{task.statusBasis || '未登记'}</p>{task.waitingOn && <p className="break-words">等待事项：{task.waitingOn}</p>}<p className="break-words">下一步：{task.nextAction || '未登记'}</p><p>最后核验：{formatTime(task.lastVerifiedAt)}</p>{task.completedAt && <p>完成时间：{formatTime(task.completedAt)}</p>}<p className="break-all">任务路径：{task.taskPath || '未登记'}</p>{task.taskDocumentPath && <p className="break-all">本地任务说明：{task.taskDocumentPath}</p>}</div></details>
      <Block title={`执行记录 · ${taskRuns.length}`}>
      <p className="text-xs text-slate-400">区分业务跑数与代码检查；Run 状态不代表任务验收结论。</p>
        {taskRuns.slice(0, 2).map((item) => <RunRow key={`${item.taskId}:${item.runId}`} run={item} onOpen={() => { closeDetail(true); setSelectedRun({ runId: item.runId, taskId: item.taskId }); }} />)}
        {taskRuns.length > 2 && <details className="group"><summary className="cursor-pointer text-xs text-cyan-300">查看其余 {taskRuns.length - 2} 条记录</summary><div className="mt-2 space-y-2">{taskRuns.slice(2).map((item) => <RunRow key={`${item.taskId}:${item.runId}`} run={item} onOpen={() => { closeDetail(true); setSelectedRun({ runId: item.runId, taskId: item.taskId }); }} />)}</div></details>}
      </Block>
      <Block title={`Relay 会话 · ${taskSessions.length}`}>{taskSessions.map((item) => <a key={item.sessionId} href={item.url} className="block break-words text-cyan-300 hover:underline">{item.title || item.sessionId}</a>)}</Block>
    </Drawer>}
    {project && projectDetails && detailSelection && <Drawer title={project.title} subtitle={`工作项 ID：${project.workItemId}`} onClose={() => closeDetail()} onRefresh={() => void reloadSelectedDetail(detailSelection).catch(() => undefined)} refreshing={refreshingDetail}>
      {detailRefreshError && <p role="alert" className="text-xs text-rose-300">刷新工作项失败：<FailureNotice error={detailRefreshError} /></p>}
       {!isPersonalProjectComplete(project) && <Block title="任务处理"><p className="text-xs text-slate-400">在固定工作区处理此飞书工作项；开始时带入飞书链接，先核对实际状态。</p><button type="button" onClick={() => startProjectItem(project, taskDashboard)} className="rounded-lg border border-cyan-300/35 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-300/10">{feishuActionLabel(project.workItemId,false,taskDashboard)} →</button></Block>}
       <Block title="飞书工作项"><p>与你的关系：{responsibilityText(project.actionability)} · {project.typeName || '工作项'}</p><p className="text-slate-400">{responsibilityExplanation(project.actionability)}</p><p className="break-words">工作项 ID：{feishuUrlForWorkItem(project) ? <a href={feishuUrlForWorkItem(project)!} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">{project.workItemId}</a> : `${project.workItemId}（链接未核验）`}</p><p className="break-words">当前情况：{projectDetails.current}</p><p className="break-words">下一步：{projectDetails.next}</p><p>版本：{project.version || '未登记'}</p>{project.updatedAt && <p>飞书最近更新：{formatTime(project.updatedAt)}</p>}<p title="飞书责任报表生成时间">最近同步：{formatTime(detailResponsibility?.generatedAt)}</p>{project.personalSubtasks.map((subtask) => <p key={subtask.id} className="break-words">子任务：{subtask.name} · {subtask.passed ? '已完成' : '未完成'} <span className="text-xs text-slate-500">· {childTimeText(subtask.id)}</span></p>)}</Block>
      {project.statusName && <Block title="飞书状态"><p>{project.statusName}</p></Block>}
      {!!project.linkedStoryIds?.length && <Block title="关联需求">{project.linkedStoryIds.map((id) => {
        const story = detailResponsibility?.workbenchItems.find((item) => item.workItemId === id)
          ?? detailResponsibility?.items.find((item) => item.workItemId === id);
        return <p key={id} className="break-words">{story?.url ? <a href={story.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">{story.title} · {id}</a> : `${story?.title ?? '需求'} · ${id}（链接未核验）`}</p>;
      })}</Block>}
      <Block title={`本地台账 · ${projectLocalTasks.length}`}>{projectLocalTasks.length
        ? <DetailLocalLedgerList tasks={projectLocalTasks} renderRow={(local) => <GroupedLocalRow key={local.id} task={local} onOpen={() => openTask(local.id, taskDashboard ?? undefined)} onStart={() => startTask(local, taskDashboard)} actionLabel={actionLabel(local, taskDashboard)} onOpenDocument={(filePath) => { closeDetail(); void openFilePreview(filePath); }} />} />
        : <p className="text-xs text-slate-400">{project.localTaskIds.length ? '飞书报表记录了本地任务 ID，但当前台账未匹配。' : '当前未关联本地台账任务。'}</p>}</Block>
      <OperationHistory activity={activeOperations} loading={activityLoading} error={activityError} onMore={() => void loadMoreOperations()} onRefresh={() => void refreshOperations()} childTitles={Object.fromEntries(project.personalSubtasks.map((child) => [child.id, child.name]))} />
      <p className="text-xs text-slate-500">此处仅展示当前账号相关工作项，并非完整飞书待办。</p>
    </Drawer>}
    {workbenchParent && detailSelection && <Drawer title={workbenchSubtask?.title ?? workbenchParent.title} subtitle={workbenchSubtask ? `子任务 ID：${workbenchSubtask.id}` : `父工作项 ID：${workbenchParent.workItemId}`} onClose={() => closeDetail()} onRefresh={() => void reloadSelectedDetail(detailSelection).catch(() => undefined)} refreshing={refreshingDetail}>
      {detailRefreshError && <p role="alert" className="text-xs text-rose-300">刷新飞书任务失败：<FailureNotice error={detailRefreshError} /></p>}
      {workbenchSubtask && <Block title="本人子任务"><p>状态：{workbenchSubtaskStatusLabel(workbenchSubtask)}</p><p>{workbenchSubtaskNodeLabel(workbenchSubtask)}</p><p className="break-words">{subtaskUrl(workbenchParent, workbenchSubtask) ? <a href={subtaskUrl(workbenchParent, workbenchSubtask)!} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">{workbenchSubtask.title} · {workbenchSubtask.id}</a> : `${workbenchSubtask.title} · ${workbenchSubtask.id}（链接未核验）`}</p><p className="text-xs text-slate-500">{childTimeText(workbenchSubtask.id)}{workbenchSubtask.finishedAt ? ` · 完成 ${formatTime(workbenchSubtask.finishedAt)}` : ''}</p></Block>}
      <Block title="飞书父项"><p className="break-words">{workbenchParent.url ? <a href={workbenchParent.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">{workbenchParent.title} · {workbenchParent.workItemId}</a> : `${workbenchParent.title} · ${workbenchParent.workItemId}（链接未核验）`}</p><p>负责人：{isWorkbenchItemOwner(workbenchParent, detailResponsibility?.sourceUserKey) ? '本人' : workbenchParent.ownerUserKey ? '他人' : '待核对'} · {workbenchParentStatusLabel(workbenchParent)}</p>{workbenchParent.currentNodeNames.length > 0 && <p>当前节点：{workbenchParent.currentNodeNames.join('、')}</p>}<p>父项最近更新：{formatTime(workbenchParent.updatedAt)}</p><p title="飞书责任报表生成时间">报表同步：{formatTime(detailResponsibility?.generatedAt)}</p>{isWorkbenchItemOwner(workbenchParent, detailResponsibility?.sourceUserKey) && workbenchParent.mySubtasks.length === 0 && parentLocalTasks.length === 0 && taskEntryLane({ kind: 'parent', key: `parent:${workbenchParent.workItemId}`, item: workbenchParent }) !== 'completed' && <button type="button" onClick={() => startWorkbenchEntry({ kind: 'parent', key: `parent:${workbenchParent.workItemId}`, item: workbenchParent },taskDashboard)} className="text-cyan-300 hover:underline">{feishuActionLabel(workbenchParent.workItemId,false,taskDashboard)} →</button>}</Block>
      {(detailSelection.kind === 'group' || detailSelection.kind === 'parent') && <Block title={`我的飞书子任务 · ${workbenchParent.mySubtasks.length}`}>
        {workbenchParent.mySubtasks.length === 0 && <p className="text-slate-400">当前没有分配给我的子任务</p>}
        {parentChildrenNeedingAttention.map((child) => {
          const linked = sortDetailLocalTasks(taskDashboard?.tasks.filter((local) => local.feishuWorkItemIds.includes(child.id)) ?? []);
          const url = subtaskUrl(workbenchParent, child);
          return <div key={child.id} className="rounded-lg border border-white/10 p-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2"><p className="break-words font-medium">{url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">{child.title} · {child.id}</a> : `${child.title} · ${child.id}`}{newTaskKeys.has(`subtask:${workbenchParent.workItemId}:${child.id}`) && !child.passed && <NewBadge className="ml-2" />}</p><span className="rounded bg-cyan-300/10 px-1.5 py-0.5 text-[11px] text-cyan-200">{workbenchSubtaskStatusLabel(child)}</span></div>
            <p>{workbenchSubtaskNodeLabel(child)}</p>
            <p className="text-[11px] text-slate-500">{childTimeText(child.id)}{child.finishedAt ? ` · 完成 ${formatTime(child.finishedAt)}` : ''}</p>
            <div className="mt-2 border-t border-white/10 pt-2">{linked.length ? <p className="text-xs text-slate-400">关联本地台账 {linked.length} 项，见下方“本地台账”。</p> : <button type="button" onClick={() => startWorkbenchEntry({ kind: 'subtask', key: `subtask:${workbenchParent.workItemId}:${child.id}`, parent: workbenchParent, subtask: child, localTasks: [] },taskDashboard)} className="text-cyan-300 hover:underline">{feishuActionLabel(child.id,taskEntryLane({kind:'subtask',key:child.id,parent:workbenchParent,subtask:child,localTasks:[]})==='completed',taskDashboard)} →</button>}</div>
          </div>;
        })}
        {finishedParentChildren.length > 0 && <details className="rounded-lg border border-white/10 p-2.5"><summary className="cursor-pointer text-xs text-slate-300">已完成子任务 · {finishedParentChildren.length}</summary><div className="mt-2 space-y-3">{finishedParentChildren.map((child) => <div key={child.id} className="break-words text-xs">{subtaskUrl(workbenchParent, child) ? <a href={subtaskUrl(workbenchParent, child)!} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">{child.title} · {child.id}</a> : `${child.title} · ${child.id}`}<p className="mt-1 text-[11px] text-slate-500">{childTimeText(child.id)}{child.finishedAt ? ` · 完成 ${formatTime(child.finishedAt)}` : ''}</p></div>)}</div></details>}
      </Block>}
      {(detailSelection.kind === 'group' || detailSelection.kind === 'parent') && parentLocalTasks.length > 0 && <Block title={`本地台账 · ${parentLocalTasks.length}`}><DetailLocalLedgerList tasks={parentLocalTasks} renderRow={(local) => {
        const children = workbenchParent.mySubtasks.filter((child) => local.feishuWorkItemIds.includes(child.id));
        const relationLabel = children.length ? `关联子任务：${children.map((child) => child.title).join('、')}` : '直接关联父项';
        return <GroupedLocalRow key={local.id} task={local} relationLabel={relationLabel} onOpen={() => openTask(local.id, taskDashboard ?? undefined)} onStart={() => startTask(local, taskDashboard)} actionLabel={actionLabel(local, taskDashboard)} onOpenDocument={(filePath) => { closeDetail(); void openFilePreview(filePath); }} />;
      }} /></Block>}
      {(detailSelection.kind === 'group' || detailSelection.kind === 'parent') && relatedGroupIssues.length > 0 && <Block title={`关联缺陷 · ${relatedGroupIssues.length}`}>
        {relatedGroupIssues.map((issue) => <div key={issue.workItemId} className="rounded-lg border border-white/10 p-2.5">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><span className="text-[10px] text-slate-500">飞书缺陷</span><button type="button" onClick={() => openProject(issue.workItemId)} className="block break-words text-left font-medium hover:text-cyan-300">{issue.title}</button></div><span className="shrink-0 text-xs text-slate-400">{issue.statusName ?? '状态未登记'}</span></div>
          <p className="mt-1 text-xs text-slate-400">{responsibilityText(issue.actionability)} · {issue.url ? <a href={issue.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">{issue.workItemId}</a> : issue.workItemId}</p>
        </div>)}
      </Block>}
      {workbenchSubtask && <Block title={`精确关联的本地台账 · ${subtaskLocalTasks.length}`}>{subtaskLocalTasks.length ? <DetailLocalLedgerList tasks={subtaskLocalTasks} renderRow={(local) => <GroupedLocalRow key={local.id} task={local} childTitle={workbenchSubtask.title} onOpen={() => openTask(local.id, taskDashboard ?? undefined)} onStart={() => startTask(local, taskDashboard)} actionLabel={actionLabel(local, taskDashboard)} onOpenDocument={(filePath) => { closeDetail(); void openFilePreview(filePath); }} />} /> : <><p className="text-slate-400">此子任务尚未登记本地台账。</p><button type="button" onClick={() => startWorkbenchEntry({ kind: 'subtask', key: `subtask:${workbenchParent.workItemId}:${workbenchSubtask.id}`, parent: workbenchParent, subtask: workbenchSubtask, localTasks: [] },taskDashboard)} className="text-cyan-300 hover:underline">{feishuActionLabel(workbenchSubtask.id, taskEntryLane({ kind: 'subtask', key: workbenchSubtask.id, parent: workbenchParent, subtask: workbenchSubtask, localTasks: [] }) === 'completed', taskDashboard)} →</button></>}</Block>}
      <OperationHistory activity={activeOperations} loading={activityLoading} error={activityError} onMore={() => void loadMoreOperations()} onRefresh={() => void refreshOperations()} childId={workbenchSubtask?.id} childTitles={Object.fromEntries(workbenchParent.mySubtasks.map((child) => [child.id, child.title]))} />
      <p className="text-xs text-slate-500">飞书与本地台账状态分别跟踪。</p>
    </Drawer>}
    {run && <Drawer title={`${describeRun(run).title} · 执行详情`} onClose={() => setSelectedRun(null)}><RunDetail run={run} taskTitle={runTask?.title || null} onOpenTask={runTask ? () => { setSelectedRun(null); openTask(runTask.id, runSource ?? undefined); } : undefined} onOpenFile={run.detailFilePath ? () => { setSelectedRun(null); void openFilePreview(run.detailFilePath!); } : undefined} /></Drawer>}
    {desktopLayout && dayPanel && <Suspense fallback={null}>{dayPanel === 'calendar'
      ? <WorkspaceCalendarPanel today={today} anchorRef={calendarButtonRef} onClose={() => setDayPanel((current) => current === 'calendar' ? null : current)} />
      : <WorkspaceWeatherPanel city={day?.location?.city} today={today} anchorRef={weatherButtonRef} onClose={() => setDayPanel((current) => current === 'weather' ? null : current)} />}</Suspense>}
  </main>;
}

function TaskProgressNotice({entry}: {entry: TaskDisplayEntry}) {
  if (taskEntryLane(entry) !== 'doing') return null;
  const at = taskEntryProgressAt(entry);
  const {label, stale} = progressRecency(at);
  return <p className={`mt-1 text-[11px] ${stale ? 'text-amber-200' : 'text-slate-500'}`} title={at === null ? '无有效推进时间' : `${formatTime(at)}（任务开始/核验及关联执行，不取父项/会话更新时间）`}>{label}</p>;
}

function LocalStatusBadge({task}: {task:Task}) {
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${taskStatusPresentation(task.status).tone}`}>{localTaskStatusLabel(task)}</span>;
}

function FocusTaskCard({ task, responsibility, isNew = false, onOpen, onStart, actionLabel, onOpenDocument }: { task: Task; responsibility: WorkspaceConsoleResponsibilityDto | null; isNew?: boolean; onOpen: () => void; onStart: () => void; actionLabel: string; onOpenDocument: (filePath: string) => void }) {
  const projectItems = projectItemsForTask(task, responsibility);
  const linked = feishuLinksForTask(task, responsibility);
  const documentName = task.taskDocumentPath?.split(/[\\/]/).slice(-1)[0];
  const recordAt = latestTaskRecordAt(task);
  return <article data-task-tone={taskEntryLane({ kind: 'local', key: task.id, task })} className="workspace-workbench__task-card flex min-w-0 flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-4 focus-within:border-cyan-300/50">
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0"><div className="flex min-w-0 items-start gap-1.5"><button type="button" onClick={onOpen} aria-label={`查看任务详情：${task.title || task.id}`} title={task.title || task.id} className="min-w-0 line-clamp-2 break-words text-left text-sm font-semibold leading-5 text-slate-100 hover:text-cyan-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{task.title || task.id}</button>{isNew && <NewBadge />}</div><p className="mt-1 text-[11px] text-slate-500">本地台账</p></div>
      <LocalStatusBadge task={task} />
    </div>
    {linked.length > 0 && <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-slate-400">{linked.slice(0, 2).map((item) => <span key={item.workItemId} className="min-w-0 break-words"><span className="text-slate-500">{feishuRelationshipLabel(item.workItemId, responsibility, item.url)} · </span><a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`打开飞书任务：${item.title} · ${item.workItemId}`} className="text-cyan-300 hover:underline">{item.workItemId}</a></span>)}{linked.length > 2 && <button type="button" onClick={onOpen} className="text-cyan-300 hover:underline">另 {linked.length - 2} 项</button>}</div>}
    {!linked.length && !!(projectItems.length || task.feishuWorkItemIds.length) && <p className="text-xs text-slate-500">{(task.feishuWorkItemIds.length ? task.feishuWorkItemIds : projectItems.map((item) => item.workItemId)).map((id) => `${feishuRelationshipLabel(id, responsibility)} · ${id}`).join('；')}（链接未核验）</p>}
    {(task.nextAction || task.waitingOn) && <p title={task.nextAction || task.waitingOn || undefined} className="line-clamp-3 break-words text-sm leading-5 text-slate-200"><span className="text-slate-500">{task.waitingOn ? '等待：' : '下一步：'}</span>{task.waitingOn || task.nextAction}</p>}
    <TaskProgressNotice entry={{kind:'local',key:task.id,task}} />
    {task.taskDocumentPath && <button type="button" onClick={() => onOpenDocument(task.taskDocumentPath!)} title={task.taskDocumentPath} className="self-start text-xs text-cyan-300 hover:underline">预览本地台账 · {documentName}</button>}
    <div className="mt-auto grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-white/10 pt-3">
      <span className="min-w-0 break-words text-[11px] text-slate-500" title={recordAt || '未登记'}>本地更新 {formatTime(recordAt)}</span>
      <button type="button" onClick={onStart} className="shrink-0 whitespace-nowrap rounded-lg border border-cyan-300/35 px-2.5 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-300/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{actionLabel} →</button>
    </div>
  </article>;
}

function NewBadge({ className = '' }: { className?: string }) {
  return <span className={`inline-block shrink-0 rounded-sm border border-rose-400/40 bg-rose-400/10 px-1 py-0 text-[9px] font-semibold leading-3 text-rose-400 ${className}`}>NEW</span>;
}

function ProjectTaskCard({ item, actionLabel, reportGeneratedAt, isNew = false, onOpen, onStart }: { item: Extract<TaskEntry, { kind: 'project' }>['item']; actionLabel: string; reportGeneratedAt: string | null; isNew?: boolean; onOpen: () => void; onStart: () => void }) {
  const { current: rawCurrent, next } = projectTaskCardDetails(item);
  const current = formatFocusCurrent(rawCurrent) || '未登记';
  const url = feishuUrlForWorkItem(item);
  const finished = isPersonalProjectComplete(item);
  return <article data-task-tone={finished ? 'completed' : 'unstarted'} className="workspace-workbench__task-card flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-white/5 p-3 focus-within:border-cyan-300/50">
    <div className="flex min-w-0 items-start justify-between gap-2"><div className="flex min-w-0 items-start gap-1.5"><button type="button" onClick={onOpen} aria-label={`查看任务详情：${item.title}`} title={item.title} className="min-w-0 line-clamp-2 break-words text-left text-sm font-semibold leading-5 hover:text-cyan-300">{item.title}</button>{isNew && <NewBadge />}</div><span title={finished ? item.statusName ?? undefined : responsibilityExplanation(item.actionability)} className="shrink-0 rounded bg-cyan-300/10 px-1.5 py-0.5 text-[11px] text-cyan-300">{taskEntryStatusLabel({kind:'project',key:item.workItemId,item})}</span></div>
    <p className="mt-1 text-[11px] text-slate-500">飞书{feishuTypeName(item.typeName, url) ?? '工作项'} · {url ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`打开飞书工作项：${item.title} · ${item.workItemId}`} className="text-cyan-300 hover:underline">{item.workItemId}</a> : `${item.workItemId}（链接未核验）`}</p>
    {item.statusName && <p className="mt-1 text-[11px] text-slate-400">飞书状态：{item.statusName}</p>}
    {(item.tasks.length > 0 || !finished) && <p className="mt-2 text-[11px] font-medium text-amber-200">{item.tasks.length ? `关联本地台账 ${item.tasks.length} 项` : '本地进度未知 · 仅有飞书责任报表'}</p>}
    {!!item.linkedStoryIds?.length && <p className="mt-1 text-[11px] text-slate-400">关联需求：{item.linkedStoryIds.join('、')}</p>}
    <div className="mt-2 min-h-0 flex-1 space-y-1.5 text-xs leading-4">
      <p title={current} className="line-clamp-2 break-words text-slate-300"><span className="text-slate-500">当前：</span>{current}</p>
      <p title={next} className="line-clamp-2 break-words text-slate-300"><span className="text-slate-500">下一步：</span>{next}</p>
    </div>
    <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-white/10 pt-2">
      <span className="min-w-0 break-words text-[11px] text-slate-500" title={item.updatedAt ? '飞书工作项最后更新时间' : '飞书责任报表生成时间'}>{item.updatedAt ? `飞书更新 ${formatTime(item.updatedAt)}` : `飞书同步 ${formatTime(reportGeneratedAt)}`}</span>
      {!finished && <button type="button" onClick={onStart} className="shrink-0 whitespace-nowrap rounded-lg border border-cyan-300/35 px-2.5 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-300/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{actionLabel} →</button>}
    </div>
  </article>;
}

function TaskGroupCard({ group, activity, reportGeneratedAt, isNew, newKeys, onOpen, onOpenChild, onOpenTask, onOpenProject, onStartTask, onStartChild, onStartProject, actionLabel, entryActionLabel, onOpenDocument, prominent = false }: {
  group: TaskGroup; activity?: WorkspaceOperationRecordsDto | null; reportGeneratedAt: string | null; isNew: boolean; newKeys: ReadonlySet<string>; onOpen: () => void;
  onOpenChild: (entry: WorkbenchEntry) => void; onOpenTask: (id: string) => void; onOpenProject: (id: string) => void;
  onStartTask: (task: Task) => void; onStartChild: (entry: WorkbenchEntry) => void; onStartProject: (item: ProjectItem) => void;
  actionLabel: (task: Task) => string; entryActionLabel: (entry: TaskEntry) => string; onOpenDocument: (path: string) => void; prominent?: boolean;
}) {
  const { parent, members } = group;
  const showNew = taskEntryLane(group) !== 'completed';
  const ownChildren = members.filter((entry): entry is Extract<TaskEntry, { kind: 'subtask' }> => entry.kind === 'subtask');
  const linkedIssues = members.filter((entry): entry is Extract<TaskEntry, { kind: 'project' }> => entry.kind === 'project' && entry.item.typeName === '缺陷');
  const locals = members.filter((entry): entry is Extract<TaskEntry, { kind: 'local' }> => entry.kind === 'local').map((entry) => entry.task);
  const unfinishedLocals = locals.filter((task) => taskEntryLane({ kind: 'local', key: `local:${task.id}`, task }) !== 'completed');
  const localForChild = (entry: Extract<TaskEntry, { kind: 'subtask' }>) => unfinishedLocals.filter((task) => task.feishuWorkItemIds.includes(entry.subtask.id));
  const activeChildren = ownChildren.filter((entry) => workbenchChildNeedsAttention(entry.subtask, localForChild(entry)));
  const visibleChildren = activeChildren.slice(0, prominent ? 2 : 1);
  const standaloneLocals = unfinishedLocals.filter((task) => !ownChildren.some((entry) => task.feishuWorkItemIds.includes(entry.subtask.id)));
  const visibleLocals = standaloneLocals.slice(0, prominent ? 2 : 1);
  const latestFeishuAt = Math.max(0, ...members.filter((entry) => entry.kind !== 'local').map(taskEntryUpdatedAt));
  const latestLocalAt = Math.max(0, ...unfinishedLocals.map((task) => Date.parse(latestTaskRecordAt(task) ?? '') || 0));
  const isCompleted = taskEntryLane(group) === 'completed';
  const conflict = taskEntryConflict(group);
  const needsReview = !!conflict && taskEntryLane(group) !== 'doing';
  const futureNodes = parent.myNodes?.filter((node) => node.phase === 'upcoming').map((node) => node.name).filter(Boolean) ?? [];
  const personalCurrentNodes = parent.myNodes?.filter((node) => node.phase === 'current').map((node) => node.name).filter(Boolean) ?? [];
  const finishedAt = isCompleted ? taskDisplayEntryFinishedAt(group) : 0;
  const primaryEntry = selectGroupPrimaryEntry(group);
  const primaryTask = primaryEntry?.kind === 'local' ? primaryEntry.task : null;
  const primaryActionLabel = primaryEntry ? entryActionLabel(primaryEntry) : '开始处理';
  const primaryTitle = primaryTask?.title || primaryTask?.id || (primaryEntry?.kind === 'subtask' ? primaryEntry.subtask.title : primaryEntry?.kind === 'project' ? primaryEntry.item.title : parent.title);
  const startPrimary = () => {
    if (!primaryEntry) return;
    if (primaryEntry.kind === 'local') onStartTask(primaryEntry.task);
    else if (primaryEntry.kind === 'project') onStartProject(primaryEntry.item);
    else onStartChild(primaryEntry);
  };
  return <article data-task-tone={taskEntryLane(group)} className={`workspace-workbench__task-card workspace-workbench__matter-card min-w-0 rounded-xl border p-3.5 focus-within:border-cyan-300/50 ${prominent ? 'border-cyan-300/20 bg-cyan-300/[0.045]' : 'border-white/10 bg-white/5'}`}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1"><button type="button" onClick={onOpen} aria-label={`查看事项详情：${parent.title}`} title={parent.title} className="line-clamp-2 break-words text-left text-sm font-semibold leading-5 hover:text-cyan-300">{parent.title}</button><p className="mt-1 text-[11px] text-slate-500">飞书{feishuTypeName(parent.typeName, parent.url) ?? ''}父项 · {parent.url ? <a href={parent.url} target="_blank" rel="noopener noreferrer" aria-label={`打开飞书父项：${parent.title} · ${parent.workItemId}`} className="text-cyan-300 hover:underline">{parent.workItemId}</a> : `${parent.workItemId}（链接未核验）`}</p></div>
      <span className="rounded bg-cyan-300/10 px-1.5 py-0.5 text-[11px] text-cyan-300">{taskEntryStatusLabel(group)}</span>
    </div>
    <p className="mt-2 text-[11px] text-slate-400">{ownChildren.length} 个子任务 · {activeChildren.length} 个待处理 · {unfinishedLocals.length} 份待处理本地台账{linkedIssues.length > 0 && ` · ${linkedIssues.length} 个关联缺陷`}{showNew && isNew && <NewBadge className="ml-2" />}</p>
    <TaskProgressNotice entry={group} />
    {!workbenchFlowEnded(parent) && <p className="mt-1 text-[11px] text-slate-500">{currentNodeResponsibilityLabel(parent)}{futureNodes.length > 0 && ` · 后续参与：${futureNodes.join('、')}（未激活）`}</p>}
    {personalCurrentNodes.length > 0 && unfinishedLocals.some((task) => task.status === 'waiting' || task.status === 'blocked') && <p className="mt-1 text-[11px] text-amber-200">本地等待中，当前责任：{personalCurrentNodes.join('、')}；请核对等待条件。</p>}
    {conflict && <p className="mt-1 text-[11px] text-amber-200">{conflict}</p>}
    <div className="mt-2 space-y-2">
      {visibleChildren.map((entry) => <div key={entry.key} className="workspace-workbench__task-subsection min-w-0 rounded-lg border border-white/10 p-2.5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><button type="button" onClick={() => onOpenChild(entry)} aria-label={`查看子任务详情：${entry.subtask.title}`} className="block break-words text-left text-xs font-medium hover:text-cyan-300">{entry.subtask.title}</button><p className="mt-1 text-[10px] text-slate-500">飞书子任务{showNew && newKeys.has(entry.key) && <span className="text-rose-300"> · NEW</span>} · {subtaskUrl(parent, entry.subtask)
          ? <a href={subtaskUrl(parent, entry.subtask)!} target="_blank" rel="noopener noreferrer" aria-label={`打开飞书子任务：${entry.subtask.title} · ${entry.subtask.id}`} className="text-cyan-300 hover:underline">{entry.subtask.id}</a>
          : `${entry.subtask.id}（链接未核验）`}</p></div><span className="text-[11px] text-slate-400">{workbenchSubtaskStatusLabel(entry.subtask)}</span></div>
        {lastChildOperation(activity, entry.subtask.id) && <p className="mt-1 text-[11px] text-slate-500">子任务近期操作 {formatTime(lastChildOperation(activity, entry.subtask.id))}</p>}
        {localForChild(entry).length ? <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">{localForChild(entry).map((task) => <GroupedLocalRow key={task.id} task={task} childTitle={entry.subtask.title} onOpen={() => onOpenTask(task.id)} onStart={() => onStartTask(task)} actionLabel={actionLabel(task)} onOpenDocument={onOpenDocument} showStart={false} />)}</div>
          : <p className="mt-2 text-[11px] text-slate-500">{locals.some((task) => task.feishuWorkItemIds.includes(entry.subtask.id)) ? '本地台账均已完成，详见详情' : '尚无本地台账'}</p>}
      </div>)}
      {visibleLocals.map((task) => <GroupedLocalRow key={task.id} task={task} onOpen={() => onOpenTask(task.id)} onStart={() => onStartTask(task)} actionLabel={actionLabel(task)} onOpenDocument={onOpenDocument} showStart={false} />)}
      {linkedIssues.map((entry) => <div key={entry.key} className="min-w-0 rounded-lg border border-white/10 p-2.5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-1"><div className="min-w-0 flex-1"><span className="text-[10px] text-slate-500">飞书缺陷 · 关联需求{showNew && taskDisplayEntryIsNew(entry, newKeys) && <span className="text-rose-300"> · NEW</span>}</span><button type="button" onClick={() => onOpenProject(entry.item.workItemId)} className="block break-words text-left text-xs font-medium hover:text-cyan-300">{entry.item.title}</button></div><span className="shrink-0 text-[11px] text-slate-400">{entry.item.statusName ?? '状态未登记'}</span></div>
        <p className="mt-1 text-[11px] text-slate-400">{responsibilityText(entry.item.actionability)} · {entry.item.url ? <a href={entry.item.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">{entry.item.workItemId}</a> : `${entry.item.workItemId}（链接未核验）`}</p>
        {!isFinishedProjectIssue(entry.item) && <button type="button" onClick={() => onStartProject(entry.item)} className="mt-1.5 text-[11px] text-cyan-300 hover:underline">处理此缺陷 →</button>}
      </div>)}
    </div>
    <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-white/10 pt-2">
      <div className="flex min-w-0 flex-col items-start gap-0.5 break-words text-[11px] text-slate-500">
        {isCompleted ? <span title="个人子任务/台账的最晚结束时间，不代表父项流程结束">{finishedAt ? `${workbenchFlowEnded(parent) ? '结束' : '本轮完成'} ${formatTime(finishedAt)}` : '完成时间未登记'}</span> : <>
          {latestFeishuAt > 0 && <span title="飞书父工作项的更新时间；可能由其他成员或系统操作产生">飞书父项更新 {formatTime(latestFeishuAt)}</span>}
          {latestLocalAt > 0 && <span title="关联本地台账的最后记录时间">本地更新 {formatTime(latestLocalAt)}</span>}
          {latestFeishuAt === 0 && latestLocalAt === 0 && <span title="飞书责任报表生成时间">飞书报表同步 {formatTime(reportGeneratedAt)}</span>}
        </>}
      </div>
      <button type="button" onClick={isCompleted || needsReview ? onOpen : startPrimary} disabled={!primaryEntry} title={isCompleted ? '查看本轮已完成工作' : needsReview ? '核对本地与飞书责任差异' : `处理：${primaryTitle}`} className="shrink-0 whitespace-nowrap rounded-lg border border-cyan-300/35 px-2.5 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-300/10 disabled:opacity-50">{isCompleted ? '查看详情' : needsReview ? '核对详情' : primaryActionLabel} →</button>
    </div>
  </article>;
}

function DetailLocalLedgerList({ tasks, renderRow }: { tasks: Task[]; renderRow: (task: Task) => ReactNode }) {
  const { visible, hidden } = splitDetailLocalTasks(tasks);
  return <>
    {visible.map(renderRow)}
    {hidden.length > 0 && <details className="group"><summary className="cursor-pointer text-xs text-cyan-300">查看其余 {hidden.length} 条记录</summary><div className="mt-2 space-y-2">{hidden.map(renderRow)}</div></details>}
  </>;
}

function GroupedLocalRow({ task, childTitle, relationLabel, onOpen, onStart, actionLabel, onOpenDocument, showStart = true }: { task: Task; childTitle?: string; relationLabel?: string; onOpen: () => void; onStart: () => void; actionLabel: string; onOpenDocument: (path: string) => void; showStart?: boolean }) {
  const recordAt = latestTaskRecordAt(task);
  const recordSource = recordAt === task.lastVerifiedAt ? '核验' : recordAt === task.completedAt ? '完成' : recordAt === task.startedAt ? '开始' : null;
  return <div className="workspace-workbench__local-row min-w-0 rounded-md border border-white/10 p-2">
    <div className="flex flex-wrap items-start justify-between gap-1"><div className="min-w-0 flex-1"><span className="text-[10px] text-slate-500">本地台账</span><button type="button" onClick={onOpen} title={task.title || task.id} className="block break-words text-left text-xs font-medium text-slate-100 hover:text-cyan-300">{task.title === childTitle ? task.id : task.title || task.id}</button></div><span className="text-[11px] text-slate-400">{localTaskStatusLabel(task)}</span></div>
    {relationLabel && <p className="mt-1 break-words text-[11px] text-slate-500">{relationLabel}</p>}
    <p className="mt-1 text-[11px] text-slate-500">{recordAt ? `本地最近记录（${recordSource}）：${formatTime(recordAt)}` : '本地更新时间未登记'}</p>
    {(task.nextAction || task.waitingOn) && <p className="mt-1 line-clamp-2 break-words text-[11px] text-slate-400">{task.waitingOn || task.nextAction}</p>}
    {(task.taskDocumentPath || showStart) && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">{task.taskDocumentPath && <button type="button" onClick={() => onOpenDocument(task.taskDocumentPath!)} className="text-cyan-300 hover:underline">预览本地台账</button>}{showStart && <button type="button" onClick={onStart} className="text-cyan-300 hover:underline">{actionLabel} →</button>}</div>}
  </div>;
}

function OperationHistory({ activity, loading, error, onMore, onRefresh, childId, childTitles }: {
  activity: WorkspaceOperationRecordsDto | null; loading: boolean; error: string | null;
  onMore: () => void; onRefresh: () => void; childId?: string; childTitles: Record<string, string>;
}) {
  const events = (activity?.events ?? []).filter((event) => !childId || event.childId === childId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return <Block title={`飞书操作记录 · ${events.length}`}>
    <p className="text-xs text-slate-500">{activity ? `查询范围：${formatTime(activity.rangeStart)} 至 ${formatTime(activity.rangeEnd)}` : '打开详情后按需读取近期记录'}；仅展示操作类型，不展示字段旧值和新值。</p>
    {loading && <p className="text-xs text-slate-400">正在读取操作记录…</p>}
    {error && <p role="alert" className="text-xs text-rose-300">操作记录读取失败：<FailureNotice error={error} /></p>}
    {!loading && activity && events.length === 0 && <p className="text-xs text-slate-400">当前查询窗口未查到相关操作。</p>}
    {activity?.hasMore && <p className="text-xs text-amber-200">查询窗口尚未查全，当前列表和子任务时间可能不是最新。</p>}
    {events.slice(0, 10).map((event, index) => <p key={`${event.at}:${event.childId ?? 'parent'}:${index}`} className="break-words text-xs text-slate-300">
      {formatTime(event.at)} · {event.childId ? `${childTitles[event.childId] ?? `子任务 ${event.childId}`}：` : ''}{event.label}
    </p>)}
    {events.length > 10 && <details><summary className="cursor-pointer text-xs text-cyan-300">查看其余 {events.length - 10} 条已载入记录</summary><div className="mt-2 space-y-1">{events.slice(10).map((event, index) => <p key={`${event.at}:${event.childId ?? 'parent'}:${index}`} className="break-words text-xs text-slate-400">{formatTime(event.at)} · {event.childId ? `${childTitles[event.childId] ?? `子任务 ${event.childId}`}：` : ''}{event.label}</p>)}</div></details>}
    <div className="flex gap-3 text-xs">{activity?.hasMore && <button type="button" disabled={loading} onClick={onMore} className="text-cyan-300 disabled:opacity-50">继续加载 →</button>}<button type="button" disabled={loading} onClick={onRefresh} className="text-cyan-300 disabled:opacity-50">刷新操作记录</button></div>
  </Block>;
}

function LocalTaskCard({ task, responsibility, compact = false, isNew = false, onOpen, onStart, actionLabel, onOpenDocument }: { task: Task; responsibility: WorkspaceConsoleResponsibilityDto | null; compact?: boolean; isNew?: boolean; onOpen: () => void; onStart: () => void; actionLabel: string; onOpenDocument: (filePath: string) => void }) {
  const projectItems = projectItemsForTask(task, responsibility);
  const linked = feishuLinksForTask(task, responsibility);
  const isCompleted = ['done', 'completed', 'closed', 'cancelled', 'canceled'].includes(task.status ?? '');
  const endLabel = task.status === 'done' || task.status === 'completed' ? '完成' : '结束';
  const next = task.completedAt ? `完成于 ${formatTime(task.completedAt)}` : task.nextAction || (isCompleted ? statusText(task.status) : '未登记');
  const documentName = task.taskDocumentPath?.split(/[\\/]/).slice(-1)[0] || null;
  return <article data-task-tone={taskEntryLane({ kind: 'local', key: task.id, task })} className={`workspace-workbench__task-card flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-white/5 focus-within:border-cyan-300/50 ${compact ? 'p-3' : 'p-3.5'}`}>
    <div className="flex min-w-0 items-start justify-between gap-2">
      <div className="min-w-0"><div className="flex min-w-0 items-start gap-1.5"><button type="button" onClick={onOpen} aria-label={`查看任务详情：${task.title || task.id}`} title={task.title || task.id} className="min-w-0 line-clamp-2 break-words text-left text-sm font-semibold leading-5 hover:text-cyan-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{task.title || task.id}</button>{isNew && <NewBadge />}</div><p className="mt-1 text-[11px] text-slate-500">本地台账</p></div>
      <LocalStatusBadge task={task} />
    </div>
    {linked.length > 0 && <div className="mt-2 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[11px]">{linked.slice(0, 2).map((item) => <span key={item.workItemId} className="min-w-0 break-words"><span className="text-slate-500">{feishuRelationshipLabel(item.workItemId, responsibility, item.url)} · </span><a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`打开飞书任务：${item.title} · ${item.workItemId}`} className="text-cyan-300 hover:underline">{item.workItemId}</a></span>)}{linked.length > 2 && <button type="button" onClick={onOpen} className="text-cyan-300 hover:underline">另 {linked.length - 2} 项</button>}</div>}
    {!linked.length && !!(projectItems.length || task.feishuWorkItemIds.length) && <p className="mt-2 line-clamp-2 break-words text-[11px] text-slate-500">{(task.feishuWorkItemIds.length ? task.feishuWorkItemIds : projectItems.map((item) => item.workItemId)).map((id) => `${feishuRelationshipLabel(id, responsibility)} · ${id}`).join('；')}（链接未核验）</p>}
    {next !== '未登记' && <p title={next} className="mt-2 line-clamp-2 break-words text-xs leading-4 text-slate-300"><span className="text-slate-500">{isCompleted ? '结果：' : task.waitingOn ? '等待：' : '下一步：'}</span>{task.waitingOn || next}</p>}
    <TaskProgressNotice entry={{kind:'local',key:task.id,task}} />
    {task.taskDocumentPath && <button type="button" onClick={() => onOpenDocument(task.taskDocumentPath!)} title={task.taskDocumentPath} className="mt-2 self-start text-[11px] text-cyan-300 hover:underline">预览本地台账 · {documentName}</button>}
    <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-white/10 pt-2">
      <span className="min-w-0 break-words text-[11px] text-slate-500" title={isCompleted ? task.completedAt || '结束时间未登记' : latestTaskRecordAt(task) || '未登记'}>{isCompleted ? task.completedAt ? `${endLabel} ${formatTime(task.completedAt)}` : '结束时间未登记' : `本地更新 ${formatTime(latestTaskRecordAt(task))}`}</span>
      <button type="button" onClick={onStart} className="shrink-0 whitespace-nowrap rounded-lg border border-cyan-300/35 px-2.5 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-300/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{actionLabel} →</button>
    </div>
  </article>;
}

function Drawer({ title, subtitle, onClose, onRefresh, refreshing = false, children }: { title: string; subtitle?: string; onClose: () => void; onRefresh?: () => void; refreshing?: boolean; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}><aside role="dialog" aria-label={title} className="h-[100dvh] w-full min-w-0 overflow-x-hidden overflow-y-auto border-l border-white/10 bg-slate-950 p-4 shadow-2xl sm:max-w-2xl sm:p-6" onClick={(event) => event.stopPropagation()}><div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h2 className="break-words text-lg font-semibold sm:text-xl">{title}</h2>{subtitle && <p className="mt-1 break-all text-xs text-slate-500">{subtitle}</p>}</div><div className="flex shrink-0 gap-2">{onRefresh && <button type="button" onClick={onRefresh} disabled={refreshing} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs disabled:opacity-50">{refreshing ? '刷新中…' : '刷新'}</button>}<button type="button" onClick={onClose} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs">关闭</button></div></div><div className="mt-5 space-y-4 text-sm">{children}</div></aside></div>; }
function Block({ title, children }: { title: string; children: React.ReactNode }) { return <section className="min-w-0 space-y-2 overflow-x-hidden rounded-xl border border-white/10 bg-white/5 p-4 text-slate-300"><h3 className="font-medium text-slate-100">{title}</h3>{children}</section>; }
function ObservationSection({ title, count, tone, empty, onRefresh, refreshing, error, children }: { title: string; count: number; tone: string; empty: string; onRefresh: () => void; refreshing: boolean; error?: string; children: React.ReactNode }) { return <section aria-label={title} className="min-w-0 rounded-xl border border-white/10 bg-slate-950/35 p-3"><div className="mb-2 flex items-center justify-between gap-2"><h3 className={`text-xs font-semibold ${tone}`}>{title}</h3><div className="flex shrink-0 items-center gap-2"><button type="button" onClick={onRefresh} disabled={refreshing} aria-label={`刷新${title}`} title={`刷新${title}`} className="rounded-md border border-white/15 px-1.5 py-0.5 text-xs text-slate-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:opacity-50"><span aria-hidden="true">{refreshing ? '刷新中…' : '↻'}</span></button><span className="text-[11px] tabular-nums text-slate-500">{count}</span></div></div>{error && <p role="alert" className="mb-2 text-xs text-rose-300">刷新失败：<FailureNotice error={error} /></p>}<div className="space-y-2">{count ? children : <p className="rounded-lg border border-white/5 p-2.5 text-xs text-slate-500">{empty}</p>}</div></section>; }
function formatRunCardTime(value: string | null): string {
  if (!value) return '未记录';
  const date = new Date(value.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatRunCardClock(value: string, startedAt: string | null): string {
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return '未记录';
  const started = startedAt ? new Date(startedAt.replace(' ', 'T')) : null;
  return started && !Number.isNaN(started.getTime()) && date.toDateString() === started.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : formatRunCardTime(value);
}
function RunRow({ run, taskTitle, onOpen }: { run: WorkspaceConsoleRunDto; taskTitle?: string; onOpen: () => void }) {
  const description = describeRun(run);
  const metrics = describeRunListMetrics(run);
  const running = description.outcome === '进行中';
  const statusTone = description.outcome === '失败' ? 'border-rose-300/30 bg-rose-300/10 text-rose-200'
    : running ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200'
      : ['成功', '完成'].includes(description.outcome) ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200' : 'border-white/15 bg-white/5 text-slate-300';
  const compactOutcome = description.outcome === '仅发现目录，暂无运行结果' ? '无结果' : description.outcome === '最终状态未记录' ? '状态未记' : description.outcome === '结果未记录' ? '未记录' : description.outcome;
  const location = run.executionLocation === 'remote' ? '服务器' : run.executionLocation === 'local' ? '本机' : '位置未记录';
  const timestamp = `${location} · 开始 ${formatRunCardTime(run.startedAt)}${running && run.observedAt ? ` · 核查 ${formatRunCardClock(run.observedAt, run.startedAt)}` : run.durationSeconds !== null ? ` · 用时 ${formatRunDuration(run.durationSeconds)}` : ''}`;
  return <button type="button" onClick={onOpen} className="block w-full min-w-0 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 text-left hover:border-cyan-300/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">
    <span className="mb-1 block text-[10px] text-slate-500">{describeRunCategory(run)}</span>
    <span className="flex min-w-0 items-start justify-between gap-2"><span className="min-w-0 whitespace-normal break-words text-xs font-medium text-slate-100">{taskTitle || description.title}</span><span className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] ${statusTone}`}>{run.source === 'remote-runner' ? `Runner ${compactOutcome}` : compactOutcome}</span></span>
    <span className="mt-1 block truncate text-[11px] text-slate-300" title={`${description.title} · ${describeRunMode(run)}`}>{taskTitle && taskTitle !== description.title && `${description.title} · `}{describeRunMode(run)}</span>
    {metrics ? <span className="mt-0.5 block truncate text-[11px] text-slate-200" title={metrics}>{metrics}</span> : running && run.source === 'remote-runner' ? <span className="mt-0.5 block text-[11px] text-slate-500">本机尚无进度计数</span> : null}
    <span className="mt-1 block truncate text-[11px] text-slate-500" title={timestamp}>{timestamp}</span>
  </button>;
}
function RunDetail({ run, taskTitle, onOpenTask, onOpenFile }: { run: WorkspaceConsoleRunDto; taskTitle: string | null; onOpenTask?: () => void; onOpenFile?: () => void }) {
  const description = describeRun(run);
  const result = describeRunResult(run);
  const metrics = describeRunMetrics(run);
  const duration = formatRunDuration(run.durationSeconds);
  const hasPlannedRepair = run.resultMetrics?.items.some((item) => item.label === '计划修复') ?? false;
  const conditions = metrics?.conditions ?? [];
  const visibleConditions = (hasPlannedRepair ? conditions.filter((item) => !item.startsWith('符合修复条件 ')) : conditions).slice(0, 3);
  const extraConditions = conditions.filter((item) => !visibleConditions.includes(item));
  return <>
    <Block title="执行结果">
      <p className="font-medium text-slate-100">{run.source === 'remote-runner' ? `Runner ${result.outcome}` : result.outcome}</p>
      {metrics && <><p className="text-xs text-slate-400">{metrics.sourceLabel}（本机已收集文件）</p>{metrics.totals.map((item) => <p key={item}>{item}</p>)}{conditions.length > 0 && <p className="pt-1 text-xs text-slate-400">条件分类</p>}{visibleConditions.map((item) => <p key={item}>{item}</p>)}{extraConditions.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-cyan-300">展开其余 {extraConditions.length} 项条件</summary><div className="mt-2 space-y-1.5 text-sm text-slate-300">{extraConditions.map((item) => <p key={item}>{item}</p>)}</div></details>}</>}
      {result.facts.map((fact) => <p key={fact} className="break-words">{fact}</p>)}
      {onOpenFile && <p className="pt-2"><button type="button" onClick={onOpenFile} className="text-cyan-300 underline-offset-2 hover:underline focus-visible:underline">打开本地执行文件（{run.detailFilePath?.split(/[\\/]/).pop()}）→</button></p>}
    </Block>
    <Block title="执行信息">
      <p className="break-words">所属任务：{onOpenTask ? <button type="button" onClick={onOpenTask} className="text-cyan-300 hover:underline">{taskTitle || run.taskId} →</button> : taskTitle || (run.taskId ? `未匹配任务（${run.taskId}）` : '未记录')}</p>
      <p>执行目标：{description.title} · {describeRunMode(run)}</p>
      <p>开始：{run.startedAt ? formatTime(run.startedAt) : '未记录'}</p>
      {run.finishedAt && <p>结束：{formatTime(run.finishedAt)}</p>}
      {run.durationSeconds !== null && <p>用时：{duration}</p>}
      <p>位置：{run.executionLocation === 'local' ? '本机' : run.executionLocation === 'remote' ? '服务器' : '未记录'}</p>
      {run.executionLocation === 'remote' && <p>最近核查：{run.observedAt ? formatTime(run.observedAt) : '未记录'}</p>}
    </Block>
    <details className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300"><summary className="cursor-pointer font-medium text-slate-100">排查信息与本地文件</summary><div className="mt-3 space-y-2 break-words">
      {run.serverName && <p>服务器配置：{run.serverName}</p>}
      {run.target && <p>Runner 任务名：{run.target}</p>}
      {run.mode && <p>Runner 模式：{run.mode}</p>}
      {description.detail && <p>记录摘要：{description.detail}</p>}
      {run.exitCode !== null && <p>进程退出码：{run.exitCode}</p>}
      <p className="break-all">Run ID：{run.runId}</p>
      {run.taskId && <p className="break-all">任务 ID：{run.taskId}</p>}
      <p className="text-xs text-slate-400">本地文件：{run.evidenceFiles.length ? run.evidenceFiles.join('、') : run.executionLocation === 'remote' ? '尚未收集到本机' : '无'}</p>
    </div></details>
  </>;
}
