import { createFieldDefinitionReader, type FeishuProjectClient, type Row } from '../integrations/feishu/client.js';
import { timestamp } from '../integrations/feishu/responsibility.js';
import type { WorkbenchItem } from './responsibility-report-source.js';
import type { TaskRegistryProjection } from './task-registry-reader.js';

type Context = Pick<WorkbenchItem, 'release' | 'linkedStoryIds' | 'applications' | 'applicationCoverage'>;
type Release = NonNullable<Context['release']>;
const values = (row: Row, key: string): unknown => (row.fields ?? []).find((field: Row) => field.field_key === key)?.field_value;
export function referenceIds(value: unknown): string[] {
  const parts = (Array.isArray(value) ? value : typeof value === 'string' ? value.trim() ? value.trim().split(/[,，、\s]+/) : [] : value == null ? [] : [value]).filter(id => id !== null && id !== '');
  if (parts.some(id => !['string', 'number'].includes(typeof id) || typeof id === 'number' && !Number.isSafeInteger(id) || !/^[1-9]\d*$/.test(String(id)))) throw new Error('业务关系字段不是有效标识列表');
  return [...new Set(parts.map(String))];
}
export function releaseReferences(row: Row, normal: string, canary: string, flag: string) {
  const normalIds = referenceIds(values(row, normal)), canaryIds = referenceIds(values(row, canary));
  const rawFlag = values(row, flag), label = typeof rawFlag === 'string' ? rawFlag : rawFlag && typeof rawFlag === 'object' ? (rawFlag as Row).label : undefined;
  return { ids: canaryIds.length ? canaryIds : normalIds, mode: canaryIds.length || !normalIds.length && label === '是' ? 'canary' as const : 'normal' as const,
    conflict: !!(canaryIds.length && label === '否' || !canaryIds.length && normalIds.length && label === '是') };
}
export function resolveRelease(refs: ReturnType<typeof releaseReferences>, names: Map<string, string>): Release {
  const dated = refs.ids.map((id, index) => {
    const match = names.get(id)?.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
    const date = match ? Date.UTC(+match[1], +match[2] - 1, +match[3]) : Infinity;
    const valid = match && new Date(date).getUTCMonth() === +match[2] - 1 && new Date(date).getUTCDate() === +match[3];
    return { id, index, date: valid ? date : Infinity };
  }).sort((a, b) => a.date - b.date || a.index - b.index);
  const id = dated[0]?.id ?? null;
  return { mode: refs.mode, conflict: refs.conflict, versionId: id, version: id ? names.get(id) ?? null : null, source: 'item',
    error: refs.ids.some(id => !names.has(id)) ? '部分版本名称未核实' : null };
}

