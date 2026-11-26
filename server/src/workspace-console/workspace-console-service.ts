import { readWorkspaceRuns } from './workspace-runs-reader.js';
export { readWorkspaceRuns } from './workspace-runs-reader.js';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../auth/authorization.js';
import { getDB, type SQLiteDB } from '../db/index.js';
import { WorkspaceConsoleDashboardDtoSchema } from '../contracts/dto.js';
import { readWorkspaceSnapshot, writeWorkspaceSnapshot } from '../db/workspace-snapshots.js';
import { deleteWorkspaceTaskSessionLinkInDatabase, insertWorkspaceLinkInDatabase, listWorkspaceLinks, type WorkspaceLink } from '../db/queries-workspace-console.js';
import { ServiceError } from '../services/errors.js';
import { AssociationService } from './association-service.js';
import { readObservedTaskDurations } from './activity-duration.js';
import { buildWorkspaceDashboard, hasCurrentRunTimes, withoutLegacyRunTiming, type WorkspaceDashboard } from './dashboard-projection.js';
import { ResponsibilityReportService, type WorkspaceResponsibilitySnapshot } from './responsibility-report.js';
import type { WorkspaceRunProjection } from './run-projection.js';
import type { SessionCardProjection } from './session-projection.js';
import { readTaskRegistry, type TaskRegistryProjection } from './task-registry-reader.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';

interface ServiceDependencies {
  registry?: () => Promise<TaskRegistryProjection>;
  listRuns?: () => Promise<WorkspaceRunProjection[]>;
  listSessions?: () => SessionCardProjection[];
  listLinks?: () => WorkspaceLink[];
  responsibility?: ResponsibilityReportService;
  now?: () => number;
  activityDurations?: (taskIds: string[], now: number) => Promise<Map<string, number>>;
  database?: Pick<SQLiteDB, 'get' | 'run' | 'saveToFile' | 'raw' | 'restoreFromBytes'>;
}

function requireAdmin(actor: Actor): void {
  if (actor.role !== 'admin') throw new ServiceError(403, '仅管理员可以查看工作区控制台', 'WORKSPACE_CONSOLE_FORBIDDEN');
}

export class WorkspaceConsoleService {
  private readonly registry: () => Promise<TaskRegistryProjection>;
  private readonly listRuns: () => Promise<WorkspaceRunProjection[]>;
  private readonly listSessions: () => SessionCardProjection[];
  private readonly listLinks: () => WorkspaceLink[];
  private readonly responsibility: ResponsibilityReportService;
  private readonly now: () => number;
  private readonly activityDurations: (taskIds: string[], now: number) => Promise<Map<string, number>>;
  private readonly database: () => Pick<SQLiteDB, 'get' | 'run' | 'saveToFile' | 'raw' | 'restoreFromBytes'>;
  private dashboardFailure: { at: number; error: string } | null = null;

  constructor(dependencies: ServiceDependencies = {}) {
    const associations = new AssociationService();
    this.registry = dependencies.registry ?? (() => readTaskRegistry(FIXED_WORKSPACE_PATH));
    this.listRuns = dependencies.listRuns ?? (() => readWorkspaceRuns());
    this.listSessions = dependencies.listSessions ?? (() => associations.listWorkspaceSessions(FIXED_WORKSPACE_PATH));
    this.listLinks = dependencies.listLinks ?? (() => listWorkspaceLinks(FIXED_WORKSPACE_PATH));
    this.responsibility = dependencies.responsibility ?? new ResponsibilityReportService();
    this.now = dependencies.now ?? Date.now;
    this.activityDurations = dependencies.activityDurations ?? ((taskIds, now) => readObservedTaskDurations(FIXED_WORKSPACE_PATH, taskIds, now));
    this.database = dependencies.database ? () => dependencies.database! : getDB;
  }

  private async assertLinkTarget(actor: Actor, taskId: string, sessionId: string): Promise<void> {
    requireAdmin(actor);
    if (!taskId || !(await this.registry()).tasks.some((task) => task.id === taskId)) {
      throw new ServiceError(404, '任务不存在于当前工作区台账', 'WORKSPACE_TASK_NOT_FOUND');
    }
    const row = this.database().get(
      `SELECT p.path AS project_path FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id = ? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`, [sessionId],
    );
    if (typeof row?.project_path !== 'string' || row.project_path.toLowerCase() !== FIXED_WORKSPACE_PATH.toLowerCase()) {
      throw new ServiceError(404, '会话不存在于当前工作区', 'WORKSPACE_SESSION_NOT_FOUND');
    }
  }

