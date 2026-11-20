import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { WorkspaceConsoleResponsibilityDtoSchema, WorkspaceSourceMetaDtoSchema } from '../contracts/dto.js';
import type { WorkspaceFeishuContextDtoSchema } from '../contracts/dto.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';

export function projectPythonExecutable(workspaceRoot: string): string {
  return process.platform === 'win32'
    ? path.join(workspaceRoot, '.runtime', 'conda-envs', 'py312', 'python.exe')
    : path.join(workspaceRoot, '.runtime', 'conda-envs', 'py312', 'bin', 'python');
}

type RecordValue = Record<string, unknown>;
export type ExpectedIdentity = { userKey: string; projectKey: string; scope?: string };
type FeishuContext = z.infer<typeof WorkspaceFeishuContextDtoSchema>;
export interface ResponsibilityItem extends FeishuContext {
  finishedAt?:string|null;
  nativeCompleted?: boolean | null;
  workItemId: string;
  title: string;
  typeName: string | null;
  actionability: 'current' | 'state_responsibility' | 'upcoming';
  statusName?: string | null;
  myRoleKeys?: string[];
  baseOwnerIsMe?: boolean;
  fallbackContact?: { role: 'reporter' | 'creator'; names: string[] };
  personalSubtasks: Array<{ id: string; name: string; passed: boolean }>;
  currentNodes: string[];
  version: string | null;
  url: string | null;
  localTaskIds: string[];
  linkedStoryIds?: string[];
  updatedAt?: string | null;
}
export interface LocalAssociatedItem extends FeishuContext {
  kind?:'work_item'|'subtask'|'unresolved';parentId?:string|null;
  verified?: boolean;
  error?: string | null;
  associationKey: string;
  workItemId: string;
  title: string;
  url: string | null;
  localTaskIds: string[];
}
export interface WorkbenchItem extends FeishuContext {
  participated?: boolean;
  workItemId: string;
  title: string;
  typeName: string | null;
  url: string | null;
  ownerUserKey: string | null;
  roleOwnerUserKeys?: string[];
  stateKey: string | null;
  isArchivedState: boolean | null;
  flowFinished: boolean | null;
  currentNodeNames: string[];
  currentNodes?: Array<{ name: string; ownerNames: string[] }>;
  myNodes?: Array<{ id: string; name: string | null; phase: 'current' | 'upcoming' | 'completed' | 'unknown'; ownerCount?: number | null }>;
  updatedAt?: string | null;
  finishedAt?: string | null;
  mySubtasks: Array<{ id: string; title: string; owners: string[]; ownerNames?:string[]; passed: boolean; createdAt?:string|null;updatedAt?:string|null;finishedAt?: string | null; nodeId: string; nodeName: string | null; phase: 'current' | 'upcoming' | 'completed' | 'unknown';localTaskIds?:string[] }>;
}
export interface WorkspaceResponsibilitySnapshot {
  sourceProjectKey?:string;relationCoverage?:'not_queried'|'complete'|'partial';
  associationMeta?:{state:'unbound'|'complete'|'partial'|'unavailable';error:string|null;checkedAt:number|null};
  reportKind: 'project_responsibility';
  sourceUserKey: string;
  todoEquivalent: false;
  generatedAt: string;
  fetchedAt: number;
  servedFromCache: boolean;
  complete: boolean;
  unverifiedCount?: number;
  stale: boolean;
  error: string | null;
  sourceMeta?: z.infer<typeof WorkspaceSourceMetaDtoSchema>;
  items: ResponsibilityItem[];
  workbenchItems: WorkbenchItem[];
  localAssociated: LocalAssociatedItem[];
  counts: { current: number; stateResponsibility: number; upcoming: number };
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project 责任报表结构无效');
  return value as RecordValue;
}
type ReportProfile = { stages: Record<string, number>; jsonCalls: number; rateLimiterCalls: number; rateWaitMs: number;
  routes: Array<{ route: string; calls: number; elapsedMs: number }> };
