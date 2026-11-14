import fs from 'node:fs/promises';
import path from 'node:path';
import { requireWorkspaceRoot } from './workspace-config.js';

export interface TaskRegistryTask {
  id: string;
  title: string | null;
  description: string | null;
  taskPath: string | null;
  taskDocumentPath: string | null;
  status: string | null;
  horizon: string | null;
  nextAction: string | null;
  waitingOn: string | null;
  statusBasis: string | null;
  verification: string | null;
  lastVerifiedAt: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  deliveryMatrix?: DeliveryMatrixItem[];
  feishuWorkItemIds: string[];
  feishuWorkItemUrls?: Record<string, string>;
}

export interface DeliveryMatrixItem {
  project: string;
  baseBranch: string | null;
  featureBranch: string | null;
  targetBranch: string | null;
  revision: string | null;
  source: string;
  verifiedAt: string;
}

export interface TaskRegistryProjection {
  schemaVersion: number | null;
  generatedAt: string | null;
  tasks: TaskRegistryTask[];
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : value == null ? null : String(value);
}

function feishuIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number').map(String);
}

function feishuUrls(value: unknown, ids: string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const urls: Record<string, string> = {};
  for (const id of ids) {
    const raw = (value as Record<string, unknown>)[id];
    if (typeof raw !== 'string') continue;
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' && url.hostname === 'project.feishu.cn' && url.pathname.split('/').at(-1) === id) urls[id] = url.toString();
    } catch { /* Ignore malformed registry links. */ }
  }
  return urls;
}

async function readGuideFeishuUrls(documentPath: string | null, ids: string[]): Promise<Record<string, string>> {
  if (!documentPath || !ids.length) return {};
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(documentPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    const candidates: Record<string, string> = {};
    for (const match of text.matchAll(/https:\/\/project\.feishu\.cn\/[A-Za-z0-9_/?=&%.-]+/g)) {
      const url = new URL(match[0]);
      const id = url.pathname.split('/').at(-1);
      if (id && ids.includes(id) && !candidates[id]) candidates[id] = url.toString();
    }
    return feishuUrls(candidates, ids);
  } catch { return {}; }
  finally { await handle?.close(); }
}

