import { type FeishuProjectClient, numericId, rows, object } from './client.js';

export async function readOperationPage(client: FeishuProjectClient, id: string, start: number, end: number, cursor?: string) {
  const data = await client.operations(id, start, end, cursor);
  if (typeof data.has_more !== 'boolean') throw new Error('飞书操作记录分页标记缺失');
  const events: Array<{ at: number; module: string; operation: string; childId: string | null; property: string | null }> = [];
  for (const row of rows(data.op_records)) {
    if (numericId(row.work_item_id) !== id || row.project_key !== client.config.projectKey) throw new Error('飞书操作记录身份不匹配');
    if (!Number.isSafeInteger(row.operation_time) || row.operation_time < start || row.operation_time > end) throw new Error('飞书操作记录时间无效');
    if (typeof row.op_record_module !== 'string' || typeof row.operation_type !== 'string') throw new Error('飞书操作记录类别缺失');
    const contents = rows(row.record_contents ?? []);
    for (const content of contents.length ? contents : [{}]) {
      const target = object(content.object ?? {});
      events.push({ at: row.operation_time, module: row.op_record_module, operation: row.operation_type,
        childId: target.object_type === 'sub_task' ? numericId(target.object_value) : null,
        property: typeof content.object_property === 'string' && content.object_property.length <= 80 ? content.object_property : null });
    }
  }
  if (data.has_more && (typeof data.start_from !== 'string' || !/^[A-Za-z0-9_+=/-]{1,256}$/.test(data.start_from))) throw new Error('飞书操作记录游标缺失');
  return { events, hasMore: data.has_more, cursor: data.has_more ? data.start_from as string : null };
}