export function parseReportProfile(stdout: string): ReportProfile | null {
  try {
    const result = record(JSON.parse(stdout));
    const rawStages = record(result.stage_ms);
    const rawApi = record(result.api_metrics);
    if (!Number.isSafeInteger(rawApi.calls) || (rawApi.calls as number) < 0 ||
      !Number.isSafeInteger(rawApi.wait_ms) || (rawApi.wait_ms as number) < 0) return null;
    const stages: Record<string, number> = {};
    for (const name of ['responsibility', 'local_anchors', 'state_names', 'release_fields',
      'local_workflow', 'canary_applications', 'space', 'build', 'write']) {
      const value = rawStages[name];
      if (Number.isSafeInteger(value) && (value as number) >= 0) stages[name] = value as number;
    }
    const safeRouteSegments = new Set(['open_api', '{scope}', 'work_item', '{type}', '{id}',
      'query', 'filter', 'meta', 'search', 'subtask', 'workflow', 'space', 'types', 'detail',
      'version', 'fields']);
    const routes = Object.entries(record(rawApi.routes)).flatMap(([route, value]) => {
      if (route.length > 150 || !route.startsWith('/open_api/{scope}/') ||
        !route.slice(1).split('/').every((segment) => safeRouteSegments.has(segment))) return [];
      const row = record(value);
      return Number.isSafeInteger(row.calls) && (row.calls as number) >= 0 &&
        Number.isSafeInteger(row.elapsed_ms) && (row.elapsed_ms as number) >= 0
        ? [{ route, calls: row.calls as number, elapsedMs: row.elapsed_ms as number }] : [];
    });
    return { stages, jsonCalls: Number.isSafeInteger(rawApi.json_calls) && (rawApi.json_calls as number) >= 0
      ? rawApi.json_calls as number : routes.reduce((sum, row) => sum + row.calls, 0),
      rateLimiterCalls: rawApi.calls as number, rateWaitMs: rawApi.wait_ms as number, routes };
  } catch { return null; }
}
function validId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('Project 工作项 ID 无效');
  return value;
}
function reportTitle(item: RecordValue, id: string): string {
  for (const value of [item.name, item.description]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return `未填写名称（飞书任务 ${id}）`;
}
function workItemTimestamp(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1_000_000_000_000 || (value as number) >= 10_000_000_000_000) {
    throw new Error(`Project ${field}无效`);
  }
  return new Date(value as number).toISOString();
}
function searchSubtaskFinishedAt(value: unknown): string | null {
  // The collector has already converted timezone-aware values to epoch millis.
  // Rendering another timezone must not change the absolute completion instant.
  return workItemTimestamp(value, '子任务完成时间');
}
function verifiedUrl(value: unknown, id: string, workItemType?: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Project 链接结构无效');
  const url = new URL(value);
  const subtaskDeepLink = workItemType === 'sub_task'
    && /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/detail\/[1-9]\d*$/.test(url.pathname)
    && url.searchParams.get('subTaskId') === id;
  if (url.protocol !== 'https:' || url.hostname !== 'project.feishu.cn' || url.username || url.password || url.port
    || (!subtaskDeepLink && url.pathname.split('/').at(-1) !== id)) {
    throw new Error('Project 链接未通过核验');
  }
  return url.toString();
}
function linkedTaskIds(item: RecordValue): string[] {
  const ids = new Set<string>();
  if (typeof item.local_task_id === 'string' && item.local_task_id) ids.add(item.local_task_id);
  if (Array.isArray(item.local_tasks)) {
    for (const value of item.local_tasks) {
      const task = record(value);
      if (typeof task.task_id === 'string' && task.task_id) ids.add(task.task_id);
    }
  }
  return [...ids];
}

