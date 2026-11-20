import type { FeishuConfig } from './config.js';
import { feishuReadBatch, memoFeishuRequest, rememberFeishuItem } from './read-batch.js';

export type Row = Record<string, any>;
export interface FlowRoleDefinition { id: string; name: string; isOwner: boolean }
export const object = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('飞书响应缺少对象');
  return value as Row;
};
export const rows = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw new Error('飞书响应缺少列表');
  return value.map(object);
};
export const numericId = (value: unknown): string => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('飞书ID超出安全整数范围');
  const id = String(value ?? ''); if (!/^[1-9]\d{0,18}$/.test(id)) throw new Error('飞书ID无效'); return id;
};
// Filter and operation endpoints require JSON numbers; detail endpoints use strings.
const numericWireId = (value: unknown): number => {
  const id=numericId(value), number=Number(id);
  if(!Number.isSafeInteger(number))throw new Error('飞书请求ID超出JSON安全整数范围');
  return number;
};
const segment = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('飞书对象类型无效'); return value;
};
export class FeishuApiError extends Error {
  constructor(readonly kind: 'permission' | 'rate_limit' | 'network' | 'response', readonly status?: number) {
    super(`飞书只读请求失败：${kind}${status ? ` (${status})` : ''}`);
  }
}

/** One connection owns authentication, throttling and request deduplication across consumers. */
export class FeishuProjectClient {
  private token: { value: string; until: number } | null = null;
  private tokenPending: Promise<string> | null = null;
  private readonly pending = new Map<string, Promise<Row>>();
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  constructor(readonly config: FeishuConfig, private readonly transport: typeof fetch = fetch,
    private readonly now: () => number = Date.now, private readonly intervalMs = 500) {}

