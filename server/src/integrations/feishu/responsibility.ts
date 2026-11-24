import { createFieldDefinitionReader, FeishuProjectClient, FeishuApiError, numericId, object, rows, type Row, type FlowRoleDefinition } from './client.js';

export type Phase = 'current' | 'upcoming' | 'completed' | 'unknown';
export type Actionability = 'current' | 'state_responsibility' | 'upcoming' | 'noncurrent' | 'archived' | 'unverified';
export interface FeishuFact {
  responsibleKeys?:string[]; responsibleNames?:string[];
  creatorKey?: string | null; creatorNames?: string[];
  createdAt?: string | null;
  linkedStoryIds?: string[]; myResponsibility?: boolean;
  id: string; type: string; title: string; typeName: string | null; url: string | null;
  owner: string | null; roleOwners: string[]; myRoles: string[]; baseOwnerIsMe: boolean;
  participatingRoleKeys?: string[];
  stateKey: string | null; statusName: string | null; archived: boolean | null; flowFinished: boolean | null;
  updatedAt: string | null; finishedAt: string | null; actionability: Actionability; reasons: string[];
  currentNodes: Array<{ name: string; ownerNames: string[] }>;
  fallbackContact?: { role: 'reporter' | 'creator'; keys: string[]; names: string[] };
  myNodes: Array<{ id: string; name: string | null; phase: Phase; ownerCount: number }>;
  mySubtasks: Array<{ id: string; title: string; owners: string[]; ownerNames?:string[]; passed: boolean; createdAt?:string|null; updatedAt?:string|null; finishedAt: string | null; nodeId: string; nodeName: string | null; phase: Phase }>;
}
export interface FeishuResponsibility {
  generatedAt: string; fetchedAt: number; retrievalComplete: boolean; classificationComplete: boolean;
  relationCoverage: 'not_queried' | 'complete' | 'partial'; facts: FeishuFact[];
}
const phase = (value: unknown): Phase => value === 1 ? 'upcoming' : value === 2 ? 'current' : value === 3 ? 'completed' : 'unknown';
const owners = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string' || !key)) throw new Error('飞书负责人结构无效');
  return [...new Set(value)];
};
const field = (item: Row, key: string): unknown => rows(item.fields ?? []).find(row => row.field_key === key)?.field_value;
function roleEvidence(item: Row, user: string, extraRoles: readonly string[] = []) {
  const roleField = field(item, 'role_owners'), roles = roleField == null ? [] : rows(roleField);
  const responsibilityRoles = new Set(['operator', 'owner', 'collaborator', ...extraRoles]);
  const excluded = new Set(['reporter', 'creator', 'watcher', 'watchers']);
  const roleOwners = [...new Set(roles.filter(role => !excluded.has(role.role) && responsibilityRoles.has(role.role)).flatMap(role => owners(role.owners ?? [])))];
  const myRoles = roles.filter(role => !excluded.has(role.role) && responsibilityRoles.has(role.role) && owners(role.owners ?? []).includes(user)).map(role => String(role.role));
  const participatingRoleKeys = [...new Set(roles.filter(role => !excluded.has(role.role) && owners(role.owners ?? []).includes(user)).map(role => String(role.role)))];
  return { roleField, roles, roleOwners, myRoles, participatingRoleKeys, unmappedRoleIds: participatingRoleKeys.filter(key => !responsibilityRoles.has(key)) };
}
export type ResponsibilityRoleResolver = (type: string, definitions: FlowRoleDefinition[]) => readonly string[];