export function parseResponsibilityReport(raw: unknown, expected: ExpectedIdentity): WorkspaceResponsibilitySnapshot {
  const report = record(raw);
  const integrity = record(report.integrity);
  if (report.report_kind !== 'project_responsibility' ||
    (report.todo_equivalent !== undefined && report.todo_equivalent !== false) ||
    typeof report.complete !== 'boolean' || report.source_user_key !== expected.userKey ||
    integrity.source_ids_exactly_once !== true || integrity.retrieval_complete !== true ||
    typeof integrity.classification_complete !== 'boolean' ||
    report.complete !== integrity.classification_complete || integrity.source_complete !== true ||
    integrity.workbench_projection_complete !== true) {
    throw new Error('Project 责任报表口径、身份或完整性校验失败');
  }
  if (typeof report.generated_at !== 'string' || !Number.isFinite(Date.parse(report.generated_at))) {
    throw new Error('Project 责任报表生成时间无效');
  }
  if (typeof report.report_id !== 'string' || !report.report_id) throw new Error('Project 责任报表 ID 缺失');
  if (report.unverified_items !== undefined && !Array.isArray(report.unverified_items)) {
    throw new Error('Project 待核实事项结构无效');
  }
  const unverifiedCount = Array.isArray(report.unverified_items) ? report.unverified_items.length : undefined;
  if (unverifiedCount !== undefined && (report.complete !== (unverifiedCount === 0)
    || integrity.unverified_count !== undefined && integrity.unverified_count !== unverifiedCount)) {
    throw new Error('Project 待核实数量与分类完整性不一致');
  }
  if (!Array.isArray(report.items) || !Array.isArray(report.business_items) || !Array.isArray(report.workbench_items)) throw new Error('Project 责任事项结构无效');
  const workbenchParentIds = new Set<string>();
  const workbenchItems: WorkbenchItem[] = report.workbench_items.map((value) => {
    const item = record(value);
    const id = validId(item.work_item_id);
    if (workbenchParentIds.has(id)) throw new Error('Project 工作台父项 ID 重复');
    workbenchParentIds.add(id);
    if (item.project_key !== expected.projectKey) throw new Error('Project 工作台父项空间不匹配');
    if (typeof item.work_item_type !== 'string' || !item.work_item_type) {
      throw new Error('Project 工作台父项类型无效');
    }
    const owner = item.owner_user_key;
    if (owner !== null && (typeof owner !== 'string' || !owner)) throw new Error('Project 工作台负责人无效');
    const roleOwners = item.role_owner_user_keys ?? [];
    if (!Array.isArray(roleOwners) || !roleOwners.every((key) => typeof key === 'string' && key.trim())) {
      throw new Error('Project 工作台角色负责人无效');
    }
    const status = record(item.work_item_status);
    if (status.state_key !== null && status.state_key !== undefined && typeof status.state_key !== 'string') throw new Error('Project 工作台状态无效');
    if (status.is_archived_state !== null && status.is_archived_state !== undefined && typeof status.is_archived_state !== 'boolean') throw new Error('Project 工作台归档状态无效');
    if (item.flow_finished !== undefined && item.flow_finished !== null && typeof item.flow_finished !== 'boolean') throw new Error('Project 工作台流程结束标记无效');
    if (item.current_node_names !== undefined && (!Array.isArray(item.current_node_names)
      || !item.current_node_names.every((name: unknown) => typeof name === 'string' && name.trim()))) throw new Error('Project 工作台当前节点名称无效');
    if (item.current_nodes !== undefined && !Array.isArray(item.current_nodes)) throw new Error('Project 工作台当前节点负责人结构无效');
    const currentNodes = (item.current_nodes as unknown[] | undefined)?.map((value) => {
      const node = record(value);
      if (typeof node.name !== 'string' || !node.name.trim() || !Array.isArray(node.owner_names)
        || !node.owner_names.every((name: unknown) => typeof name === 'string' && name.trim())) {
        throw new Error('Project 工作台当前节点负责人无效');
      }
      return { name: node.name.trim(), ownerNames: node.owner_names as string[] };
    });
    if (currentNodes && currentNodes.map((node) => node.name).join('\u0000') !== (item.current_node_names as string[] ?? []).join('\u0000'))
      throw new Error('Project 工作台当前节点与负责人不一致');
    if (item.my_nodes !== undefined && !Array.isArray(item.my_nodes)) throw new Error('Project 工作台本人节点结构无效');
    const nodeIds = new Set<string>();
    const myNodes = (item.my_nodes as unknown[] | undefined ?? []).map((value) => {
      const node = record(value);
      if (typeof node.id !== 'string' || !node.id || nodeIds.has(node.id)
        || (node.name !== null && node.name !== undefined && (typeof node.name !== 'string' || !node.name.trim()))
        || (node.owner_count !== undefined && (!Number.isInteger(node.owner_count) || (node.owner_count as number) < 1))) {
        throw new Error('Project 工作台本人节点无效');
      }
      nodeIds.add(node.id);
      return { id: node.id, name: typeof node.name === 'string' ? node.name : null,
        phase: ({ 1: 'upcoming', 2: 'current', 3: 'completed' } as const)[node.status as 1 | 2 | 3] ?? 'unknown',
        ownerCount: typeof node.owner_count === 'number' ? node.owner_count : null };
    });
    if (!Array.isArray(item.my_subtasks)) throw new Error('Project 工作台子任务结构无效');
    const childIds = new Set<string>();
    const children = item.my_subtasks.map((value) => {
      const child = record(value);
      const childId = validId(child.id);
      if (childIds.has(childId)) throw new Error('Project 工作台子任务 ID 重复');
      childIds.add(childId);
      if (!Array.isArray(child.owners) ||
        !child.owners.includes(expected.userKey) || !child.owners.every((key) => typeof key === 'string' && key) ||
        typeof child.passed !== 'boolean' || typeof child.node_id !== 'string' || !child.node_id ||
        (child.node_name !== undefined && child.node_name !== null && (typeof child.node_name !== 'string' || !child.node_name.trim())) ||
        !['current', 'upcoming', 'completed', 'unknown'].includes(String(child.phase))) {
        throw new Error('Project 工作台子任务责任或状态无效');
      }
      return { id: childId, title: reportTitle(child, childId), owners: child.owners as string[], passed: child.passed,
        finishedAt: searchSubtaskFinishedAt(child.finished_at),
        nodeId: child.node_id, nodeName: typeof child.node_name === 'string' ? child.node_name : null,
        phase: child.phase as WorkbenchItem['mySubtasks'][number]['phase'] };
    });
    if (owner !== expected.userKey && !roleOwners.includes(expected.userKey) && children.length === 0 && myNodes.length === 0) throw new Error('Project 工作台父项缺少本人责任');
    return { workItemId: id, title: reportTitle(item, id), typeName: typeof item.type_name === 'string' ? item.type_name : null,
      roleOwnerUserKeys: [...new Set(roleOwners as string[])],
      updatedAt: workItemTimestamp(item.updated_at, '工作项更新时间'),
      finishedAt: workItemTimestamp(item.finished_at, '工作项结束时间'),
      url: verifiedUrl(item.work_item_url, id, item.work_item_type), ownerUserKey: owner as string | null,
      stateKey: typeof status.state_key === 'string' ? status.state_key : null,
      isArchivedState: typeof status.is_archived_state === 'boolean' ? status.is_archived_state : null,
      flowFinished: typeof item.flow_finished === 'boolean' ? item.flow_finished : null,
      currentNodeNames: Array.isArray(item.current_node_names) ? item.current_node_names as string[] : [],
      ...(currentNodes === undefined ? {} : { currentNodes }),
      myNodes,
      mySubtasks: children };
  });
  const childLinks = new Map<string, string | null>();
  for (const parent of workbenchItems) {
    if (!parent.url) continue;
    for (const child of parent.mySubtasks) {
      if (!child.nodeId) continue;
      const url = new URL(parent.url);
      url.searchParams.set('activeStateId', child.nodeId);
      url.searchParams.set('subTaskId', child.id);
      const previous = childLinks.get(child.id);
      // Conflicting parent relationships are not evidence for choosing a URL.
      childLinks.set(child.id, previous === undefined || previous === url.toString() ? url.toString() : null);
    }
  }
  const reportedUrl = (item: RecordValue, id: string) => {
    const derived = childLinks.get(id);
    const supplied = verifiedUrl(item.work_item_url, id, derived ? 'sub_task' : item.work_item_type);
    return derived ?? supplied;
  };
  const associations = new Map<string, Set<string>>();
  const localAssociated: LocalAssociatedItem[] = [];
  for (const [index, value] of report.business_items.entries()) {
    const item = record(value);
    const id = validId(item.work_item_id);
    if (item.project_key !== expected.projectKey) throw new Error('Project 责任事项空间不匹配');
    const set = associations.get(id) ?? new Set<string>();
    const rowTaskIds = linkedTaskIds(item);
    for (const taskId of rowTaskIds) set.add(taskId);
    associations.set(id, set);
    if (item.actionability === 'local_associated') {
      localAssociated.push({ associationKey: `${id}:${index}`, workItemId: id, title: reportTitle(item, id), url: reportedUrl(item, id), localTaskIds: rowTaskIds });
    }
  }
  const seen = new Set<string>();
  const items: ResponsibilityItem[] = report.items.map((value) => {
    const item = record(value);
    const id = validId(item.work_item_id);
    if (seen.has(id)) throw new Error('Project 责任事项 ID 重复');
    seen.add(id);
    if (item.project_key !== expected.projectKey) throw new Error('Project 责任事项空间不匹配');
    if (item.actionability !== 'current' && item.actionability !== 'state_responsibility' && item.actionability !== 'upcoming') {
      throw new Error('Project 责任分类无效');
    }
    const subtasks = Array.isArray(item.personal_subtasks) ? item.personal_subtasks : [];
    const nodes = [...(Array.isArray(item.personal_nodes) ? item.personal_nodes : []), ...(Array.isArray(item.shared_nodes) ? item.shared_nodes : [])];
    const release = item.release && typeof item.release === 'object' ? record(item.release) : {};
    const linkedStoryIds = item.linked_story_ids == null ? [] : item.linked_story_ids;
    if (!Array.isArray(linkedStoryIds) || linkedStoryIds.some((storyId) => typeof storyId !== 'string' || !/^[1-9]\d*$/.test(storyId))
      || new Set(linkedStoryIds).size !== linkedStoryIds.length) throw new Error('Project 关联需求 ID 无效');
    let fallbackContact: ResponsibilityItem['fallbackContact'];
    if (item.fallback_contact !== undefined) {
      const contact = record(item.fallback_contact);
      if ((contact.role !== 'reporter' && contact.role !== 'creator') || !Array.isArray(contact.names)
        || contact.names.length === 0 || !contact.names.every((name) => typeof name === 'string' && name.trim())) {
        throw new Error('Project 报告人或创建人无效');
      }
      fallbackContact = { role: contact.role, names: contact.names as string[] };
    }
    return {
      workItemId: id, title: reportTitle(item, id), typeName: typeof item.type_name === 'string' ? item.type_name : null,
      actionability: item.actionability,
      ...(fallbackContact ? { fallbackContact } : {}),
      statusName: typeof item.status_name === 'string' && item.status_name.trim() ? item.status_name.trim() : null,
      ...(Array.isArray(item.my_role_keys) && item.my_role_keys.every((role) => typeof role === 'string' && role.length > 0)
        ? { myRoleKeys: item.my_role_keys as string[] } : {}),
      ...(typeof item.base_owner_is_me === 'boolean' ? { baseOwnerIsMe: item.base_owner_is_me } : {}),
      updatedAt: workItemTimestamp(item.updated_at, '工作项更新时间'),
      personalSubtasks: subtasks.map((value) => {
        const task = record(value);
        const taskId = validId(task.id);
        return { id: taskId, name: reportTitle(task, taskId), passed: task.passed === true };
      }),
      currentNodes: nodes.map((value) => record(value)).filter((node) => node.status === 2 && typeof node.name === 'string').map((node) => String(node.name)),
      version: typeof release.effective_version === 'string' ? release.effective_version : null,
      url: reportedUrl(item, id),
      localTaskIds: [...(associations.get(id) ?? [])],
      linkedStoryIds: linkedStoryIds as string[],
    };
  });
  const counts = {
    current: items.filter((item) => item.actionability === 'current').length,
    stateResponsibility: items.filter((item) => item.actionability === 'state_responsibility').length,
    upcoming: items.filter((item) => item.actionability === 'upcoming').length,
  };
  return {
    reportKind: 'project_responsibility', sourceUserKey: expected.userKey, todoEquivalent: false,
    generatedAt: report.generated_at, fetchedAt: 0, servedFromCache: false, complete: report.complete,
    ...(unverifiedCount !== undefined ? { unverifiedCount } : {}),
    stale: false, error: null, items, workbenchItems, localAssociated, counts,
  };
}

