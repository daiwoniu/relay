import path from 'node:path';
import { readWorkspaceFile } from './workspace-files.js';
import type { WorkspaceRunProjection } from './run-projection.js';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 240) : '';
const objectName = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value) ? value : null;

/** Read only bounded evidence within this task; no shell execution or command projection. */
export async function readRunOperation(root: string, taskId: string, record: Row, mode: string | null): Promise<WorkspaceRunProjection['operation']> {
  const taskDir = path.resolve(root, 'tasks', taskId);
  const read = async (value: unknown) => {
    if (typeof value !== 'string') throw new Error('No evidence path');
    const filename = path.resolve(root, value);
    if (!filename.toLowerCase().startsWith(`${taskDir.toLowerCase()}${path.sep}`) || !filename.endsWith('.json')) throw new Error('Invalid evidence path');
    return row(JSON.parse(await readWorkspaceFile(root, filename, 256 * 1024)));
  };
  const descriptor = row(record.operation);
  if (typeof descriptor.title === 'string' && descriptor.title.trim()) return {
    title: text(descriptor.title), objects: Array.isArray(descriptor.objects) ? descriptor.objects.map(objectName).filter((value): value is string => !!value).slice(0,50) : [],
    scope: Array.isArray(descriptor.scope) ? descriptor.scope.filter((value): value is string => typeof value === 'string').slice(0,50).map(text) : [],
    source: 'descriptor', plannedBusinessWrite: typeof descriptor.business_write === 'boolean' ? descriptor.business_write : null,
  };
  try {
    const manifest = await read(record.manifest_path ?? record.manifest);
    const configuredCommand=mode==='execute'?manifest.execute_command:mode==='dry-run'?manifest.dry_run_command:null;
    const command = typeof record.raw_command === 'string' ? record.raw_command : typeof configuredCommand === 'string' ? configuredCommand : '';
    const match = /(?:^|\s)--plan\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command);
    const planPath = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!planPath || !Array.isArray(manifest.include_paths) || !manifest.include_paths.includes(planPath)) throw new Error('Unverified plan');
    const plan = await read(planPath);
    const tables = Array.isArray(plan.tables) ? plan.tables.map(row) : [];
    if (!tables.length || tables.length > 50) throw new Error('Invalid plan');
    const objects = tables.map(table => objectName(table.table));
    if (objects.some(name => !name)) throw new Error('Invalid table');
    const recovery = typeof plan.basis_run_id === 'string';
    const scope = tables.map(table => `${table.table}：ID ${Number.isSafeInteger(table.start_id)?table.start_id:'未注明'} → ${Number.isSafeInteger(table.end_id)?table.end_id:'未注明'}`);
    if (Number.isSafeInteger(plan.parallelism)) scope.unshift(`计划并发 ${plan.parallelism}`);
    const historical=record.task_name==='judicial-history-full-scan';
    return { title: `${historical?'历史数据':'数据'}${recovery?'续扫':historical?'全量扫描':'范围扫描'} · ${tables.length} 张表`, objects: objects as string[], scope, source:'plan', plannedBusinessWrite: typeof plan.business_write==='boolean'?plan.business_write:null };
  } catch { /* Legacy runs may not carry a safe, explicit plan. */ }
  const fingerprints = row(record.fingerprints);
  for (const filename of Object.keys(fingerprints).filter(name=>name.replaceAll('\\','/').endsWith('/execution-intent.json')).slice(0,1)) {
    try {
      const intent = await read(filename);
      const source = objectName(intent.source_table), stage = objectName(intent.stage_table);
      if (!source) continue;
      const title=source==='auction.ds_judgment_attachment_text'?'附件文书修复':'数据修复';
      return {title: `${title}${mode==='dry-run'?'预检':mode==='execute'?'写入':'（阶段未注明）'}`,objects:[source,...(stage?[stage]:[])],scope:[`源表 ${source}`,...(stage?[`目标表 ${stage}`]:[])],source:'intent',plannedBusinessWrite:mode==='dry-run'?false:null};
    } catch { /* Optional legacy evidence cannot invalidate the execution. */ }
  }
  return null;
}
