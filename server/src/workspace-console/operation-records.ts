import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Actor } from '../auth/authorization.js';
import { WorkspaceOperationRecordsDtoSchema } from '../contracts/dto.js';
import { ServiceError } from '../services/errors.js';
import { projectPythonExecutable } from './responsibility-report-source.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
import { requireWorkspaceFile } from './workspace-config.js';

const execFileAsync = promisify(execFile);
const skillPath = path.join(FIXED_WORKSPACE_PATH, 'ai', 'skills', 'operate-feishu-project-openapi');
const scriptPath = fileURLToPath(new URL('../../scripts/feishu-operation-records.py', import.meta.url));
const pageSchema = z.object({ events: z.array(z.object({ at: z.number().int().nonnegative(), module: z.string(),
  operation: z.string(), childId: z.string().nullable(), property: z.string().nullable() }).strict()).max(1000),
  hasMore: z.boolean(), cursor: z.string().nullable() }).strict();
type RawPage = z.infer<typeof pageSchema>;
export type OperationRecords = z.infer<typeof WorkspaceOperationRecordsDtoSchema>;

const validId = (value: string) => /^[1-9]\d{9,18}$/.test(value);
const label = (event: RawPage['events'][number]): string => {
  if (event.module === 'sub_task_mod') {
    if (event.operation === 'complete') return '完成子任务';
    if (event.operation === 'create') return '创建子任务';
    if (event.property === 'schedule') return '修改子任务排期';
    if (event.property === 'owners') return '修改子任务负责人';
    if (event.property === 'estimate') return '修改子任务预估';
    return '修改子任务';
  }
  if (event.module === 'node_mod') return event.operation === 'complete' ? '完成流程节点'
    : event.property === 'owners' ? '调整节点负责人' : '调整流程节点';
  if (event.module === 'field_mod') return event.property === 'workitem_status' ? '更新状态字段' : '修改工作项字段';
  if (event.module === 'work_item_mod') return event.operation === 'create' ? '创建工作项'
    : event.property === 'workitem_status' ? '调整工作项状态' : '修改工作项';
  return '更新工作项';
};

type Runner = (args: string[]) => Promise<RawPage>;
async function defaultRunner(args: string[]): Promise<RawPage> {
  const executable = requireWorkspaceFile(FIXED_WORKSPACE_PATH, path.relative(FIXED_WORKSPACE_PATH, projectPythonExecutable(FIXED_WORKSPACE_PATH)));
  requireWorkspaceFile(FIXED_WORKSPACE_PATH, 'ai', 'skills', 'operate-feishu-project-openapi', 'config', 'feishu-project-openapi.local.json');
  const { stdout } = await execFileAsync(executable, [scriptPath, '--skill', skillPath, ...args],
    { timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true });
  return pageSchema.parse(JSON.parse(stdout));
}

export class OperationRecordsService {
  private readonly cache = new Map<string, { at: number; value: OperationRecords }>();
  private readonly pending = new Map<string, Promise<OperationRecords>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private nextRequestAt = 0;

  constructor(private readonly runner: Runner = defaultRunner, private readonly now: () => number = Date.now,
    private readonly intervalMs = 500) {}

  private async acquire(): Promise<void> {
    if (this.active >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    const delay = Math.max(0, this.nextRequestAt - this.now());
    this.nextRequestAt = this.now() + delay + this.intervalMs;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  async get(actor: Actor, parentId: string, anchor: string, cursor: string | null = null, force = false): Promise<OperationRecords> {
    if (actor.role !== 'admin') throw new ServiceError(403, '仅管理员可以查看飞书操作记录', 'WORKSPACE_CONSOLE_FORBIDDEN');
    const anchorTime = Date.parse(anchor);
    if (!validId(parentId) || !Number.isFinite(anchorTime) || anchorTime < Date.parse('2020-01-01') || anchorTime > this.now() + 60_000 ||
      (cursor !== null && (cursor.length > 256 || !/^[A-Za-z0-9_+=/-]+$/.test(cursor))))
      throw new ServiceError(400, '操作记录查询参数无效', 'WORKSPACE_OPERATION_INVALID');
    const start = Math.max(0, anchorTime - 30 * 86_400_000);
    const end = anchorTime + 86_400_000;
    const key = `${actor.userId}:${parentId}:${start}:${cursor ?? ''}`;
    const cached = this.cache.get(key);
    if (!force && cached && this.now() - cached.at < 10 * 60_000) return cached.value;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const request = (async () => {
      await this.acquire();
      try {
        const args = ['--parent', parentId, '--start', String(start), '--end', String(end)];
        if (cursor) args.push('--cursor', cursor);
        const page = pageSchema.parse(await this.runner(args));
        const projected = page.events.map((event) => ({ at: new Date(event.at).toISOString(),
          childId: event.childId, label: label(event) }));
        const seen = new Set<string>();
        const events = projected.filter((event) => {
          const key = `${event.at}:${event.childId ?? ''}:${event.label}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const value = WorkspaceOperationRecordsDtoSchema.parse({ parentId, rangeStart: new Date(start).toISOString(),
          rangeEnd: new Date(end).toISOString(),
          hasMore: page.hasMore, cursor: page.cursor, events });
        this.cache.set(key, { at: this.now(), value });
        if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
        return value;
      } finally { this.release(); }
    })().finally(() => { this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }
}