export interface ResponsibilityReportSourceOptions {
  workspaceRoot?: string;
  expected?: ExpectedIdentity;
  now?: () => number;
  runner?: (args: string[], cwd: string) => Promise<string>;
  diagnostic?: (event: { phase: string; elapsedMs: number; outcome: 'ok' | 'error' }) => void;
}
export class ResponsibilityReportSource{
  protected readonly workspaceRoot:string;protected readonly now:()=>number;
  protected readonly runner:(args:string[],cwd:string)=>Promise<string>;
  protected readonly diagnostic:NonNullable<ResponsibilityReportSourceOptions['diagnostic']>;
  protected readonly expected?:ExpectedIdentity;
  private readonly legacyRunner: boolean;
  constructor(options: ResponsibilityReportSourceOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? FIXED_WORKSPACE_PATH;
    this.now = options.now ?? Date.now;
    this.expected = options.expected;
    this.legacyRunner = !!options.runner;
    this.diagnostic = options.diagnostic ?? (options.runner ? () => {} : (event) => {
      console.info(`[WorkspaceResponsibility] phase=${event.phase} elapsed_ms=${event.elapsedMs} outcome=${event.outcome}`);
    });
    // Kept only for existing offline report fixtures; production always uses Relay's integration.
    this.runner = options.runner ?? (async () => { throw new Error('LEGACY_REPORT_RUNNER_REQUIRED'); });
  }