  async validateFirstSendTask(actor: Actor, taskId: string, sessionId: string): Promise<void> {
    await this.assertLinkTarget(actor, taskId, sessionId);
    if (this.database().get('SELECT 1 AS present FROM messages WHERE session_id = ? LIMIT 1', [sessionId])) {
      throw new ServiceError(409, '任务关联只允许新会话首条消息', 'WORKSPACE_TASK_FIRST_SEND_ONLY');
    }
  }

  async linkSession(actor: Actor, taskId: string, sessionId: string): Promise<{ taskId: string; sessionId: string; linked: true }> {
    await this.assertLinkTarget(actor, taskId, sessionId);
    if (!this.database().get('SELECT 1 AS present FROM messages WHERE session_id = ? LIMIT 1', [sessionId])) {
      throw new ServiceError(409, '请先发送会话首条消息，再关联任务', 'WORKSPACE_SESSION_DRAFT');
    }
    const now = this.now();
    insertWorkspaceLinkInDatabase(this.database(), { id: randomUUID(), workspace_path: FIXED_WORKSPACE_PATH, task_id: taskId,
      session_id: sessionId, feishu_work_item_id: null, run_id: null, relation_source: 'explicit', confidence: 'high',
      last_verified_at: now, created_at: now, updated_at: now });
    return { taskId, sessionId, linked: true };
  }

  async unlinkSession(actor: Actor, taskId: string, sessionId: string): Promise<{ taskId: string; sessionId: string; linked: false }> {
    await this.assertLinkTarget(actor, taskId, sessionId);
    deleteWorkspaceTaskSessionLinkInDatabase(this.database(), FIXED_WORKSPACE_PATH, taskId, sessionId);
    return { taskId, sessionId, linked: false };
  }

