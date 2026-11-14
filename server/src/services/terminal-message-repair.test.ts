import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRepairedTerminalSnapshot, normalizeRolloutItem, parseRolloutRepairTurns, requireOfflineBackend } from './terminal-message-repair.js';
import { presentMessage, presentMessageSummary } from '../messages/presenter.js';
import { compactMessageItemsJsonForStorage } from '../messages/storage.js';
import { serializeTerminalMessageMetadata } from '../message-metadata.js';

test('真实 JSONL 项映射后保持正文去重、推理数组、命令参数、工具输出及文件列表', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repair-items-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectRoot, 'report.md'), 'report');
  const item = (value: unknown, turnId = 'turn-1') => JSON.stringify({ type: 'event_msg', payload: {
    type: 'item_completed', turn_id: turnId, item: value } });
  const parsed = parseRolloutRepairTurns([
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
    item({ type: 'UserMessage', id: 'user', content: [] }),
    item({ type: 'AgentMessage', id: 'progress', phase: 'commentary', content: [{ text: '正在核查' }] }),
    item({ type: 'Reasoning', id: 'reasoning', summary_text: ['摘要一', '摘要二'], raw_content: [] }),
    item({ type: 'CommandExecution', id: 'command', command: ['python', 'a b.py'], status: 'completed',
      aggregated_output: 'line one\nline two', duration: { secs: 1, nanos: 500_000_000 }, exit_code: 0 }),
    item({ type: 'FileChange', id: 'file', status: 'completed', changes: { 'a.ts': { type: 'update', unified_diff: 'diff' } } }),
    item({ type: 'DynamicToolCall', id: 'reported', status: 'completed', success: true,
      tool: 'relay_report_file_changes', arguments: { version: 1, reportedFileChanges: [{ path: 'report.md', changeType: 'added' }] },
      content_items: [{ type: 'inputText', text: 'reported' }], duration: { secs: 0, nanos: 10_000_000 } }),
    item({ type: 'AgentMessage', id: 'final', phase: 'final_answer', content: [{ text: '部分结论' }] }),
    item({ type: 'AgentMessage', id: 'final', phase: 'final_answer', content: [{ text: '完整结论' }] }),
    item({ type: 'AgentMessage', id: 'foreign', phase: 'final_answer', content: [{ text: '别的回合' }] }, 'other'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 5000 } }),
  ], new Set(['turn-1']));
  assert.equal(parsed.threadId, 'thread-1');
  const snapshot = buildRepairedTerminalSnapshot({ turnId: 'turn-1', messageId: 'message-1',
    items: parsed.items.get('turn-1')!, duration: parsed.durations.get('turn-1'), projectRoot });
  assert.equal(snapshot.content, '完整结论');
  assert.equal(snapshot.duration, 5000);
  const timeline = snapshot.metadata?.processTimeline ?? [];
  assert.deepEqual(timeline.filter((entry) => entry.type === 'narrative').map((entry) => entry.content), ['正在核查']);
  assert.deepEqual(snapshot.metadata?.changedFiles?.map((entry) => [entry.path, entry.changeType]), [['a.ts', 'modified'], ['report.md', 'added']]);
  const record = { id: 'message-1', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant' as const,
    content: snapshot.content, phase: 'final_answer', stopped: 0, created_at: 100, duration: snapshot.duration ?? null,
    items: compactMessageItemsJsonForStorage(snapshot.items ?? null).value,
    metadata: serializeTerminalMessageMetadata('completed', snapshot.metadata) };
  const detail = presentMessage(record);
  assert.deepEqual(detail.items?.find((entry) => entry.id === 'reasoning')?.details.summary, ['摘要一', '摘要二']);
  const command = detail.items?.find((entry) => entry.id === 'command');
  assert.equal(command?.details.command, 'python "a b.py"');
  assert.equal(command?.details.durationMs, 1500);
  assert.ok(command?.details.outputSummary);
  assert.equal(detail.items?.find((entry) => entry.id === 'reported')?.details.durationMs, 10);
  const summary = presentMessageSummary(record);
  assert.equal(summary.changedFileCount, 2);
  assert.equal(summary.processNarrativeCount, 1);
});

test('空推理摘要不增加嵌套，损坏过程项拒绝恢复', () => {
  assert.deepEqual(normalizeRolloutItem({ id: 'r', type: 'Reasoning', summary_text: [], raw_content: [] }).summary, []);
  assert.throws(() => normalizeRolloutItem({ id: 'invalid' }), /格式无效/);
  assert.throws(() => normalizeRolloutItem({ id: 'f', type: 'FileChange', changes: { 'a.ts': null } }), /格式无效/);
});

test('离线入口拒绝在线端口且不停止它，端口真正关闭后才允许继续', async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
      await assert.rejects(requireOfflineBackend(address.port), /禁网沙箱/);
    } else {
      await assert.rejects(requireOfflineBackend(address.port), /不会自动停服/);
    }
    assert.equal(server.listening, true);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1') await requireOfflineBackend(address.port);
});
