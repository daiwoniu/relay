import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待恢复结果超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('启动恢复可补回 completed 结果并继续接收 inProgress 回合', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-turn-recovery-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const codex = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => codex.once('listening', resolve));
  const address = codex.address();
  assert(address && typeof address === 'object');

  process.env.RELAY_DB_PATH = dbPath;
  process.env.CODEX_WS_URL = `ws://127.0.0.1:${address.port}`;
  process.env.RELAY_RECOVERY_INTERACTION_TIMEOUT_MS = '50';
  t.after(() => {
    delete process.env.RELAY_DB_PATH;
    delete process.env.CODEX_WS_URL;
    delete process.env.RELAY_RECOVERY_INTERACTION_TIMEOUT_MS;
    codex.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  codex.on('connection', (socket) => {
    let activeThreadId = '';
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialized') return;
      if (message.method === 'initialize' || message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === 'thread/resume') {
        activeThreadId = message.params.threadId;
        const status = activeThreadId === 'thread-waiting'
          ? { type: 'active', activeFlags: ['waitingOnApproval'] }
          : activeThreadId === 'thread-running'
            ? { type: 'active', activeFlags: [] }
            : { type: 'idle' };
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: activeThreadId, status } } }));
      } else if (message.method === 'thread/turns/list') {
        if (activeThreadId === 'thread-recovery') {
          socket.send(JSON.stringify({ id: message.id, result: {
            data: [{ id: 'turn-recovery', status: 'completed', durationMs: 3000 }],
            nextCursor: null,
          } }));
          return;
        }
        if (activeThreadId === 'thread-waiting') {
          socket.send(JSON.stringify({ id: message.id, result: {
            data: [{ id: 'turn-waiting', status: 'inProgress' }],
            nextCursor: null,
          } }));
          return;
        }
        socket.send(JSON.stringify({ id: message.id, result: {
          data: [{ id: 'turn-running', status: 'inProgress' }],
          nextCursor: null,
        } }));
      } else if (message.method === 'thread/items/list') {
        const items = activeThreadId === 'thread-recovery'
          ? [
              { item: { id: 'process', type: 'agentMessage', phase: 'commentary', text: '恢复过程' } },
              { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '恢复成功' } },
            ]
          : activeThreadId === 'thread-running'
            ? [{ item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' } }]
            : [];
        socket.send(JSON.stringify({ id: message.id, result: { data: items, nextCursor: null } }));
        if (activeThreadId !== 'thread-running') return;
        socket.send(JSON.stringify({ method: 'item/completed', params: {
          threadId: activeThreadId,
          turnId: 'turn-running',
          item: { id: 'command-1', type: 'commandExecution', status: 'completed' },
        } }));
        socket.send(JSON.stringify({ method: 'item/started', params: {
          threadId: activeThreadId,
          turnId: 'turn-running',
          item: { id: 'answer-running', type: 'agentMessage', phase: 'final_answer' },
        } }));
        socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: activeThreadId,
          turnId: 'turn-running',
          itemId: 'answer-running',
          phase: 'final_answer',
          delta: '继续输出成功',
        } }));
        socket.send(JSON.stringify({ method: 'turn/completed', params: {
          threadId: activeThreadId,
          turn: { id: 'turn-running', status: 'completed', items: [] },
        } }));
      }
    });
  });

  const { getDB, initDB } = await import('../db/index.js');
  const {
    getEngineTerminalDecisionInDatabase,
    listEngineTurnFactsInDatabase,
  } = await import('../db/engine-turn-facts.js');
  const { getCooldownInDatabase, upsertCooldownInDatabase } = await import('../db/engine-concurrency.js');
  const queries = await import('../db/queries.js');
  await initDB();
  const session = queries.createSession('恢复测试');
  queries.setSessionCodexThreadId(session.id, 'thread-recovery');
  queries.updateSession(session.id, { status: 'processing' });
  queries.setSessionActiveTurn(session.id, 'turn-recovery', Date.now() - 3000);
  queries.setSessionActiveAttempt(session.id, 'attempt-recovery');
  const runningSession = queries.createSession('继续运行测试');
  queries.setSessionCodexThreadId(runningSession.id, 'thread-running');
  queries.updateSession(runningSession.id, { status: 'processing' });
  queries.setSessionActiveTurn(runningSession.id, 'turn-running', Date.now() - 1000);
  queries.setSessionActiveAttempt(runningSession.id, 'attempt-running');
  getDB().run(
    `INSERT INTO engine_resource_leases
     (attempt_id, session_id, engine_id, resource_key, lease_token, state, acquired_at, started_at)
     VALUES (?, ?, 'codex', 'codex:default', 'lease-running', 'claimed', ?, NULL)`,
    ['attempt-running', runningSession.id, Date.now() - 1000],
  );
  upsertCooldownInDatabase(getDB(), {
    resourceKey: 'codex:default', consecutiveOverloads: 1, cooldownUntil: Date.now() - 1,
    probeAttemptId: 'attempt-running', lastOverloadAt: Date.now() - 30_000,
    lastSuccessAt: null, updatedAt: Date.now() - 1000,
  });
  getDB().saveToFile();
  const missingThreadSession = queries.createSession('缺少 thread 测试');
  queries.updateSession(missingThreadSession.id, { status: 'pending' });
  queries.setSessionActiveTurn(missingThreadSession.id, null, Date.now());
  queries.setSessionActiveAttempt(missingThreadSession.id, 'attempt-missing-thread');
  const waitingSession = queries.createSession('等待交互恢复测试');
  queries.setSessionCodexThreadId(waitingSession.id, 'thread-waiting');
  queries.updateSession(waitingSession.id, { status: 'awaiting_action' });
  queries.setSessionActiveTurn(waitingSession.id, 'turn-waiting', Date.now());
  queries.setSessionActiveAttempt(waitingSession.id, 'attempt-waiting');
  const codebuddySession = queries.createSession('CodeBuddy 重启中断测试', undefined, false, 'codebuddy');
  queries.updateSession(codebuddySession.id, { status: 'processing' });
  queries.setSessionActiveTurn(codebuddySession.id, 'codebuddy-turn-1', Date.now());
  queries.setSessionActiveAttempt(codebuddySession.id, 'attempt-codebuddy');
  const zcodeSession = queries.createSession('ZCode 重启中断测试', undefined, false, 'zcode');
  queries.updateSession(zcodeSession.id, { status: 'processing' });
  queries.setSessionActiveTurn(zcodeSession.id, 'zcode-turn-1', Date.now());
  queries.setSessionActiveAttempt(zcodeSession.id, 'attempt-zcode');
  const recoverable = queries.prepareRecoverableSessions();
  assert.equal(recoverable.find((candidate) => candidate.id === session.id)?.attemptId, 'attempt-recovery');
  assert.equal(recoverable.find((candidate) => candidate.id === runningSession.id)?.resourceKey, 'codex:default');
  assert.equal(recoverable.find((candidate) => candidate.id === runningSession.id)?.leaseToken, 'lease-running');

  const { closeAllEngineConnections, recoverActiveEngineSessions } = await import('./frontend.js');
  t.after(() => closeAllEngineConnections());
  recoverActiveEngineSessions(recoverable);

  await waitFor(() => queries.getSession(session.id)?.status === 'completed');
  const assistant = queries.getMessages(session.id, 20).filter((message) => message.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].turn_id, 'turn-recovery');
  assert.equal(assistant[0].content, '恢复成功');
  assert.equal(getEngineTerminalDecisionInDatabase(
    getDB(), session.id, 'codex', 'attempt-recovery',
  )?.outcome, 'completed');
  assert.equal(queries.getSession(session.id)?.active_attempt_id, null);
  assert.equal(queries.getSession(session.id)?.active_turn_id, null);
  assert.equal(queries.getSession(session.id)?.active_turn_started_at, null);
  assert.ok(listEngineTurnFactsInDatabase(getDB(), session.id, 'attempt-recovery')
    .some((fact) => fact.factType === 'recovery_completed' && fact.externalTurnId === 'turn-recovery'));
  await waitFor(() => queries.getSession(runningSession.id)?.status === 'completed');
  const continuedAssistant = queries.getMessages(runningSession.id, 20).filter((message) => message.role === 'assistant');
  assert.equal(continuedAssistant.length, 1);
  assert.equal(continuedAssistant[0].content, '继续输出成功');
  assert.equal(getEngineTerminalDecisionInDatabase(
    getDB(), runningSession.id, 'codex', 'attempt-running',
  )?.outcome, 'completed');
  await waitFor(() => getCooldownInDatabase(getDB(), 'codex:default')?.probeAttemptId === null);
  assert.equal(getCooldownInDatabase(getDB(), 'codex:default')?.consecutiveOverloads, 0);
  assert.equal(JSON.parse(continuedAssistant[0].items || '[]').filter((item: { id: string }) => item.id === 'command-1').length, 1);
  assert.equal(queries.getSession(missingThreadSession.id)?.status, 'failed');
  const missingThreadFailure = queries.getMessages(missingThreadSession.id, 20).find((message) => message.role === 'assistant');
  assert.match(missingThreadFailure?.metadata || '', /RESTART_RECOVERY_SESSION_MISSING/);
  assert.equal(getEngineTerminalDecisionInDatabase(
    getDB(), missingThreadSession.id, 'codex', 'attempt-missing-thread',
  )?.reasonCode, 'RESTART_RECOVERY_SESSION_MISSING');
  assert.ok(listEngineTurnFactsInDatabase(getDB(), missingThreadSession.id, 'attempt-missing-thread')
    .some((fact) => fact.factType === 'recovery_failed'
      && 'errorCode' in fact.payload
      && fact.payload.errorCode === 'RESTART_RECOVERY_SESSION_MISSING'));
  await waitFor(() => queries.getSession(waitingSession.id)?.status === 'failed');
  const waitingFailure = queries.getMessages(waitingSession.id, 20).find((message) => message.role === 'assistant');
  assert.match(waitingFailure?.metadata || '', /RESTART_RECOVERY_INTERACTION_MISSING/);
  assert.equal(getEngineTerminalDecisionInDatabase(
    getDB(), waitingSession.id, 'codex', 'attempt-waiting',
  )?.reasonCode, 'RESTART_RECOVERY_INTERACTION_MISSING');
  assert.ok(listEngineTurnFactsInDatabase(getDB(), waitingSession.id, 'attempt-waiting')
    .some((fact) => fact.factType === 'recovery_failed'
      && 'errorCode' in fact.payload
      && fact.payload.errorCode === 'RESTART_RECOVERY_INTERACTION_MISSING'));
  assert.equal(queries.getSession(codebuddySession.id)?.status, 'interrupted');
  assert.equal(getEngineTerminalDecisionInDatabase(
    getDB(), codebuddySession.id, 'codebuddy', 'attempt-codebuddy',
  )?.reasonCode, 'CODEBUDDY_RESTART_INTERRUPTED');
  assert.equal(queries.getSession(codebuddySession.id)?.active_attempt_id, null);
  const codebuddyAssistant = queries.getMessages(codebuddySession.id, 20)
    .filter((message) => message.role === 'assistant');
  assert.equal(codebuddyAssistant.length, 1);
  assert.equal(codebuddyAssistant[0].turn_id, 'codebuddy-turn-1');
  assert.match(codebuddyAssistant[0].metadata || '', /CODEBUDDY_RESTART_INTERRUPTED/);
  assert.ok(listEngineTurnFactsInDatabase(getDB(), codebuddySession.id, 'attempt-codebuddy')
    .some((fact) => fact.factType === 'recovery_interrupted'
      && 'errorCode' in fact.payload
      && fact.payload.errorCode === 'CODEBUDDY_RESTART_INTERRUPTED'));
  assert.equal(queries.getSession(zcodeSession.id)?.status, 'interrupted');
  assert.equal(getEngineTerminalDecisionInDatabase(
    getDB(), zcodeSession.id, 'zcode', 'attempt-zcode',
  )?.reasonCode, 'ZCODE_RESTART_INTERRUPTED');
  assert.equal(queries.getSession(zcodeSession.id)?.active_attempt_id, null);
  const zcodeAssistant = queries.getMessages(zcodeSession.id, 20)
    .filter((message) => message.role === 'assistant');
  assert.equal(zcodeAssistant.length, 1);
  assert.equal(zcodeAssistant[0].turn_id, 'zcode-turn-1');
  assert.match(zcodeAssistant[0].metadata || '', /ZCODE_RESTART_INTERRUPTED/);
  assert.ok(listEngineTurnFactsInDatabase(getDB(), zcodeSession.id, 'attempt-zcode')
    .some((fact) => fact.factType === 'recovery_interrupted'
      && 'errorCode' in fact.payload
      && fact.payload.errorCode === 'ZCODE_RESTART_INTERRUPTED'));
});
