import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDB, type SQLiteDB } from '../db/index.js';
import { getEngineTerminalDecisionInDatabase } from '../db/engine-turn-facts.js';
import { projectEngineTerminalInDatabase, type EngineTerminalProjectionResult } from '../db/queries.js';
import { compactMessageItemsJsonForStorage } from '../messages/storage.js';
import { presentMessage } from '../messages/presenter.js';
import { broadcastFrontendEvent } from '../ws/frontend-client-hub.js';
import { sessionService } from './sessions.js';
import { ServiceError } from './errors.js';
import { buildRepairedTerminalSnapshot, parseRolloutRepairTurns } from './terminal-message-repair.js';
import { createEngineTerminalProjectionService, type EngineTerminalProjectionSnapshot } from './engine-terminal-projection.js';

interface Candidate {
  decisionId: string; sessionId: string; attemptId: string; turnId: string; threadId: string; title: string;
  projectRoot?: string; factId: string; contentDigest: string; contentLength: number;
}
export interface TerminalRepairPreview {
  planId: string | null; expiresAt: number | null; turnCount: number;
  sessions: { id: string; title: string; turnCount: number }[];
  nextCursor: string | null;
  issues: { sessionId: string; title: string; turnCount: number; reason: string }[];
}
interface Plan { owner: string; expiresAt: number; entries: { candidate: Candidate; snapshot: EngineTerminalProjectionSnapshot }[]; result?: { restoredCount: number } }
const fail = (message: string) => new ServiceError(409, message, 'MESSAGE_REPAIR_UNAVAILABLE');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Only read bounded, regular JSONL files below the configured local Codex sessions directory.
async function loadLocalTurns(threadId: string, turns: Set<string>) {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw fail('引擎会话标识无效，无法恢复');
  const root = await fsp.realpath(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'))
    .catch(() => { throw fail('本机没有可用的 Codex 会话记录，无法恢复'); });
  let visited = 0;
  const deadline = Date.now() + 15_000;
  async function find(directory: string, depth: number): Promise<string | undefined> {
    if (depth > 5) return;
    for await (const entry of await fsp.opendir(directory)) {
      if (++visited > 50_000 || Date.now() > deadline) throw fail('本机记录较多，检测超时，请稍后重试');
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) return target;
      if (entry.isDirectory()) { const found = await find(target, depth + 1); if (found) return found; }
    }
  }
  const filename = await find(root, 0);
  if (!filename) throw fail('本机缺少对应的 Codex 原始记录，未修改消息');
  const real = await fsp.realpath(filename);
  const relative = path.relative(root, real);
  const stat = await fsp.lstat(filename);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) {
    throw fail('原始记录不符合安全读取条件');
  }
  const parsed = parseRolloutRepairTurns((await fsp.readFile(real, 'utf8')).split(/\r?\n/), turns);
  if (parsed.threadId !== threadId) throw fail('原始记录与绑定会话不一致');
  return parsed;
}

function candidates(db: SQLiteDB, owner: string, cursor = '', entries?: Plan['entries']): Candidate[] {
  const selection = entries
    ? `AND (${entries.map(() => '(d.session_id = ? AND d.attempt_id = ?)').join(' OR ')})`
    : 'AND d.id > ?';
  const parameters = entries ? entries.flatMap(({ candidate }) => [candidate.sessionId, candidate.attemptId]) : [cursor];
  const rows = db.all(`SELECT d.id AS decision_id, d.session_id, d.attempt_id, d.external_turn_id, d.fact_id, f.safe_payload_json,
      s.engine_session_id, s.title, p.path AS project_path
    FROM engine_terminal_decisions d JOIN engine_turn_facts f ON f.id = d.fact_id
    JOIN sessions s ON s.id = d.session_id LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.owner_user_id = ? AND s.deleted_at IS NULL AND (p.id IS NULL OR p.deleted_at IS NULL)
      AND s.engine = 'codex' AND d.engine = 'codex' AND d.outcome = 'completed' AND d.projected_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = d.session_id AND m.turn_id = d.external_turn_id
        AND m.role = 'assistant' AND COALESCE(m.phase, '') <> 'interaction' AND length(trim(m.content)) > 0)
    ${selection} ORDER BY d.id LIMIT 21`, [owner, ...parameters]);
  return rows.map((row) => {
    let fact: Record<string, unknown> = {};
    try { const value = JSON.parse(String(row.safe_payload_json)); if (value && typeof value === 'object') fact = value; } catch { /* Report an unverifiable turn individually. */ }
    return { decisionId: String(row.decision_id), sessionId: String(row.session_id), attemptId: String(row.attempt_id), turnId: String(row.external_turn_id),
      threadId: String(row.engine_session_id), title: String(row.title || '未命名会话').slice(0, 200), factId: String(row.fact_id),
      contentDigest: String(fact.contentDigest), contentLength: Number(fact.contentLength),
      ...(typeof row.project_path === 'string' ? { projectRoot: row.project_path } : {}) };
  });
}

