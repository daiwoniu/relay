import net from 'node:net';
import { resolveRecoveryTurn, type RecoveryTurnItem } from '../codex/turn-recovery.js';
import { removeNarrativeItem } from '../process-timeline.js';
import { collectChangedFiles, hasIncompleteChangedFilesReport } from '../messages/changed-files.js';
import { RELAY_FILE_CHANGE_REPORT_TOOL } from '../messages/file-change-report.js';
import type { EngineTerminalProjectionSnapshot } from './engine-terminal-projection.js';

type RecordValue = Record<string, unknown>;
function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const camel = (key: string) => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
function durationMs(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.secs !== 'number' || typeof value.nanos !== 'number') return undefined;
  const duration = value.secs * 1000 + value.nanos / 1_000_000;
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function normalizeRolloutItem(value: unknown): RecoveryTurnItem {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string' || !value.type) {
    throw new Error('Codex 过程项格式无效');
  }
  const item = Object.fromEntries(Object.entries(value).map(([key, entry]) => [camel(key), entry])) as RecoveryTurnItem;
  item.type = value.type[0].toLowerCase() + value.type.slice(1);
  if (item.type === 'agentMessage') {
    item.text = Array.isArray(value.content)
      ? value.content.map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '').join('')
      : typeof value.text === 'string' ? value.text : '';
  }
  if (item.type === 'reasoning') {
    item.summary = Array.isArray(value.summary_text) ? value.summary_text : [];
    item.content = Array.isArray(value.raw_content) ? value.raw_content : [];
  }
  if (item.type === 'commandExecution' && Array.isArray(value.command)) {
    // Preserve argument boundaries in the display command; never execute this text.
    item.command = value.command.map((part) => /[\s"']/.test(String(part)) ? JSON.stringify(part) : String(part)).join(' ');
  }
  const elapsed = durationMs(value.duration);
  if (elapsed !== undefined) item.durationMs = elapsed;
  if (item.type === 'fileChange' && isRecord(value.changes)) {
    item.changes = Object.entries(value.changes).map(([filePath, change]) => {
      if (!isRecord(change) || typeof change.type !== 'string') throw new Error('Codex 文件变更项格式无效');
      return { ...Object.fromEntries(Object.entries(change).map(([key, entry]) => [camel(key), entry])),
        path: filePath, kind: { type: change.type } };
    });
  }
  if (item.type === 'dynamicToolCall') {
    item.result = value.content_items ?? value.result;
    if (value.tool === RELAY_FILE_CHANGE_REPORT_TOOL && value.namespace === undefined) item.namespace = null;
  }
  return item;
}

export function parseRolloutRepairTurns(lines: Iterable<string>, wanted: ReadonlySet<string>) {
  let threadId: string | undefined;
  const items = new Map<string, RecoveryTurnItem[]>();
  const durations = new Map<string, number>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as RecordValue;
    if (!isRecord(record.payload)) continue;
    const payload = record.payload;
    if (record.type === 'session_meta' && typeof payload.id === 'string') threadId = payload.id;
    if (typeof payload.turn_id !== 'string' || !wanted.has(payload.turn_id)) continue;
    const turnId = payload.turn_id;
    if (payload.type === 'task_complete' && typeof payload.duration_ms === 'number') durations.set(turnId, payload.duration_ms);
    if (record.type !== 'event_msg' || payload.type !== 'item_completed') continue;
    const item = normalizeRolloutItem(payload.item);
    const turnItems = items.get(turnId) ?? [];
    const index = turnItems.findIndex((entry) => entry.id === item.id);
    if (index < 0) turnItems.push(item); else turnItems[index] = item;
    items.set(turnId, turnItems);
  }
  return { threadId, items, durations };
}

export function buildRepairedTerminalSnapshot(input: {
  turnId: string; messageId: string; items: RecoveryTurnItem[]; duration?: number; projectRoot?: string;
}): EngineTerminalProjectionSnapshot {
  const recovered = resolveRecoveryTurn({ turns: [{ id: input.turnId, status: 'completed', items: input.items }] }, input.turnId);
  const changedFiles = collectChangedFiles(recovered.items, input.projectRoot);
  return {
    messageId: input.messageId, turnId: input.turnId, content: recovered.content,
    items: JSON.stringify(recovered.items), duration: input.duration,
    metadata: {
      processContent: recovered.processContent,
      processTimeline: recovered.finalAnswerItemId
        ? removeNarrativeItem(recovered.processTimeline, recovered.finalAnswerItemId) : recovered.processTimeline,
      executionStage: 'responding',
      ...(changedFiles.length ? { changedFiles } : {}),
      ...(hasIncompleteChangedFilesReport(recovered.items, input.projectRoot) ? { changedFilesIncomplete: true } : {}),
    },
  };
}

export async function requireOfflineBackend(port: number, host = '127.0.0.1'): Promise<void> {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') throw new Error('禁网沙箱无法证明后端离线，拒绝写库');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('后端端口无效');
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2_000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('正式后端仍在运行；恢复入口不会自动停服，请在回合结束后手动停止 Relay')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('后端状态无法确认，拒绝写入')); });
    socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
  });
}