/** Business field mapping lives in the adapter. The generic client knows no release policy. */
export async function enrichRegistryItems(client: FeishuProjectClient, options: Record<string, string>, details: Map<string, Row>, registry: TaskRegistryProjection): Promise<{ contexts: Map<string, Context>; partial: boolean }> {
  const contexts = new Map<string, Context>();
  let partial = false;
  const attemptedSelectors = new Set<string>(), matchedSelectors = new Set<string>();
  const fieldDefinitions = createFieldDefinitionReader(client, type => type === 'issue' ? options.ADAPTER_STORY_RELATION_FIELD
    : type === options.ADAPTER_APPLICATION_TYPE ? options.ADAPTER_APPLICATION_STORY_FIELD : undefined);
  const field = async (type: string, selector?: string, itemFields?: Row[]) => {
    if (!selector) return '';
    attemptedSelectors.add(selector);
    const definition = await fieldDefinitions.find(type, selector, itemFields);
    // Optional business fields differ by work-item type. Absence is not an API failure.
    if (!definition) return '';
    matchedSelectors.add(selector);
    return definition.field_key;
  };
  const storyType = options.ADAPTER_STORY_TYPE || 'story', versionType = options.ADAPTER_VERSION_TYPE || 'version';
  const fetchItems = async (type: string, ids: string[]) => {
    if (ids.length > 1000) throw new Error('业务补查超过1000项上限');
    for (let offset = 0; offset < ids.length; offset += 50) for (const row of await client.details(type, ids.slice(offset, offset + 50))) details.set(String(row.id), { ...row, work_item_type_key: type });
  };
  // Resolve native issue→story fields, independently of local delivery grouping.
  if (options.ADAPTER_STORY_RELATION_FIELD) {
    for (const [id, row] of [...details]) {
      if (row.work_item_type_key === storyType || row.work_item_type_key === versionType) continue;
      try {
        const key=await field(row.work_item_type_key, options.ADAPTER_STORY_RELATION_FIELD,
          row.work_item_type_key === 'issue' ? row.fields ?? [] : undefined);
        if(!key){if(row.work_item_type_key==='issue')partial=true;continue;}
        if(!(row.fields??[]).some((entry:Row)=>entry.field_key===key)){partial=true;continue;}
        const ids = referenceIds(values(row, key));
        contexts.set(id, { linkedStoryIds: ids });
      } catch { partial = true; }
    }
    try { await fetchItems(storyType, [...new Set([...contexts.values()].flatMap(item => item.linkedStoryIds ?? []))].filter(id => !details.has(id))); }
    catch { partial = true; }
  }
  const refs = new Map<string, ReturnType<typeof releaseReferences>>();
  if (options.ADAPTER_VERSION_FIELD || options.ADAPTER_CANARY_VERSION_FIELD) {
    for (const [id, row] of details) {
      if (row.work_item_type_key === versionType) continue;
      try {
        let normal = await field(row.work_item_type_key, options.ADAPTER_VERSION_FIELD);
        // The native planning_version field is omitted from some type metadata.
        if (!normal && ['规划版本', 'planning_version'].includes(options.ADAPTER_VERSION_FIELD) && (row.fields ?? []).some((entry:Row) => entry.field_key === 'planning_version')) {
          normal = 'planning_version'; matchedSelectors.add(options.ADAPTER_VERSION_FIELD);
        }
        const canary = await field(row.work_item_type_key, options.ADAPTER_CANARY_VERSION_FIELD), flag = await field(row.work_item_type_key, options.ADAPTER_CANARY_FLAG_FIELD);
        if (normal || canary || flag) refs.set(id, releaseReferences(row, normal, canary, flag));
      } catch { partial = true; contexts.set(id, { ...contexts.get(id), release: { mode: 'normal', conflict: false, versionId: null, version: null, source: 'item', error: '发布字段未核实' } }); }
    }
    const names = new Map<string, string>();
    try {
      const ids = [...new Set([...refs.values()].flatMap(ref => ref.ids))];
      await fetchItems(versionType, ids);
      for (const id of ids) { const name = details.get(id)?.name; if (typeof name === 'string' && name.trim()) names.set(id, name.trim()); }
    } catch { partial = true; }
    for (const [id, ref] of refs) {
      const release = resolveRelease(ref, names); if (release.error) partial = true;
      contexts.set(id, { ...contexts.get(id), release });
    }
    for (const [id, context] of contexts) {
      const linked = context.linkedStoryIds ?? [];
      if (!linked.length) continue;
      const releases = linked.map(story => contexts.get(story)?.release);
      const first = releases[0];
      if (!first || releases.some(release => !release || release.error || release.versionId !== first.versionId || release.mode !== first.mode)) {
        partial = true; context.release = { ...(context.release ?? { mode: 'normal', conflict: false, versionId: null, version: null }), source: 'linked_story', conflict: true, error: '关联需求发布信息缺失或不一致' };
      } else context.release = { ...first, source: 'linked_story', conflict: releases.some(release => release?.conflict) };
    }
  }
  const applicationType = options.ADAPTER_APPLICATION_TYPE;
  const applications = new Map<string, Row>();
  const explicit = new Map<string, Set<string>>();
  for (const task of registry.tasks) for (const id of task.feishuWorkItemIds) for (const applicationId of task.canaryApplicationIds ?? []) {
    const ids = explicit.get(id) ?? new Set<string>(); ids.add(applicationId); explicit.set(id, ids);
  }
  const eligible = [...details].filter(([id, row]) => row.work_item_type_key === storyType && (explicit.has(id) || contexts.get(id)?.release?.mode === 'canary' &&
    (row.workflow_infos?.workflow_nodes ?? []).some((node: Row) => node.name === options.ADAPTER_RELEASE_NODE_NAME && [2, 3].includes(node.status))));
  for (const id of details.keys()) contexts.set(id, { ...contexts.get(id), applicationCoverage: applicationType ? 'not_queried' : 'not_configured' });
  if (applicationType && eligible.length) {
    try {
      const storySelector = options.ADAPTER_APPLICATION_STORY_FIELD;
      if (!await field(applicationType, storySelector)) throw new Error('未配置申请关联需求字段');
      const explicitIds = [...new Set(eligible.flatMap(([id]) => [...(explicit.get(id) ?? [])]))];
      if (explicitIds.length > 100) throw new Error('显式申请超过100项上限');
      for (let offset = 0; offset < explicitIds.length; offset += 50) for (const row of await client.details(applicationType, explicitIds.slice(offset, offset + 50))) applications.set(String(row.id), row);
      const stage = eligible.filter(([id, row]) => contexts.get(id)?.release?.mode === 'canary' && (row.workflow_infos?.workflow_nodes ?? []).some((node: Row) => node.name === options.ADAPTER_RELEASE_NODE_NAME && [2, 3].includes(node.status)));
      if (options.ADAPTER_RELATION_KEY) {
        for (const [id] of stage) for (const row of await client.related(storyType, id, applicationType, options.ADAPTER_RELATION_KEY, 0, 100)) applications.set(String(row.id), row);
      } else if (stage.length) {
        const rows = await client.candidatesForType(applicationType);
        for (let offset = 0; offset < rows.length; offset += 50) for (const row of await client.details(applicationType, rows.slice(offset, offset + 50).map(row => String(row.id)))) applications.set(String(row.id), row);
      }
      if (applications.size > 100) throw new Error('申请补查超过100项上限');
      const projected = new Map<string, { application: NonNullable<Context['applications']>[number]; linkedStories: Set<string> }>();
      for (const [id, application] of applications) {
        const key = await field(applicationType, storySelector, application.fields ?? []);
        if (!key) throw new Error('未配置申请关联需求字段');
        const linked = new Set(referenceIds(values(application, key)));
        if (!eligible.some(([story]) => linked.has(story) || explicit.get(story)?.has(id))) continue;
        const nodes: Row[] = application.workflow_infos?.workflow_nodes ?? (await client.workflow(applicationType, id)).workflow_nodes;
        if (!Array.isArray(nodes) || !nodes.length || nodes.some(node => ![1, 2, 3].includes(node.status))) throw new Error('申请流程节点证据缺失');
        const finished = values(application, 'finish_status');
        const done = nodes.every(node => node.status === 3), conflict = typeof finished === 'boolean' && finished !== done;
        const groups = await client.subtasks(applicationType, id);
        const tasks: Row[] = groups.flatMap(group => group.sub_tasks ?? []);
        if (tasks.some(task => typeof task.passed !== 'boolean')) throw new Error('申请子任务证据缺失');
        projected.set(id, { linkedStories: linked, application: { workItemId: id, typeKey: applicationType, title: String(application.name || `申请 ${id}`), url: null,
          status: conflict ? '待核对' : done ? '已完成' : nodes.filter(node => node.status === 2).map(node => node.name).join('、') || '待开始',
          completed: conflict ? null : done, finishedAt: timestamp(application.finish_time ?? values(application, 'finish_time')),
          unfinishedSubtasks: tasks.filter(task => !task.passed).map(task => ({ id: String(task.id), name: String(task.name || task.id) })), reconciliationRequired: false, source: 'native_relation' } });
      }
      for (const [id, row] of eligible) {
        const list = [...projected].filter(([appId, result]) => result.linkedStories.has(id) || explicit.get(id)?.has(appId))
          .map(([, { application, linkedStories }]) => ({ ...application,
            source: linkedStories.has(id) ? 'native_relation' as const : 'local_binding' as const,
            reconciliationRequired: application.completed === true && (row.workflow_infos?.workflow_nodes ?? []).some((node: Row) => node.name === options.ADAPTER_RELEASE_NODE_NAME && node.status === 2) }));
        contexts.set(id, { ...contexts.get(id), applications: list, applicationCoverage: 'complete' });
      }
    } catch { partial = true; for (const [id] of eligible) contexts.set(id, { ...contexts.get(id), applicationCoverage: 'partial' }); }
  }
  // Issues keep their own identity while displaying the applications of explicitly linked stories.
  for (const context of contexts.values()) if (context.linkedStoryIds?.length) {
    const stories = context.linkedStoryIds.map(id => contexts.get(id));
    context.applications = [...new Map(stories.flatMap(story => story?.applications ?? []).map(app => [app.workItemId, app])).values()];
    context.applicationCoverage = !applicationType ? 'not_configured' : stories.some(story => !story || story.applicationCoverage === 'partial') ? 'partial'
      : stories.every(story => story?.applicationCoverage === 'complete') ? 'complete' : 'not_queried';
  }
  // A selector absent from every queried type is still a configuration problem, not silently accepted.
  if ([...attemptedSelectors].some(selector => !matchedSelectors.has(selector))) partial = true;
  return { contexts, partial };
}