  private async send(route: string, body?: Row, token?: string): Promise<Row> {
    const prior = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try {
      const delay = Math.max(0, this.nextAt - this.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      this.nextAt = this.now() + this.intervalMs;
      let response: Response;
      try {
        response = await this.transport(`https://project.feishu.cn/open_api/${route}`, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { 'X-PLUGIN-TOKEN': token, 'X-USER-KEY': this.config.userKey } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch { throw new FeishuApiError('network'); }
      if (!response.ok) throw new FeishuApiError(response.status === 429 ? 'rate_limit' : [401, 403].includes(response.status) ? 'permission' : 'response', response.status);
      // Bounded streaming read: response errors never include a server payload or credentials.
      const reader = response.body?.getReader(); if (!reader) throw new FeishuApiError('response');
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new FeishuApiError('response'); } chunks.push(part.value); } }
      catch { throw new FeishuApiError('response'); } finally { reader.releaseLock(); }
      let result: Row;
      try { result = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw new FeishuApiError('response'); }
      if (result.err_code != null && result.err_code !== 0) throw new FeishuApiError('response');
      return result;
    } finally { release(); }
  }
  private authenticate(): Promise<string> {
    if (this.token && this.token.until > this.now()) return Promise.resolve(this.token.value);
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = this.send('authen/plugin_token', { plugin_id: this.config.pluginId, plugin_secret: this.config.pluginSecret, type: 0 }).then(result => {
      const data = object(result.data);
      if (typeof data.token !== 'string' || !data.token || /[\r\n]/.test(data.token)) throw new FeishuApiError('response');
      const ttl = typeof data.expire_time === 'number' && data.expire_time > 60 ? Math.min(data.expire_time - 60, 3600) : 240;
      this.token = { value: data.token, until: this.now() + ttl * 1000 }; return data.token;
    }).finally(() => { this.tokenPending = null; });
    return this.tokenPending;
  }
  private request(route: string, body?: Row): Promise<Row> {
    return memoFeishuRequest(feishuReadBatch(this),JSON.stringify([route,body]),()=>this.requestUncached(route,body));
  }
  private requestUncached(route: string, body?: Row): Promise<Row> {
    const key = JSON.stringify([route, body]); const pending = this.pending.get(key); if (pending) return pending;
    const request = this.authenticate().then(token => this.send(route, body, token)).catch(error => {
      if (error instanceof FeishuApiError && error.kind === 'permission') this.token = null;
      throw error;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, request); return request;
  }
  private get prefix() { return segment(this.config.projectKey); }
  async catalog(): Promise<Row[]> { return rows((await this.request(`${this.prefix}/work_item/all-types`)).data).filter(row => row.is_disable !== 1); }
  async space(): Promise<Row> {
    const data = (await this.request('projects/detail', { project_keys: [this.config.projectKey], user_key: this.config.userKey })).data;
    // Project detail uses a project-keyed object; retain array support for older responses.
    if (!Array.isArray(data)) {
      const entry = object(object(data)[this.config.projectKey]);
      if (entry.project_key !== undefined && entry.project_key !== this.config.projectKey) throw new Error('飞书空间身份不匹配');
      return { ...entry, project_key: this.config.projectKey };
    }
    const list = rows(data);
    const matches = list.filter(row => row.project_key === this.config.projectKey); if (matches.length !== 1) throw new Error('飞书空间身份不匹配'); return matches[0];
  }
  private async pages(route: string, body: Row, idOf: (row: Row) => string, pageSize = 100, limit = pageSize * 100): Promise<Row[]> {
    const result: Row[] = []; const seen = new Set<string>(); let total: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const payload = await this.request(route, { ...body, page_num: page, page_size: pageSize });
      const pagination = object(payload.pagination), list = rows(payload.data);
      if (!Number.isInteger(pagination.total) || pagination.total < 0 || pagination.total > limit ||
        pagination.page_num !== undefined && pagination.page_num !== page || total !== undefined && total !== pagination.total || list.length > pageSize) throw new Error('飞书分页不完整或已变化');
      total = pagination.total as number;
      for (const row of list) { const id = idOf(row); if (seen.has(id)) throw new Error('飞书分页ID重复'); seen.add(id); result.push(row); }
      if (result.length === total) return result;
      if (!list.length || result.length > total) throw new Error('飞书分页数量不符');
    }
    throw new Error('飞书分页超过安全上限');
  }
  private verifyItem(row: Row, type?: string): string {
    const id = numericId(row.id); if (row.project_key !== this.config.projectKey || type && row.work_item_type_key !== type) throw new Error('飞书工作项空间或类型不匹配'); return id;
  }
  candidates(types: string[]): Promise<Row[]> {
    return this.pages(`${this.prefix}/work_item/filter`, { work_item_type_keys: types.map(segment), user_keys: [this.config.userKey] }, row => this.verifyItem(row));
  }
  subtaskCandidates(): Promise<Row[]> {
    return this.pages('work_item/subtask/search', { project_keys: [this.config.projectKey], user_keys: [this.config.userKey] }, row => {
      if (row.project_key !== undefined && row.project_key !== this.config.projectKey) throw new Error('飞书子任务空间不匹配');
      if (!row.node_id || typeof row.sub_task?.passed !== 'boolean') throw new Error('飞书子任务证据缺失');
      return `${numericId(row.work_item_id)}:${String(row.node_id)}:${numericId(row.sub_task.id)}`;
    });
  }
  async discover(ids: string[], types: string[], allowMissing = false): Promise<Map<string, string>> {
    if (!ids.length || ids.length > 50) throw new Error('飞书类型发现范围无效');
    const list = await this.pages(`${this.prefix}/work_item/filter`, { work_item_type_keys: types.map(segment), work_item_ids: ids.map(numericWireId) }, row => this.verifyItem(row));
    if (!allowMissing && list.length !== ids.length || list.some(row => !ids.includes(String(row.id)) || !types.includes(row.work_item_type_key))) throw new Error('飞书类型发现不完整');
    return new Map(list.map(row => [String(row.id), row.work_item_type_key]));
  }
  async details(type: string, ids: string[]): Promise<Row[]> {
    if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new Error('飞书批量详情范围无效');
    const batch=feishuReadBatch(this), itemKey=(id:string)=>JSON.stringify([type,id]);
    ids.forEach(numericId);
    const missing=ids.filter(id=>!batch?.items.has(itemKey(id)));
    // Details reuse verified per-item entries, not a second copy of the raw batch.
    const list = missing.length ? rows((await this.requestUncached(`${this.prefix}/work_item/${segment(type)}/query`, { work_item_ids: missing.map(numericId), expand: { need_workflow: true } })).data) : [];
    const seen = new Set<string>();
    for (const row of list) { const id = this.verifyItem({ ...row, work_item_type_key: row.work_item_type_key ?? type }, type);
      if (!missing.includes(id) || seen.has(id)) throw new Error('飞书详情身份不匹配'); seen.add(id); }
    if (seen.size !== missing.length) throw new Error('飞书详情不完整');
    const fetched=new Map(list.map(row=>[String(row.id),row]));
    for(const [id,row] of fetched)rememberFeishuItem(batch,itemKey(id),row);
    return ids.map(id=>fetched.get(id)??batch!.items.get(itemKey(id))!);
  }
  async stateFlow(type: string, id: string): Promise<Row> { return object((await this.request(`${this.prefix}/work_item/${segment(type)}/${numericId(id)}/workflow/query`, { flow_type: 1 })).data); }
  async workflow(type: string, id: string): Promise<Row> { return object((await this.request(`${this.prefix}/work_item/${segment(type)}/${numericId(id)}/workflow/query`, { fields: [], flow_type: 0 })).data); }
  async metadata(type: string): Promise<Row[]> { return rows((await this.request(`${this.prefix}/work_item/${segment(type)}/meta`)).data); }
  async flowRoles(type: string): Promise<FlowRoleDefinition[]> {
    const list = rows((await this.request(`${this.prefix}/flow_roles/${segment(type)}`)).data);
    const seen = new Set<string>();
    return list.map(row => {
      if (typeof row.id !== 'string' || !row.id || seen.has(row.id) || typeof row.name !== 'string' || !row.name.trim() || typeof row.is_owner !== 'boolean') throw new Error('飞书角色定义无效');
      seen.add(row.id);
      // is_owner describes workflow permissions; it does not establish a current personal action.
      return { id: row.id, name: row.name.trim(), isOwner: row.is_owner };
    });
  }
  candidatesForType(type: string): Promise<Row[]> {
    return this.pages(`${this.prefix}/work_item/filter`, { work_item_type_keys: [segment(type)] }, row => this.verifyItem(row, type), 50, 100);
  }
  async users(keys: string[]): Promise<Map<string, string>> {
    if (!keys.length || keys.length > 50 || keys.some(key => !key || key.length > 256)) throw new Error('飞书用户查询范围无效');
    const result = new Map<string, string>();
    for (const row of rows((await this.request('user/query', { user_keys: [...new Set(keys)] })).data)) {
      if (!keys.includes(row.user_key) || result.has(row.user_key)) throw new Error('飞书用户身份不匹配');
      const name = typeof row.name === 'string' ? row.name : row.name?.zh_cn || row.name?.default || row.name?.en_us;
      if (typeof name === 'string' && name.trim()) result.set(row.user_key, name.trim());
    }
    return result;
  }
  async subtasks(type: string, id: string): Promise<Row[]> { return rows((await this.request(`${this.prefix}/work_item/${segment(type)}/${numericId(id)}/workflow/task`)).data); }
  related(type: string, id: string, targetType: string, relationKey: string, relationType: 0 | 1 = 0, limit = 5000): Promise<Row[]> {
    return this.pages(`${this.prefix}/work_item/${segment(type)}/${numericId(id)}/search_by_relation`, {
      relation_work_item_type_key: segment(targetType), relation_key: segment(relationKey), relation_type: relationType,
    }, row => this.verifyItem(row, targetType), 50, limit);
  }
  async operations(id: string, start: number, end: number, cursor?: string): Promise<Row> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || cursor && !/^[A-Za-z0-9_+=/-]{1,256}$/.test(cursor)) throw new Error('飞书操作记录范围无效');
    return object((await this.request('op_record/work_item/list', { project_key: this.config.projectKey, work_item_ids: [numericWireId(id)], page_size: 100, start, end, ...(cursor ? { start_from: cursor } : {}) })).data);
  }
}