  async getDashboard(actor: Actor, options: { force?: boolean } = {}): Promise<WorkspaceDashboard> {
    requireAdmin(actor);
    const identityKey = `${actor.userId}:${FIXED_WORKSPACE_PATH}`;
    let previous: { value: WorkspaceDashboard; savedAt: number } | null = null;
    try {
      const loaded = readWorkspaceSnapshot(this.database(), 'dashboard', identityKey, WorkspaceConsoleDashboardDtoSchema);
      if (loaded) previous = { value: loaded.value as WorkspaceDashboard, savedAt: loaded.savedAt };
    } catch { /* The live file and database sources can still be read. */ }
    if (previous && !options.force && (this.dashboardFailure || hasCurrentRunTimes(previous.value))) {
      const cached: WorkspaceDashboard = { ...withoutLegacyRunTiming(previous.value), sourceMeta: {
        state: this.dashboardFailure ? 'failed_snapshot' : 'snapshot', lastSuccessAt: previous.savedAt,
        lastAttemptAt: this.dashboardFailure?.at ?? null, error: this.dashboardFailure?.error ?? null,
      } };
      try {
        // Task/run snapshots can be reused, but session existence and explicit
        // associations must be read on every dashboard request for action buttons.
        const current = buildWorkspaceDashboard(
          { schemaVersion: null, generatedAt: cached.registryGeneratedAt, tasks: cached.tasks },
          [], this.listSessions(), this.listLinks(), this.now(),
        );
        const sessionIds = new Map(current.tasks.map((task) => [task.id, task.sessionIds]));
        return { ...cached,
          tasks: cached.tasks.map((task) => ({ ...task, sessionIds: sessionIds.get(task.id) ?? [] })),
          sessions: current.sessions, unlinkedSessions: current.unlinkedSessions,
          counts: { ...cached.counts, sessions: current.counts.sessions },
          sourceAvailable: { ...cached.sourceAvailable, sessions: true, links: true },
        };
      } catch {
        const error = '当前 Relay 会话或任务关联读取失败，暂用上次快照，请重试刷新';
        return { ...cached, errors: [...cached.errors, error],
          sourceAvailable: { ...cached.sourceAvailable, sessions: false, links: false },
          sourceMeta: { state: 'failed_snapshot', lastSuccessAt: previous.savedAt, lastAttemptAt: this.now(), error },
        };
      }
    }
    const [registryResult, runsResult, sessionsResult, linksResult] = await Promise.allSettled([
      this.registry(), this.listRuns(), Promise.resolve().then(() => this.listSessions()), Promise.resolve().then(() => this.listLinks()),
    ]);
    const errors = [registryResult, runsResult, sessionsResult, linksResult].flatMap((result, index) => result.status === 'rejected'
      ? [`${['台账', 'Run', 'Relay 会话', '会话关联'][index]} 读取失败：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
    const capturedAt = this.now();
    const registry = registryResult.status === 'fulfilled' ? registryResult.value : { schemaVersion: null, generatedAt: null, tasks: [] };
    const openIds = registry.tasks.filter((task) => !['done', 'completed', 'closed', 'cancelled', 'canceled'].includes(task.status ?? '')).map((task) => task.id);
    let durations = new Map<string, number>();
    let activityAvailable = true;
    if (openIds.length) {
      try { durations = await this.activityDurations(openIds, capturedAt); }
      catch (error) {
        activityAvailable = false;
        errors.push(`活动用时读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const result = buildWorkspaceDashboard(registry,
      runsResult.status === 'fulfilled' ? runsResult.value : [],
      sessionsResult.status === 'fulfilled' ? sessionsResult.value : [],
      linksResult.status === 'fulfilled' ? linksResult.value : [], capturedAt, errors,
      { registry: registryResult.status === 'fulfilled', runs: runsResult.status === 'fulfilled', sessions: sessionsResult.status === 'fulfilled', links: linksResult.status === 'fulfilled', activity: activityAvailable }, durations);
    if (errors.length === 0) {
      this.dashboardFailure = null;
      try { writeWorkspaceSnapshot(this.database(), 'dashboard', identityKey, result, capturedAt); }
      catch { console.warn('[WorkspaceConsole] dashboard snapshot save unavailable'); }
      return { ...result, sourceMeta: { state: 'live', lastSuccessAt: capturedAt, lastAttemptAt: capturedAt, error: null } };
    }
    this.dashboardFailure = { at: capturedAt, error: '本地数据部分来源读取失败' };
    if (!previous) return { ...result, sourceMeta: { state: 'unavailable', lastSuccessAt: null, lastAttemptAt: capturedAt, error: this.dashboardFailure.error } };
    const old = withoutLegacyRunTiming(previous.value);
    const oldTasks = new Map(old.tasks.map((task) => [task.id, task]));
    let tasks = registryResult.status === 'fulfilled' ? result.tasks : old.tasks;
    if (runsResult.status === 'rejected') tasks = tasks.map((task) => ({ ...task, runIds: oldTasks.get(task.id)?.runIds ?? [] }));
    if (sessionsResult.status === 'rejected' || linksResult.status === 'rejected') {
      tasks = tasks.map((task) => ({ ...task, sessionIds: oldTasks.get(task.id)?.sessionIds ?? [] }));
    }
    if (!activityAvailable) tasks = tasks.map((task) => ({ ...task, observedDurationSeconds: oldTasks.get(task.id)?.observedDurationSeconds ?? null }));
    return { ...result, tasks,
      registryGeneratedAt: registryResult.status === 'fulfilled' ? result.registryGeneratedAt : old.registryGeneratedAt,
      runs: runsResult.status === 'fulfilled' ? result.runs : old.runs,
      unmatchedRuns: runsResult.status === 'fulfilled' ? result.unmatchedRuns : old.unmatchedRuns,
      sessions: sessionsResult.status === 'fulfilled' ? result.sessions : old.sessions,
      unlinkedSessions: sessionsResult.status === 'fulfilled' && linksResult.status === 'fulfilled' ? result.unlinkedSessions : old.unlinkedSessions,
      counts: { ...result.counts,
        total: registryResult.status === 'fulfilled' ? result.counts.total : old.counts.total,
        completed: registryResult.status === 'fulfilled' ? result.counts.completed : old.counts.completed,
        active: registryResult.status === 'fulfilled' ? result.counts.active : old.counts.active,
        runs: runsResult.status === 'fulfilled' ? result.counts.runs : old.counts.runs,
        sessions: sessionsResult.status === 'fulfilled' ? result.counts.sessions : old.counts.sessions },
      sourceMeta: { state: 'failed_snapshot', lastSuccessAt: previous.savedAt, lastAttemptAt: capturedAt, error: this.dashboardFailure.error } };
  }

  async getResponsibility(actor: Actor, options: { force?: boolean } = {}): Promise<WorkspaceResponsibilitySnapshot> {
    requireAdmin(actor);
    return this.responsibility.get(options.force === true);
  }
}