async function readTaskDocumentPath(root: string, taskPath: string | null): Promise<string | null> {
  if (!taskPath) return null;
  const rootResolved = path.resolve(root);
  const taskRoot = path.resolve(rootResolved, taskPath);
  if (!taskRoot.toLowerCase().startsWith(`${rootResolved.toLowerCase()}${path.sep}`)) return null;
  for (const filename of ['README.md', 'TASK.md', 'task.md', '任务说明.md']) {
    try {
      const candidate = await fs.realpath(path.join(taskRoot, filename));
      if (!candidate.toLowerCase().startsWith(`${taskRoot.toLowerCase()}${path.sep}`)) continue;
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch { /* Missing or unreadable guide: try the next conventional filename. */ }
  }
  return null;
}

async function readTaskOverview(documentPath: string | null): Promise<{ title: string | null; description: string | null }> {
  if (!documentPath) return { title: null, description: null };
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(documentPath, 'r');
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/).map((line) => line.trim());
    const clean = (value: string) => value.replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim().slice(0, 240);
    const named = lines.map((line) => line.match(/^[-*]?\s*任务名称[：:]\s*(.+)$/)?.[1]).find(Boolean);
    const heading = lines.map((line) => line.match(/^#\s+(.+)$/)?.[1]).find((line) => line && /[\u3400-\u9fff]/.test(line));
    const explicitGoal = lines.map((line) => line.match(/^[-*]?\s*(?:任务目标|任务说明|目标|需求)[：:]\s*(.+)$/)?.[1]).find(Boolean);
    const scopeHeading = lines.findIndex((line) => /^#{2,3}\s*(?:修复范围|任务目标|目标|需求范围|本期范围|需求|概述|任务说明)(?:\s|$)/.test(line));
    const scopeEnd = lines.findIndex((line, index) => index > scopeHeading && /^#{2,3}\s/.test(line));
    const scope = scopeHeading < 0 ? null : lines.slice(scopeHeading + 1, scopeEnd < 0 ? undefined : scopeEnd).find((line) => line && !line.startsWith('#') && !/^[-*]\s*(?:正式项目|目标项目|模块|飞书任务)[：:]/.test(line));
    const introEnd = lines.findIndex((line, index) => index > 0 && /^#{2,3}\s/.test(line));
    const intro = lines.slice(1, introEnd < 0 ? undefined : introEnd).find((line) => line && !line.startsWith('#') && !/^[-*]\s*(?:任务名称|任务状态|当前进度|飞书任务)[：:]/.test(line));
    return { title: named ? clean(named) : heading ? clean(heading) : null,
      description: explicitGoal ? clean(explicitGoal) : scope ? clean(scope.replace(/^[-*]\s*/, '')) : intro ? clean(intro.replace(/^[-*]\s*/, '')) : null };
  } catch { return { title: null, description: null }; }
  finally { await handle?.close(); }
}

async function readDeliveryMatrix(root: string, taskPath: string | null): Promise<DeliveryMatrixItem[]> {
  if (!taskPath) return [];
  const taskRoot = path.resolve(root, taskPath);
  const rootResolved = path.resolve(root);
  const matrixPath = path.join(taskRoot, 'project-results', 'delivery-matrix.json');
  if (!matrixPath.toLowerCase().startsWith(`${taskRoot.toLowerCase()}${path.sep}`)) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(matrixPath, 'utf8')); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== 1 || !Array.isArray(record.projects)) return [];
  const items: DeliveryMatrixItem[] = [];
  for (const value of record.projects) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const project = typeof item.project === 'string' ? item.project.trim() : '';
    const source = typeof item.source === 'string' ? item.source.trim() : '';
    const verifiedAt = typeof item.verified_at === 'string' ? item.verified_at : '';
    if (!project || !source || !verifiedAt || !/[+-]\d\d:\d\d$/.test(verifiedAt)) continue;
    const resolvedSource = path.resolve(rootResolved, source);
    if (!resolvedSource.toLowerCase().startsWith(`${taskRoot.toLowerCase()}${path.sep}`)) continue;
    try { await fs.access(resolvedSource); } catch { continue; }
    const optional = (key: string) => typeof item[key] === 'string' ? String(item[key]) : null;
    items.push({ project, baseBranch: optional('base_branch'), featureBranch: optional('feature_branch'), targetBranch: optional('target_branch'), revision: optional('revision'), source, verifiedAt });
  }
  return items;
}

export async function readTaskRegistry(root: string): Promise<TaskRegistryProjection> {
  requireWorkspaceRoot(root);
  const filename = path.join(root, 'tasks', 'task-registry.json');
  let text: string;
  try {
    text = await fs.readFile(filename, 'utf8');
  } catch (error) {
    throw new Error(`无法读取 task-registry.json：${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`task-registry.json invalid JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('task-registry.json 根对象无效');
  const record = raw as Record<string, unknown>;
  const sourceTasks = record.tasks;
  if (!sourceTasks || typeof sourceTasks !== 'object' || Array.isArray(sourceTasks)) throw new Error('task-registry.json 缺少 tasks');
  const tasks = await Promise.all(Object.entries(sourceTasks as Record<string, unknown>).map(async ([id, value]) => {
    const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const taskPath = optionalString(item.task_path);
    const taskDocumentPath = await readTaskDocumentPath(root, taskPath);
    const overview = await readTaskOverview(taskDocumentPath);
    const registryTitle = optionalString(item.title);
    const feishuWorkItemIds = feishuIds(item.feishu_work_item_ids);
    return {
      id,
      title: registryTitle && /[\u3400-\u9fff]/.test(registryTitle) ? registryTitle : overview.title || registryTitle,
      description: overview.description,
      taskPath,
      taskDocumentPath,
      status: optionalString(item.status),
      horizon: optionalString(item.horizon),
      nextAction: optionalString(item.next_action),
      waitingOn: optionalString(item.waiting_on),
      statusBasis: optionalString(item.status_basis),
      verification: optionalString(item.verification),
      lastVerifiedAt: optionalString(item.last_verified_at),
      startedAt: optionalString(item.started_at),
      completedAt: optionalString(item.completed_at),
      deliveryMatrix: await readDeliveryMatrix(root, optionalString(item.task_path)),
      feishuWorkItemIds,
      feishuWorkItemUrls: { ...await readGuideFeishuUrls(taskDocumentPath, feishuWorkItemIds), ...feishuUrls(item.feishu_work_item_urls, feishuWorkItemIds) },
    } satisfies TaskRegistryTask;
  }));
  return {
    schemaVersion: typeof record.schema_version === 'number' ? record.schema_version : null,
    generatedAt: optionalString(record.generated_at),
    tasks,
  };
}