function writeBackup(bytes: Uint8Array) {
  const database = process.env.RELAY_DB_PATH ? path.resolve(process.env.RELAY_DB_PATH) : path.join(process.cwd(), 'data/relay.db');
  const directory = path.join(path.dirname(database), 'repair-backups');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `before-message-repair-${Date.now()}-${randomUUID()}.db`), bytes, { flag: 'wx' });
}

export function createOnlineTerminalRepair(options: {
  db?: () => SQLiteDB;
  maintenanceBusy?: () => boolean;
  loadTurns?: typeof loadLocalTurns;
  backup?: (bytes: Uint8Array) => void;
  /** Must be atomic: a failed persistence call must leave the prior disk snapshot intact. */
  persist?: (db: SQLiteDB) => void;
  publish?: (result: EngineTerminalProjectionResult) => void;
  now?: () => number;
} = {}) {
  const database = options.db ?? getDB;
  const now = options.now ?? Date.now;
  const plans = new Map<string, Plan>();
  let busy = false;
  function available(db: SQLiteDB) {
    if (options.maintenanceBusy?.()) throw fail('已有服务或引擎维护操作，请完成后重试');
    if (Number(db.get(`SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NULL
      AND (active_attempt_id IS NOT NULL OR status IN ('queued','pending','processing','recovering','awaiting_action','stopping'))`)?.count)) {
      throw fail('仍有运行中或等待处理的任务，请全部结束后恢复');
    }
  }
  return {
    async preview(owner: string, cursor = ''): Promise<TerminalRepairPreview> {
      if (busy) throw fail('正在检测或恢复消息，请稍候');
      busy = true;
      try {
        for (const [id, plan] of plans) if (plan.expiresAt <= now()) plans.delete(id);
        const found = candidates(database(), owner, cursor);
        const rows = found.slice(0, 20);
        const nextCursor = found.length > 20 ? rows.at(-1)!.decisionId : null;
        const issues: TerminalRepairPreview['issues'] = [];
        const issue = (candidate: Candidate, reason: string) => issues.push({ sessionId: candidate.sessionId,
          title: candidate.title, turnCount: 1, reason });
        const entries: Plan['entries'] = [];
        let retainedBytes = 0;
        const deadline = Date.now() + 30_000;
        for (const threadId of new Set(rows.map((row) => row.threadId))) {
          const group = rows.filter((row) => row.threadId === threadId);
          let parsed: Awaited<ReturnType<typeof loadLocalTurns>>;
          try {
            if (Date.now() > deadline) throw fail('检测超时，请稍后重试');
            parsed = await (options.loadTurns ?? loadLocalTurns)(threadId, new Set(group.map((row) => row.turnId)));
            if (Date.now() > deadline) throw fail('检测超时，请稍后重试');
            if (parsed.threadId !== threadId) throw fail('原始记录与绑定会话不一致');
          } catch (error) {
            for (const candidate of group) issue(candidate, error instanceof ServiceError ? error.message : '原始记录读取失败，请检查本机记录后重试');
            continue;
          }
          for (const candidate of group) {
            try {
              const snapshot = buildRepairedTerminalSnapshot({ messageId: randomUUID(), turnId: candidate.turnId,
                items: parsed.items.get(candidate.turnId) ?? [], duration: parsed.durations.get(candidate.turnId), projectRoot: candidate.projectRoot });
              if (!snapshot.content.trim() || hash(snapshot.content) !== candidate.contentDigest || snapshot.content.length !== candidate.contentLength) {
                throw fail('恢复正文与原始结果校验不一致，未修改消息');
              }
              snapshot.items = compactMessageItemsJsonForStorage(snapshot.items ?? null).value;
              const bytes = Buffer.byteLength(JSON.stringify(snapshot));
              if (retainedBytes + bytes > 16 * 1024 * 1024) throw fail('本批恢复内容过大，请先恢复可用记录后重新检测');
              retainedBytes += bytes;
              entries.push({ candidate, snapshot });
            } catch (error) {
              issue(candidate, error instanceof ServiceError ? error.message : '原始记录无法解析，未修改此条消息');
            }
          }
        }
        // At most one plan per account and three in total; never retain raw command output.
        for (const [id, plan] of plans) if (plan.owner === owner) plans.delete(id);
        while (entries.length && plans.size >= 3) plans.delete(plans.keys().next().value!);
        const planId = entries.length ? randomUUID() : null;
        const expiresAt = entries.length ? now() + 10 * 60_000 : null;
        if (planId && expiresAt !== null) plans.set(planId, { owner, expiresAt, entries });
        const ready = entries.map(({ candidate }) => candidate);
        return { planId, expiresAt, turnCount: entries.length, nextCursor, issues,
          sessions: [...new Set(ready.map((row) => row.sessionId))].map((id) => ({ id,
            title: ready.find((row) => row.sessionId === id)!.title, turnCount: ready.filter((row) => row.sessionId === id).length })) };
      } finally { busy = false; }
    },
    apply(owner: string, planId: string) {
      if (busy) throw fail('已有消息恢复操作，请稍候');
      const plan = plans.get(planId);
      if (!plan || plan.owner !== owner || plan.expiresAt <= now()) throw fail('检测结果已失效，请重新检测');
      if (plan.result) return plan.result;
      busy = true;
      try {
        const db = database();
        available(db);
        const current = candidates(db, owner, '', plan.entries);
        const pending = plan.entries.filter(({ candidate }) => current.some((row) => row.attemptId === candidate.attemptId && row.sessionId === candidate.sessionId));
        for (const { candidate } of pending) {
          const row = current.find((entry) => entry.sessionId === candidate.sessionId && entry.attemptId === candidate.attemptId)!;
          if (row.threadId !== candidate.threadId || row.turnId !== candidate.turnId || row.factId !== candidate.factId
            || row.contentDigest !== candidate.contentDigest || row.contentLength !== candidate.contentLength
            || row.projectRoot !== candidate.projectRoot) throw fail('会话或原始结果已变化，请重新检测');
        }
        if (!pending.length) { plan.result = { restoredCount: 0 }; return plan.result; }
        // No await from the final checks through backup, writes and persistence:
        // another turn or maintenance operation cannot enter this critical section.
        const foreignKeys = Number(db.get('PRAGMA foreign_keys')?.foreign_keys) === 1;
        const restoreForeignKeys = () => db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
        const before = db.raw().export();
        // sql.js export reopens the database and resets connection PRAGMAs.
        restoreForeignKeys();
        (options.backup ?? writeBackup)(before);
        const results: EngineTerminalProjectionResult[] = [];
        try {
          const service = createEngineTerminalProjectionService({ project: (input) => projectEngineTerminalInDatabase(db, input) });
          for (const { candidate, snapshot } of pending) {
            const decision = getEngineTerminalDecisionInDatabase(db, candidate.sessionId, 'codex', candidate.attemptId);
            if (!decision) throw fail('原始结果已变化，请重新检测');
            results.push(service.project({ decision, snapshot }));
          }
          (options.persist ?? ((value) => value.saveToFile({ failOnLocked: true, atomic: true })))(db);
        } catch {
          // Atomic persistence leaves the previous disk file intact. Roll back memory
          // without attempting a second disk write that could fail or damage it.
          db.restoreFromBytes(before);
          throw new ServiceError(500, '恢复保存失败，原数据库文件未替换，已还原内存并保留备份；请检查磁盘空间或文件占用后重新检测', 'MESSAGE_REPAIR_SAVE_FAILED');
        } finally { restoreForeignKeys(); }
        plan.result = { restoredCount: results.filter((result) => result.projected).length };
        plan.entries = [];
        for (const result of results) {
          try {
            if (options.publish) options.publish(result);
            else {
              broadcastFrontendEvent({ type: 'message_saved', sessionId: result.decision.sessionId,
                messageRevision: result.savedMessage.revision, message: presentMessage(result.savedMessage.message) });
              broadcastFrontendEvent({ type: 'session_updated', sessionId: result.decision.sessionId, session: sessionService.require(result.decision.sessionId) });
            }
          } catch { /* Persisted data is authoritative; refresh can recover a failed publication. */ }
        }
        return plan.result;
      } finally { busy = false; }
    },
  };
}
