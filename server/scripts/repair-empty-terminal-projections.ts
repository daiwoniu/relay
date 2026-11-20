// Read-only by default. Apply only with the formal backend stopped.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { loadRelayConfig } from '../../scripts/lib/relay-config.mjs';
import { SQLiteDB } from '../src/db/index.js';
import { getEngineTerminalDecisionInDatabase } from '../src/db/engine-turn-facts.js';
import { projectEngineTerminalInDatabase } from '../src/db/queries.js';
import { buildRepairedTerminalSnapshot, parseRolloutRepairTurns, requireOfflineBackend } from '../src/services/terminal-message-repair.js';
import { createEngineTerminalProjectionService } from '../src/services/engine-terminal-projection.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('tsx scripts/repair-empty-terminal-projections.ts --db <db> --session <Relay ID> --rollout <Codex JSONL> [--apply] [--require-idle]');
  process.exit(0);
}
const flags = new Map<string, string>();
let apply = false;
let requireIdle = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') { apply = true; continue; }
  if (args[i] === '--require-idle') { requireIdle = true; continue; }
  if (!['--db', '--session', '--rollout'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数无效；使用 --help');
  flags.set(args[i], args[++i]);
}
if (!flags.get('--db') || !flags.get('--session') || !flags.get('--rollout')) throw new Error('必须指定 --db、--session 和 --rollout');
const dbPath = fs.realpathSync(flags.get('--db')!);
const rolloutPath = fs.realpathSync(flags.get('--rollout')!);
const sessionId = flags.get('--session')!;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadRelayConfig(path.join(root, 'config/relay.conf'));
const port = config.backend.port;
const probeHost = config.backend.connectHost;
const requireBackendStopped = () => requireOfflineBackend(port, probeHost);
if (apply) await requireBackendStopped();
const original = fs.readFileSync(dbPath);
if (original[18] === 2 || original[19] === 2 || fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`)) {
  throw new Error('此旧版离线修复工具不支持 WAL 数据库；请使用新版 Relay 内的缺失回复恢复功能');
}
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const originalDigest = digest(original);
const require = createRequire(import.meta.url);
const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
const raw = new SQL.Database(original);
if (raw.exec("SELECT 1 FROM sqlite_master WHERE name='_relay_storage_meta'").length) {
  raw.close();
  throw new Error('此旧版离线修复工具不支持 Native 数据库；请使用新版 Relay 内的缺失回复恢复功能');
}
const db = new SQLiteDB(raw, ':memory:');
try {
  if (requireIdle) {
    const active = db.get("SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NULL AND (active_attempt_id IS NOT NULL OR status IN ('queued','pending','processing','recovering','awaiting_action','stopping'))");
    if (Number(active?.count)) throw new Error('仍有活动任务，未停止服务；请等待所有任务结束后重试');
  }
  const session = db.get(`SELECT s.engine, s.engine_session_id, s.active_attempt_id, p.path AS project_path
    FROM sessions s LEFT JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND s.deleted_at IS NULL`, [sessionId]);
  if (session?.engine !== 'codex') throw new Error('目标不是可恢复的 Codex 会话');
  if (session.active_attempt_id) throw new Error('目标会话仍有活动 attempt，拒绝修复');
  const candidates = db.all(`SELECT d.attempt_id, d.external_turn_id, f.safe_payload_json
    FROM engine_terminal_decisions d JOIN engine_turn_facts f ON f.id = d.fact_id
    WHERE d.session_id = ? AND d.engine = 'codex' AND d.outcome = 'completed' AND d.projected_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = d.session_id AND m.turn_id = d.external_turn_id
        AND m.role = 'assistant' AND COALESCE(m.phase, '') <> 'interaction' AND length(trim(m.content)) > 0) ORDER BY d.decided_at`, [sessionId]);
  const wanted = new Set(candidates.map((row) => String(row.external_turn_id)));
  const { threadId, items, durations } = parseRolloutRepairTurns(fs.readFileSync(rolloutPath, 'utf8').split(/\r?\n/), wanted);
  if (threadId !== session.engine_session_id) throw new Error('Codex JSONL 与 Relay 绑定线程不匹配');
  const service = createEngineTerminalProjectionService({ project: (input) => projectEngineTerminalInDatabase(db, input) });
  for (const candidate of candidates) {
    const turnId = String(candidate.external_turn_id);
    const snapshot = buildRepairedTerminalSnapshot({ turnId, messageId: randomUUID(), items: items.get(turnId) ?? [],
      duration: durations.get(turnId), projectRoot: typeof session.project_path === 'string' ? session.project_path : undefined });
    const fact = JSON.parse(String(candidate.safe_payload_json));
    if (!snapshot.content.trim() || digest(snapshot.content) !== fact.contentDigest || snapshot.content.length !== fact.contentLength) {
      throw new Error('恢复正文与原始终态事实摘要不一致，拒绝写入');
    }
    const decision = getEngineTerminalDecisionInDatabase(db, sessionId, 'codex', String(candidate.attempt_id));
    if (!decision) throw new Error('缺少终态决定');
    service.project({ decision, snapshot });
    console.log(JSON.stringify({ turnId, contentLength: snapshot.content.length,
      processItems: JSON.parse(snapshot.items || '[]').length, changedFiles: snapshot.metadata?.changedFiles?.length ?? 0,
      mode: apply ? 'apply' : 'preview' }));
  }
  if (apply && candidates.length) {
    await requireBackendStopped();
    if (digest(fs.readFileSync(dbPath)) !== originalDigest) throw new Error('数据库已发生变化，拒绝覆盖');
    if (raw.exec('PRAGMA integrity_check')[0]?.values[0]?.[0] !== 'ok') throw new Error('修复库完整性校验失败');
    if (raw.exec('PRAGMA foreign_key_check').length) throw new Error('修复库外键校验失败');
    const backup = `${dbPath}.pre-terminal-repair-${Date.now()}.bak`;
    fs.writeFileSync(backup, original, { flag: 'wx' });
    const temp = `${dbPath}.terminal-repair-${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, raw.export(), { flag: 'wx' });
      const verified = new SQL.Database(fs.readFileSync(temp));
      try { if (verified.exec('PRAGMA integrity_check')[0]?.values[0]?.[0] !== 'ok') throw new Error('磁盘回读校验失败'); }
      finally { verified.close(); }
      await requireBackendStopped();
      if (digest(fs.readFileSync(dbPath)) !== originalDigest) throw new Error('写入前数据库发生变化，拒绝覆盖');
      fs.renameSync(temp, dbPath);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    console.log(`已恢复 ${candidates.length} 个回合；备份保留在数据库同目录。`);
  } else console.log(`只读预览：${candidates.length} 个待修复回合。`);
} finally { raw.close(); }