export function createRoleDefinitionReader(client: FeishuProjectClient) {
  const checkedByType = new Map<string, { checked: Set<string>; definitions: FlowRoleDefinition[] }>();
  return async (type: string, items: Row[]): Promise<FlowRoleDefinition[]> => {
    const expected = [...new Set(items.flatMap(item => roleEvidence(item, client.config.userKey).unmappedRoleIds))];
    const current = checkedByType.get(type) ?? { checked: new Set<string>(), definitions: [] };
    if (expected.some(id => !current.checked.has(id))) {
      current.definitions = await client.flowRoles(type, expected).catch(() => current.definitions);
      for (const id of expected) current.checked.add(id);
      for (const role of current.definitions) current.checked.add(role.id);
      checkedByType.set(type, current);
    }
    return current.definitions;
  };
}
/** Extra role labels do not invalidate a classification already established by native evidence. */
function hasNativeClassification(fact: Pick<FeishuFact, 'actionability' | 'flowFinished'>): boolean {
  return ['current', 'upcoming', 'state_responsibility', 'archived'].includes(fact.actionability) || fact.flowFinished === true;
}
export function hasUnverifiedResponsibility(fact: Pick<FeishuFact, 'actionability' | 'reasons' | 'archived' | 'flowFinished'>): boolean {
  if (fact.actionability === 'unverified') return true;
  const nativeClassification = hasNativeClassification(fact);
  return fact.reasons.some(reason => reason !== 'unmapped_role' || !nativeClassification);
}
function resolveRoleDefinitions(fact: FeishuFact, definitions: FlowRoleDefinition[]): FeishuFact {
  const index = fact.reasons.indexOf('unmapped_role');
  if (index < 0 || !definitions.length) return fact;
  const namedRoles = new Set(definitions.map(role => role.id));
  const unresolved = (fact.participatingRoleKeys ?? []).filter(key => !fact.myRoles.includes(key));
  if (!unresolved.length || !unresolved.every(key => namedRoles.has(key))) return fact;
  if (hasNativeClassification(fact)) {
    fact.reasons.splice(index, 1);
  } else if (fact.reasons.length === 1 && fact.myNodes.length
    && fact.myNodes.every(node => node.phase === 'completed') && fact.mySubtasks.every(task => task.passed)) {
    // A workflow may still be open for other people after all of my assigned work is complete.
    fact.actionability = 'noncurrent';
    fact.reasons.splice(index, 1);
  } else {
    fact.reasons[index] = 'unverified_role_responsibility';
  }
  return fact;
}
export function timestamp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (Number.isSafeInteger(value) && (value as number) >= 1_000_000_000_000 && (value as number) < 10_000_000_000_000) return new Date(value as number).toISOString();
  throw new Error('飞书时间缺少有效单位或时区');
}
/** Optional ordering evidence must not invalidate native responsibility. */
function orderingTimestamp(value:unknown):string|null { try{return timestamp(value);}catch{return null;} }
export function projectResponsibility(item: Row, subtasks: Row[], client: FeishuProjectClient, catalog: Row[], space: Row, roleDefinitions: FlowRoleDefinition[] = [], extraRoles: readonly string[] = []): FeishuFact {
  const user = client.config.userKey, id = numericId(item.id), type = String(item.work_item_type_key ?? '');
  if (item.project_key !== client.config.projectKey || !type) throw new Error('飞书工作项身份不匹配');
  const status = object(item.work_item_status ?? {}), stateBased = item.pattern === 'State' || type === 'issue';
  const baseOwner = field(item, 'owner'), operator = field(item, type === 'issue' ? 'issue_operator' : 'owner');
  const { roleField, roles, roleOwners, myRoles, participatingRoleKeys, unmappedRoleIds } = roleEvidence(item, user, extraRoles);
  const operatorValues = operator == null ? [] : Array.isArray(operator) ? operator : [operator];
  if (operatorValues.some(value => typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))) throw new Error('飞书责任字段无效');
  const operatorIsMe = operatorValues.map(String).includes(user), baseOwnerIsMe = String(baseOwner ?? '') === user;
  const reasons: string[] = [];
  if (unmappedRoleIds.length) reasons.push('unmapped_role');
  if (roleField == null || operator === undefined) reasons.push('missing_responsibility_fields');
  const nodes = stateBased ? [] : rows(object(item.workflow_infos ?? {}).workflow_nodes ?? []);
  if (!stateBased && !nodes.length) reasons.push('unknown_workflow');
  const myNodes = nodes.filter(node => owners(node.owners ?? node.node_schedule?.owners ?? []).includes(user)).map(node => ({
    id: String(node.id ?? ''), name: typeof node.name === 'string' && node.name ? node.name : null,
    phase: phase(node.status), ownerCount: owners(node.owners ?? node.node_schedule?.owners ?? []).length,
  }));
  if (myNodes.some(node => !node.id) || new Set(myNodes.map(node => node.id)).size !== myNodes.length) throw new Error('飞书本人节点ID无效');
  if (myNodes.some(node => node.phase === 'unknown')) reasons.push('unknown_node_status');
  const seen = new Set<string>();
  const mySubtasks: FeishuFact['mySubtasks'] = [];
  for (const row of subtasks) {
    if (String(row.work_item_id) !== id) throw new Error('飞书子任务父项不匹配');
    const task = object(row.sub_task), taskId = numericId(task.id), nodeId = String(row.node_id ?? '');
    if (seen.has(taskId) || !nodeId || typeof task.passed !== 'boolean') throw new Error('飞书子任务原生证据缺失或重复');
    seen.add(taskId);
    const taskOwners = owners(task.owners ?? []);
    if (!taskOwners.includes(user)) { if (!task.passed) throw new Error('未完成子任务候选负责人不匹配'); continue; }
    const node = nodes.find(node => String(node.id) === nodeId), taskPhase = phase(node?.status);
    if (!task.passed && taskPhase === 'unknown') reasons.push('unknown_subtask_node');
    if (!task.passed && taskPhase === 'completed') reasons.push('unfinished_subtask_in_completed_node');
    mySubtasks.push({ id: taskId, title: String(task.name || `飞书子任务 ${taskId}`), owners: taskOwners, passed: task.passed,
      createdAt:orderingTimestamp(task.created_at),updatedAt:orderingTimestamp(task.updated_at),
      finishedAt: timestamp(task.finish_time ?? task.finished_at), nodeId, nodeName: typeof node?.name === 'string' ? node.name : null, phase: taskPhase });
  }
  const currentNodes = nodes.filter(node => node.status === 2).map(node => ({ name: String(node.name || node.id), ownerNames: owners(node.owners ?? node.node_schedule?.owners ?? []) }));
  const reporters = roles.filter(role => role.role === 'reporter').flatMap(role => owners(role.owners ?? []));
  const creator = typeof item.created_by === 'string' ? [item.created_by] : [];
  const fallbackContact = reporters.length ? { role: 'reporter' as const, keys: reporters, names: [] as string[] }
    : creator.length ? { role: 'creator' as const, keys: creator, names: [] as string[] } : undefined;
  const matches = catalog.filter(row => row.type_key === type), catalogRow = matches.length === 1 ? matches[0] : null;
  const safeSegment = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
  const url = space.project_key === client.config.projectKey && safeSegment(space.simple_name) && safeSegment(catalogRow?.api_name)
    ? `https://project.feishu.cn/${space.simple_name}/${catalogRow.api_name}/detail/${id}` : null;
  const archived = typeof status.is_archived_state === 'boolean' ? status.is_archived_state : null;
  const flowFinished = nodes.length ? nodes.every(node => node.status === 3) : null;
  let actionability: Actionability;
  if (archived === true && !mySubtasks.some(task => !task.passed)) actionability = 'archived';
  else if (stateBased) actionability = archived === true ? 'archived' : operatorIsMe || myRoles.length ? 'state_responsibility' : reasons.length ? 'unverified' : 'noncurrent';
  else if (myNodes.some(node => node.phase === 'current') || mySubtasks.some(task => !task.passed && task.phase === 'current')) actionability = 'current';
  else if (myNodes.some(node => node.phase === 'upcoming') || mySubtasks.some(task => !task.passed && task.phase === 'upcoming')) actionability = 'upcoming';
  else actionability = reasons.some(reason => reason !== 'unmapped_role' || flowFinished !== true) ? 'unverified' : 'noncurrent';
  if (status.is_archived_state !== undefined && archived === null) reasons.push('invalid_archived_flag');
  return resolveRoleDefinitions({ id, type, title: String(item.name || `飞书工作项 ${id}`), typeName: typeof catalogRow?.name === 'string' ? catalogRow.name : null, url,
    owner: typeof baseOwner === 'string' ? baseOwner : null, roleOwners, myRoles, participatingRoleKeys, baseOwnerIsMe, fallbackContact, myResponsibility:operatorIsMe||myRoles.length>0,
    creatorKey:typeof item.created_by==='string'?item.created_by:null,
    responsibleKeys:stateBased?operatorValues.map(String):[],
    stateKey: typeof status.state_key === 'string' ? status.state_key : null, statusName: null, archived, flowFinished,
    createdAt:orderingTimestamp(item.created_at),updatedAt: timestamp(item.updated_at), finishedAt: timestamp(item.finish_time ?? item.finished_at ?? (archived===true?status.updated_at:null)), actionability, reasons: [...new Set(reasons)], currentNodes, myNodes, mySubtasks }, roleDefinitions);
}

