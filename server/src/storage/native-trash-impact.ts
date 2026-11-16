import { createHash } from 'node:crypto';
import { MessageAttachmentDtoSchema, TrashImpactDtoSchema } from '../contracts/index.js';
import { StorageContractError } from './command-boundary.js';
import type { nativeQueries } from './native-queries.js';

type DB = ReturnType<typeof nativeQueries>;
type Actor = { id: string; role: string };
const MAX_ROWS = 100_000, MAX_BYTES = 64 * 1024 * 1024, MAX_ROW_BYTES = 7 * 1024 * 1024;
function deny(code: ConstructorParameters<typeof StorageContractError>[0]): never { throw new StorageContractError(code); }

/** Worker-local, inside the caller's read/commit transaction. No paths or relation bodies leave this boundary. */
export function readTrashImpact(db: DB, actor: Actor, kind: 'project' | 'session', target: string, expectedRevision?: string) {
  const project = kind === 'project'
    ? db.get('SELECT id,owner_user_id,deletion_protected FROM projects WHERE id=? AND deleted_at IS NOT NULL', [target])
    : db.get(`SELECT p.id,p.owner_user_id,p.deletion_protected FROM projects p JOIN sessions s ON s.project_id=p.id
        WHERE s.id=? AND s.deleted_at IS NOT NULL AND p.deleted_at IS NULL`, [target]);
  if (!project?.owner_user_id) deny('NOT_FOUND');
  const owner = kind === 'project' ? project.owner_user_id : db.get('SELECT owner_user_id FROM sessions WHERE id=?', [target])?.owner_user_id;
  if (!owner || owner !== actor.id && actor.role !== 'admin') deny('FORBIDDEN');
  if (kind === 'project' && (project.deletion_protected || db.get('SELECT 1 FROM users WHERE default_project_id=? LIMIT 1', [target]))) deny('CONFLICT');
  const sessionSelect = kind === 'project' ? 'SELECT id FROM sessions WHERE project_id=?' : 'SELECT id FROM sessions WHERE id=?';
  const sessionWhere = `session_id IN (${sessionSelect})`;
  if (db.get(`SELECT 1 FROM sessions WHERE id IN (${sessionSelect}) AND
      (owner_user_id IS NULL OR owner_user_id='' OR active_attempt_id IS NOT NULL OR status IS NULL OR status NOT IN ('idle','completed','failed','stopped','interrupted')) LIMIT 1`, [target])
    || db.get(`SELECT 1 FROM engine_resource_leases WHERE ${sessionWhere} LIMIT 1`, [target])
    || db.get(`SELECT 1 FROM engine_queue_entries WHERE ${sessionWhere} AND state IN ('queued','claimed','running') LIMIT 1`, [target])
    || db.get(`SELECT 1 FROM session_followups WHERE ${sessionWhere} AND state IN ('received','steering','queued','dispatching','uncertain') LIMIT 1`, [target])
    || db.get(`SELECT 1 FROM _relay_external_operations WHERE ${sessionWhere} AND phase IN ('prepared','dispatched') LIMIT 1`, [target])) deny('CONFLICT');

  const hash = createHash('sha256');
  let rowCount = 0, byteCount = 0;
  const frame = (value: string | Uint8Array) => { hash.update(`${Buffer.byteLength(value)}:`); hash.update(value); };
  frame('relay-trash-impact-v1'); frame(kind); frame(target);
  // Static server table/where expressions only. Budget before materializing rows; then stream one row at a time.
  const scan = (table: string, where: string, params: string[], visit?: (row: Record<string, any>) => void) => {
    const columns = db.all(`PRAGMA table_info(${table})`);
    if (!columns.length || columns.some(c => !/^[a-z_][a-z0-9_]*$/i.test(String(c.name)))) deny('STORAGE_UNAVAILABLE');
    const bytes = columns.map(c => `coalesce(length(CAST("${c.name}" AS BLOB)),0)`).join('+');
    const budget = db.get(`SELECT count(*) AS rows,coalesce(sum(${bytes}),0) AS bytes,coalesce(max(${bytes}),0) AS largest FROM ${table} WHERE ${where}`, params)!;
    rowCount += Number(budget.rows); byteCount += Number(budget.bytes);
    if (!Number.isSafeInteger(rowCount) || !Number.isSafeInteger(byteCount) || rowCount > MAX_ROWS || byteCount > MAX_BYTES || Number(budget.largest) > MAX_ROW_BYTES) deny('PAYLOAD_TOO_LARGE');
    const primary = columns.filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => `"${c.name}"`).join(',') || 'rowid';
    frame(table);
    for (const column of columns) { frame(String(column.name)); frame(String(column.type)); }
    for (const row of db.iterate(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${primary}`, params)) {
      frame('row');
      for (const column of columns) {
        const value = row[column.name];
        if (value === null) frame('null');
        else if (typeof value === 'string') { frame('text'); frame(value); }
        else if (typeof value === 'number' && Number.isFinite(value)) { frame('number'); frame(String(value)); }
        else if (value instanceof Uint8Array) { frame('blob'); frame(value); }
        else deny('STORAGE_UNAVAILABLE');
      }
      visit?.(row);
    }
    frame('end'); return Number(budget.rows);
  };
  scan('projects', 'id=?', [String(project.id)]);
  const sessionCount = scan('sessions', `id IN (${sessionSelect})`, [target]);
  let attachmentCount = 0, releasableBytes = 0;
  const messageCount = scan('messages', sessionWhere, [target], row => {
    if (row.metadata == null || row.metadata === '') return;
    let metadata: any;
    try { metadata = JSON.parse(row.metadata); } catch { deny('CONFLICT'); }
    // Historic process-only metadata has no attachments. Malformed declarations must never appear as zero files.
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) deny('CONFLICT');
    if (!Object.hasOwn(metadata, 'attachments')) return;
    if (!Array.isArray(metadata.attachments) || metadata.attachments.length > 4096) deny('CONFLICT');
    const ids = new Set<string>();
    for (const raw of metadata.attachments) {
      const parsed = MessageAttachmentDtoSchema.safeParse(raw);
      if (!parsed.success) deny('CONFLICT');
      if (parsed.data.kind !== 'uploaded_file') continue;
      if (!Number.isSafeInteger(parsed.data.size)) deny('CONFLICT');
      if (ids.has(parsed.data.id)) deny('CONFLICT'); ids.add(parsed.data.id);
      attachmentCount++; releasableBytes += parsed.data.size;
      if (!Number.isSafeInteger(releasableBytes)) deny('PAYLOAD_TOO_LARGE');
    }
  });
  const shareCount = scan('shared_records', `source_session_id IN (${sessionSelect})`, [target]);
  for (const table of ['context_compaction_events','engine_terminal_decisions','engine_turn_facts','engine_queue_entries','engine_resource_leases',
    'session_read_receipts','session_followups','workspace_console_links','_relay_external_operations']) scan(table, sessionWhere, [target]);
  const attempts = `SELECT attempt_id FROM engine_terminal_decisions WHERE ${sessionWhere}
    UNION SELECT attempt_id FROM engine_turn_facts WHERE ${sessionWhere}
    UNION SELECT attempt_id FROM engine_queue_entries WHERE ${sessionWhere}`;
  const effects=`SELECT id FROM _relay_external_operations WHERE ${sessionWhere}`;
  scan('_relay_forks',`id IN (${effects})`,[target]);
  scan('_relay_fork_messages',`operation_id IN (${effects})`,[target]);
  scan('engine_capacity_events', `attempt_id IN (${attempts})`, [target,target,target]);
  scan('engine_provider_cooldowns', `probe_attempt_id IN (${attempts})`, [target,target,target]);
  scan('approval_trust_settings', `(${sessionWhere})${kind === 'project' ? ' OR project_id=?' : ''}`, kind === 'project' ? [target,target] : [target]);
  scan('sidebar_order_items', `(item_type='session' AND item_id IN (${sessionSelect}))${kind === 'project' ? " OR (item_type='project' AND item_id=?) OR scope=?" : ''}`,
    kind === 'project' ? [target,target,`project:${target}`] : [target]);
  if (kind === 'project') {
    scan('sidebar_order_scopes', 'scope=?', [`project:${target}`]);
    scan('project_members', 'project_id=?', [target]);
  }
  const impactRevision = hash.digest('hex');
  if (expectedRevision !== undefined && expectedRevision !== impactRevision) deny('CONFLICT');
  return TrashImpactDtoSchema.parse({ sessionCount,messageCount,shareCount,attachmentCount,releasableBytes,impactRevision });
}