  protected async measure<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let outcome: 'ok' | 'error' = 'error';
    try {
      const result = await operation();
      outcome = 'ok';
      return result;
    } finally {
      try { this.diagnostic({ phase, elapsedMs: Math.round(performance.now() - started), outcome }); }
      catch { /* Diagnostics must not change the report result. */ }
    }
  }

  protected async load(expected: ExpectedIdentity): Promise<WorkspaceResponsibilitySnapshot> {
    if (!this.legacyRunner) {
      const { FeishuWorkbenchSource } = await import('./feishu-source.js');
      return new FeishuWorkbenchSource().loadFresh(expected);
    }
    return this.measure('total', async () => {
      const output = path.join(this.workspaceRoot, '.tmp', 'todo-reports', `todo-report-${randomUUID()}.json`);
      await mkdir(path.dirname(output), { recursive: true });
      const stdout = await this.measure('report', () => this.runner(['todo-report', '--output', output], this.workspaceRoot));
      const profile = parseReportProfile(stdout);
      if (profile) {
        console.info(`[WorkspaceResponsibility] profile=${JSON.stringify(profile)}`);
      }
      const { raw, snapshot } = await this.measure('parse', async () => {
        const raw = JSON.parse(await readFile(output, 'utf8')) as RecordValue;
        return { raw, snapshot: parseResponsibilityReport(raw, expected) };
      });
      await this.measure('cleanup', () => this.runner(['cleanup-todo-report', '--output', output, '--report-id', String(raw.report_id)], this.workspaceRoot));
      return { ...snapshot, fetchedAt: this.now() };
    });
  }

  /** Candidate adapter entry: obtain only identity metadata, without consulting legacy snapshot storage. */
  readIdentity():Promise<ExpectedIdentity>{return this.identity();}
  async loadFresh(expected:ExpectedIdentity):Promise<WorkspaceResponsibilitySnapshot>{
    const same=(value:ExpectedIdentity)=>value.projectKey===expected.projectKey&&value.userKey===expected.userKey;
    if(!same(await this.identity()))throw new Error('RESPONSIBILITY_IDENTITY_CHANGED');
    const result=await this.load(expected);if(!same(await this.identity()))throw new Error('RESPONSIBILITY_IDENTITY_CHANGED');return result;
  }

  protected async identity(): Promise<ExpectedIdentity> {
    if (this.expected) return { ...this.expected };
    const { FeishuWorkbenchSource } = await import('./feishu-source.js');
    return new FeishuWorkbenchSource().readIdentity();
  }

}