export function linkedWorkItemIds(item: Row, key: string): string[] | null {
  const source = rows(item.fields ?? []).find(row=>row.field_key===key);
  if (!source) return null;
  if (source.field_value == null) return [];
  if (typeof source.field_value==='number'||typeof source.field_value==='string') return [numericId(source.field_value)];
  if (!Array.isArray(source.field_value)) throw new Error('飞书关联字段结构无效');
  return [...new Set(source.field_value.map(numericId))];
}

export class FeishuResponsibilityService {
  constructor(readonly client: FeishuProjectClient, private readonly now: () => number = Date.now,
    private readonly resolveResponsibilityRoles: ResponsibilityRoleResolver = () => [], private readonly storyRelationField?: string) {}
  async load(): Promise<FeishuResponsibility> {
    const catalogRequest = this.client.catalog();
    const candidatesRequest = catalogRequest.then(catalog => {
      const types = catalog.map(row => String(row.type_key)).filter(type => type !== 'sub_task');
      if (!types.length || new Set(types).size !== types.length) throw new Error('飞书可用类型目录无效');
      return this.client.candidates(types).then(candidates => ({ candidates, types }));
    });
    const [catalog, { candidates, types }, subtasks, space] = await Promise.all([
      catalogRequest, candidatesRequest, this.client.subtaskCandidates(), this.client.space(),
    ]);
    const byId = new Map(candidates.map(item => [numericId(item.id), item]));
    const subtasksByParent = new Map<string, Row[]>();
    for (const row of subtasks) {
      const parentId = String(row.work_item_id);
      const children = subtasksByParent.get(parentId) ?? [];
      children.push(row);
      subtasksByParent.set(parentId, children);
    }
    const requiredParents = [...new Set(subtasks.filter(row => !row.sub_task.passed).map(row => numericId(row.work_item_id)))];
    const missing = requiredParents.filter(id => !byId.has(id));
    for (let offset = 0; offset < missing.length; offset += 50) {
      const discovered = await this.client.discover(missing.slice(offset, offset + 50), types);
      for (const [id, type] of discovered) byId.set(id, { id, project_key: this.client.config.projectKey, work_item_type_key: type });
    }
    const groups = new Map<string, string[]>();
    for (const [id, row] of byId) {
      if (!types.includes(row.work_item_type_key)) throw new Error('飞书候选类型不匹配');
      const list = groups.get(row.work_item_type_key) ?? []; list.push(id); groups.set(row.work_item_type_key, list);
    }
    const facts: FeishuFact[] = [];
    const fieldDefinitions = createFieldDefinitionReader(this.client, type => type === 'issue' ? this.storyRelationField : undefined);
    const readRoles = createRoleDefinitionReader(this.client);
    let relationComplete = true;
    for (const [type, ids] of groups) for (let offset = 0; offset < ids.length; offset += 50) {
      const details = await this.client.details(type, ids.slice(offset, offset + 50));
      const definitions = await readRoles(type, details);
      const extraRoles = this.resolveResponsibilityRoles(type, definitions);
      for (const detail of details) {
        const id = numericId(detail.id);
        const item: Row = { ...byId.get(id), ...detail, work_item_type_key: type };
        const fact = projectResponsibility(item, subtasksByParent.get(id) ?? [], this.client, catalog, space, definitions, extraRoles);
        if (type==='issue' && this.storyRelationField) {
          try {
            const definition = await fieldDefinitions.find(type, this.storyRelationField, rows(item.fields ?? []));
            if (!definition) throw new Error('关联需求字段未核实');
            const ids=linkedWorkItemIds(item,definition.field_key);
            if(ids===null)throw new Error('关联需求字段未返回');
            fact.linkedStoryIds=ids;
          } catch { relationComplete=false; }
        }
        if (fact.actionability === 'state_responsibility') {
          if (fact.fallbackContact?.role !== 'reporter') {
            try {
              const fields = await fieldDefinitions.list(type);
              for (const [label, role] of [['报告人', 'reporter'], ['创建人', 'creator']] as const) {
                const matches = fields.filter(row => row.field_name === label);
                if (matches.length !== 1) continue;
                const value = field(item, matches[0].field_key), keys = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
                if (keys.length && keys.every(key => typeof key === 'string' && key)) { fact.fallbackContact = { role, keys, names: [] }; break; }
              }
            } catch { /* Contact metadata is optional evidence and never changes responsibility. */ }
          }
        }
        // Preserve participation, including completed nodes; a user-filter match alone is not ownership.
        if (fact.myResponsibility || fact.baseOwnerIsMe || fact.participatingRoleKeys?.length || fact.roleOwners.includes(this.client.config.userKey) || fact.myNodes.length || fact.mySubtasks.length || fact.actionability === 'state_responsibility' || fact.actionability==='unverified' || fact.reasons.includes('unmapped_role')) facts.push(fact);
      }
    }
    for (const parent of requiredParents) if (!facts.some(fact => fact.id === parent && fact.mySubtasks.some(task => !task.passed))) throw new Error('飞书未完成子任务无法核实父项');
    const stateFacts = facts.filter(fact => fact.actionability === 'state_responsibility');
    const hydrateStatusNames = async () => {
      for (let offset = 0; offset < stateFacts.length; offset += 3) {
        await Promise.all(stateFacts.slice(offset, offset + 3).map(async fact => {
          const stateFlow = await this.client.stateFlow(fact.type, fact.id);
          const names = rows(stateFlow.state_flow_nodes).filter(node => node.id === fact.stateKey && typeof node.name === 'string' && node.name.trim());
          if (names.length !== 1) throw new Error('飞书状态名称无法唯一核实');
          fact.statusName = names[0].name.trim();
        }));
      }
    };
    await Promise.all([
      hydrateStatusNames().then(() => hydrateFactNames(this.client, facts)),
      catalog.some(row => row.type_key === 'sub_task') ? hydrateSubtaskTimes(this.client, facts) : undefined,
    ]);
    this.client.warmDefinitions(groups.keys());
    const fetchedAt = this.now();
    return { generatedAt: new Date(fetchedAt).toISOString(), fetchedAt, retrievalComplete: true,
      classificationComplete: facts.every(fact => !hasUnverifiedResponsibility(fact)), relationCoverage: this.storyRelationField ? relationComplete?'complete':'partial' : 'not_queried', facts };
  }
}

