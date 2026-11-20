import { createHash } from 'node:crypto';
import type { WorkspaceResponsibilitySnapshot, WorkbenchItem } from './responsibility-report-source.js';
import type { TaskRegistryProjection } from './task-registry-reader.js';
import { configuredFeishuClient } from '../integrations/feishu/connection.js';
import { hydrateFactNames, needsFlowRoleDefinitions, projectResponsibility } from '../integrations/feishu/responsibility.js';
import { projectFeishuSnapshot } from './feishu-source.js';
import type { FeishuProjectClient, FlowRoleDefinition, Row } from '../integrations/feishu/client.js';
import { taskRegistryResponsibilityRoles } from './task-registry-adapter.js';
import { parseFeishuTarget } from './task-reference.js';
import { enrichRegistryItems } from './task-registry-enrichment.js';

/** Adapter associations never enter the pure provider cache. Empty connection binding is disabled. */
export class TaskRegistryComposition {
  private cached: { key: string; value: WorkspaceResponsibilitySnapshot } | null = null;
  private detailCached: { key: string; value: WorkspaceResponsibilitySnapshot } | null = null;
  private readonly pending = new Map<string, Promise<WorkspaceResponsibilitySnapshot>>();
  constructor(private readonly registry: () => Promise<TaskRegistryProjection>, private readonly options: Record<string, string>,
    private readonly connection: () => FeishuProjectClient = configuredFeishuClient, private readonly connectionId = '') {}
  async verifyTarget(reference: string): Promise<boolean> {
    const target = parseFeishuTarget(reference); if (!target) return false;
    try {
      const client = this.connection(), types = (await client.catalog()).map(row => String(row.type_key)).filter(type => type !== 'sub_task');
      const type = (await client.discover([target.parentId], types)).get(target.parentId)!;
      await client.details(type, [target.parentId]);
      if (target.kind === 'work_item') return true;
      return (await client.subtasks(type, target.parentId)).some(group => Array.isArray(group.sub_tasks) && group.sub_tasks.some((task: Row) => String(task.id) === target.id));
    } catch { return false; }
  }
  async compose(source: WorkspaceResponsibilitySnapshot, selectedTaskId?: string): Promise<WorkspaceResponsibilitySnapshot> {
    const isolated = (state: 'unbound' | 'unavailable', error: string | null): WorkspaceResponsibilitySnapshot => ({ ...source,
      items: source.items.map(item => ({ ...item, localTaskIds: [] })),
      workbenchItems: source.workbenchItems.map(item => ({ ...item, localTaskIds: [], mySubtasks: item.mySubtasks.map(child => ({ ...child, localTaskIds: [] })) })),
      localAssociated: [], associationMeta: { state, error, checkedAt: null } });
    if (!this.connectionId) return isolated('unbound', null);
    let registry: TaskRegistryProjection, client: FeishuProjectClient;
    try {
      client = this.connection();
      if (client.config.connectionId !== this.connectionId || source.sourceUserKey !== client.config.userKey || source.sourceProjectKey && source.sourceProjectKey !== client.config.projectKey) return isolated('unavailable', '台账绑定与飞书数据来源不匹配');
      registry = await this.registry();
    } catch { return isolated('unavailable', '本地台账或飞书绑定读取失败'); }
    const key = createHash('sha256').update(JSON.stringify([client.config.scope, source.fetchedAt, source.items, source.workbenchItems, registry, this.options, selectedTaskId])).digest('hex');
    const merge = (value: WorkspaceResponsibilitySnapshot) => ({ ...source, items: value.items, workbenchItems: value.workbenchItems, localAssociated: value.localAssociated, associationMeta: value.associationMeta, relationCoverage: value.relationCoverage });
    const cached = selectedTaskId ? this.detailCached : this.cached;
    if (cached?.key === key) return merge(cached.value);
    const pending = this.pending.get(key); if (pending) return merge(await pending);
    if (this.pending.size >= 16) return isolated('unavailable', '工作台关联查询繁忙，请稍后重试');
    const value = this.project(source, registry, client, selectedTaskId).then(result => {
      if (result.associationMeta?.state === 'complete') {
        if (selectedTaskId) this.detailCached = { key, value: result }; else this.cached = { key, value: result };
      }
      return result;
    }).catch(() => isolated('unavailable', '台账关联补查失败，飞书原生数据仍可查看')).finally(() => { this.pending.delete(key); });
    this.pending.set(key, value); return merge(await value);
  }
  private async project(source: WorkspaceResponsibilitySnapshot, registry: TaskRegistryProjection, client: FeishuProjectClient, selectedTaskId?: string): Promise<WorkspaceResponsibilitySnapshot> {
    const local = new Map<string, string[]>();
    for (const task of registry.tasks) for (const id of task.feishuWorkItemIds) {
      const tasks = local.get(id) ?? []; if (!tasks.includes(task.id)) tasks.push(task.id); local.set(id, tasks);
    }
    const parents = new Map(source.workbenchItems.map(item => [item.workItemId, item]));
    const children = new Map<string, Array<{ parent: WorkbenchItem; child: WorkbenchItem['mySubtasks'][number] }>>();
    for (const parent of parents.values()) for (const child of parent.mySubtasks) {
      const matches = children.get(child.id) ?? []; matches.push({ parent, child }); children.set(child.id, matches);
    }
    const activeIds = [...new Set(registry.tasks.filter(task => selectedTaskId ? task.id === selectedTaskId : !['done', 'completed', 'closed', 'cancelled', 'canceled'].includes(task.status ?? '')).flatMap(task => task.feishuWorkItemIds))];
    const enrich = Object.values(this.options).some(Boolean);
    const candidates = !selectedTaskId && enrich ? [...new Set([...activeIds, ...parents.keys()])] : activeIds;
    const wanted = candidates.filter(id => !children.has(id) && (!parents.has(id) || enrich));
    let partial = wanted.length > 1000, supplementFailed = false;
    const details = new Map<string, Row>();
    const supplementalFacts: ReturnType<typeof projectResponsibility>[] = [];
    const roleDefinitions = new Map<string, FlowRoleDefinition[]>();
    let catalogRows: Row[] = [], spaceRow: Row | null = null;
    if (wanted.length) {
      try {
        const [catalog, space] = await Promise.all([client.catalog(), client.space()]);
        catalogRows=catalog;spaceRow=space;
        const types = catalog.map(row => String(row.type_key)).filter(type => type !== 'sub_task');
        for (let offset = 0; offset < Math.min(wanted.length, 1000); offset += 50) {
          try {
            const batch = wanted.slice(offset, Math.min(offset + 50, 1000));
            const known = new Map(batch.flatMap(id=>{
              const type=parents.get(id)?.typeKey;
              return type&&types.includes(type)?[[id,type] as const]:[];
            }));
            const unknown=batch.filter(id=>!known.has(id));
            const discovered = new Map([...known,...(unknown.length?await client.discover(unknown, types, true):new Map<string,string>())]), groups = new Map<string, string[]>();
            for (const [id, type] of discovered) groups.set(type, [...(groups.get(type) ?? []), id]);
            for (const [type, ids] of groups) for (const row of await client.details(type, ids)) {
              const id = String(row.id), detail = { ...row, work_item_type_key: type }; details.set(id, detail);
              if (!parents.has(id)) {
                if (needsFlowRoleDefinitions(detail, client.config.userKey) && !roleDefinitions.has(type)) {
                  roleDefinitions.set(type, await client.flowRoles(type).catch(() => []));
                }
                const definitions = roleDefinitions.get(type) ?? [];
                supplementalFacts.push(projectResponsibility(detail, [], client, catalog, space, definitions, taskRegistryResponsibilityRoles(type, definitions)));
              }
            }
          } catch { supplementFailed = true; }
        }
      } catch { supplementFailed = true; }
    }
    let enrichment: Awaited<ReturnType<typeof enrichRegistryItems>> = { contexts: new Map(), partial: false };
    if (Object.values(this.options).some(Boolean) && details.size) {
      try { enrichment = await enrichRegistryItems(client, this.options, details, registry); }
      catch { enrichment.partial = true; }
    }
    partial ||= supplementFailed || enrichment.partial;
    // Enrichment already fetched verified linked stories. Keep their parent identity
    // even when the user participates only in a defect, without another lookup.
    if(spaceRow){
      const linked=new Set([...enrichment.contexts.values()].flatMap(context=>context.linkedStoryIds??[]));
      for(const id of linked){
        const detail=details.get(id);
        if(!parents.has(id)&&!supplementalFacts.some(fact=>fact.id===id)&&detail?.work_item_type_key===(this.options.ADAPTER_STORY_TYPE||'story')){
          supplementalFacts.push(projectResponsibility(detail,[],client,catalogRows,spaceRow));
        }
      }
    }
    await hydrateFactNames(client, supplementalFacts);
    for (const projected of projectFeishuSnapshot({ generatedAt: source.generatedAt, fetchedAt: source.fetchedAt, retrievalComplete: true, classificationComplete: true, relationCoverage: 'not_queried', facts: supplementalFacts }, source.sourceUserKey).workbenchItems) parents.set(projected.workItemId, { ...projected, participated: false });
    const childLocal = (id: string) => children.get(id)?.length === 1 && !parents.has(id) ? local.get(id) ?? [] : [];
    const workbenchItems = [...parents.values()].map(item => ({ ...item, ...enrichment.contexts.get(item.workItemId), localTaskIds: local.get(item.workItemId) ?? [],
      mySubtasks: item.mySubtasks.map(child => ({ ...child, localTaskIds: childLocal(child.id) })) }));
    const localAssociated = [...local].map(([workItemId, localTaskIds]) => {
      const parent = parents.get(workItemId), child = children.get(workItemId);
      const resolved = !parent && child?.length === 1 ? child[0] : null;
      const verified = !!parent || !!resolved;
      return { ...enrichment.contexts.get(workItemId), associationKey: `registry:${workItemId}`, workItemId, localTaskIds,
        kind: parent ? 'work_item' as const : resolved ? 'subtask' as const : 'unresolved' as const, parentId: resolved?.parent.workItemId ?? null,
        ...(parent?.typeKey ? {typeKey:parent.typeKey} : {}), verified,
        title: parent?.title ?? resolved?.child.title ?? `飞书关联 ${workItemId}`, url: parent?.url ?? resolved?.parent.url ?? null,
        error: verified ? null : supplementFailed ? '台账关联对象补查失败' : wanted.indexOf(workItemId) >= 1000 ? '本轮超过1000项补查上限，请打开具体交付查看' : '尚未核实为可访问的工作项或唯一子任务' };
    });
    return { ...source, items: source.items.map(item => ({ ...item, ...enrichment.contexts.get(item.workItemId), version: enrichment.contexts.get(item.workItemId)?.release?.version ?? item.version, localTaskIds: local.get(item.workItemId) ?? [] })),
      workbenchItems, localAssociated, relationCoverage: source.relationCoverage==='partial' ? 'partial' : [...enrichment.contexts.values()].some(context=>context.linkedStoryIds!==undefined) ? partial ? 'partial' : 'complete' : source.relationCoverage,
      associationMeta: { state: partial ? 'partial' : 'complete', error: wanted.length > 1000 ? '关联补查仅处理前1000项，其余可打开具体交付查看' : supplementFailed || enrichment.partial ? '部分关联或业务发布信息未核实，可重试' : null, checkedAt: Date.now() } };
  }
}