/** Search/workflow task rows omit creation metadata; the sub_task work-item query supplies it. */
export async function hydrateSubtaskTimes(client:FeishuProjectClient,facts:FeishuFact[]):Promise<void> {
  const byId=new Map<string,FeishuFact['mySubtasks']>();
  for(const task of facts.flatMap(fact=>fact.mySubtasks)){
    const entries=byId.get(task.id)??[];entries.push(task);byId.set(task.id,entries);
  }
  const ids=[...byId].filter(([,entries])=>entries.some(task=>!task.createdAt||!task.updatedAt)).map(([id])=>id);
  for(let offset=0;offset<ids.length;offset+=50){
    let details:Row[];
    try{details=await client.details('sub_task',ids.slice(offset,offset+50),{allowMissing:true});}
    catch(error){
      // Preserve native facts, and do not repeat connection-wide failures for every optional batch.
      if(error instanceof FeishuApiError&&['permission','rate_limit','network'].includes(error.kind))break;
      continue;
    }
    for(const item of details)for(const task of byId.get(numericId(item.id))??[]){
      task.createdAt=orderingTimestamp(item.created_at)??task.createdAt??null;
      task.updatedAt=orderingTimestamp(item.updated_at)??task.updatedAt??null;
    }
  }
}

/** Identity keys remain in responsibility evidence; display names are resolved once per batch. */
export async function hydrateFactNames(client: FeishuProjectClient, facts: FeishuFact[]): Promise<void> {
  const keys = [...new Set(facts.flatMap(fact => [...fact.currentNodes.flatMap(node => node.ownerNames), ...(fact.fallbackContact?.keys ?? []), ...(fact.responsibleKeys??[]), ...fact.mySubtasks.flatMap(task=>task.owners), ...(fact.statusName==='新建'&&fact.creatorKey?[fact.creatorKey]:[])]))];
  const names = new Map<string, string>();
  for (let offset = 0; offset < keys.length; offset += 50) {
    try { for (const [key, name] of await client.users(keys.slice(offset, offset + 50))) names.set(key, name); }
    catch { /* Names are supplementary; failure must not erase native responsibility facts. */ }
  }
  const display = (key: string) => names.get(key) ?? `姓名未知(${key})`;
  for (const fact of facts) {
    for (const node of fact.currentNodes) node.ownerNames = node.ownerNames.map(display);
    if (fact.fallbackContact) fact.fallbackContact.names = fact.fallbackContact.keys.map(display);
    if (fact.statusName==='新建'&&fact.creatorKey) fact.creatorNames = names.has(fact.creatorKey)?[names.get(fact.creatorKey)!]:[];
    fact.responsibleNames=(fact.responsibleKeys??[]).map(key=>names.get(key)??'姓名未提供');
    for(const task of fact.mySubtasks)task.ownerNames=task.owners.map(key=>names.get(key)??'姓名未提供');
  }
}
