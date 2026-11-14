import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import {
  appendEngineTurnFactInDatabase,
  ensureEngineTurnFactTables,
  getEngineTerminalDecisionInDatabase,
} from '../db/engine-turn-facts.js';
import {
  getMessagePageInDatabase,
  getSessionInDatabase,
  projectEngineTerminalInDatabase,
  saveMessageInDatabase,
} from '../db/queries.js';
import { parseMessageMetadata } from '../message-metadata.js';
import { withSessionResults } from '../db/session-attention.js';
import type { EngineTerminalDecision, EngineTerminalOutcome, EngineTurnFact } from '../engine/turn-facts.js';
import { createEngineTerminalProjectionService } from './engine-terminal-projection.js';

async function createProjectionDatabase() {
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_manually_set INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      project_id TEXT,
      engine TEXT NOT NULL CHECK(engine IN ('codex','codebuddy')),
      engine_bound INTEGER NOT NULL DEFAULT 1,
      engine_session_id TEXT,
      engine_metadata TEXT,
      codex_thread_id TEXT,
      codex_archived INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      token_usage TEXT,
      active_turn_usage TEXT,
      active_turn_id TEXT,
      active_attempt_id TEXT,
      active_turn_started_at INTEGER,
      recovery_previous_status TEXT,
      message_revision INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      phase TEXT,
      items TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      duration INTEGER,
      stopped INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE engine_queue_entries (attempt_id TEXT PRIMARY KEY);
    CREATE TABLE engine_resource_leases (attempt_id TEXT PRIMARY KEY, resource_key TEXT NOT NULL);
    INSERT INTO sessions (
      id, title, created_at, updated_at, engine, status, active_turn_usage,
      active_turn_id, active_attempt_id, active_turn_started_at, recovery_previous_status
    ) VALUES (
      'session-1', '测试会话', 10, 10, 'codex', 'processing', '{"outputTokens":3}',
      'turn-1', 'attempt-1', 20, 'processing'
    );
    INSERT INTO engine_queue_entries VALUES ('attempt-1');
    INSERT INTO engine_resource_leases VALUES ('attempt-1', 'codex:default');
  `);
  const db = new SQLiteDB(raw, ':memory:');
  ensureEngineTurnFactTables(db);
  return { raw, db };
}

function terminalFact(outcome: EngineTerminalOutcome): EngineTurnFact {
  const terminal = (() => {
    switch (outcome) {
      case 'completed':
        return {
          factType: 'final_answer_completed' as const,
          source: 'realtime' as const,
          payload: { hasContent: true, contentLength: 2, contentDigest: 'a'.repeat(64) },
        };
      case 'stopped':
        return {
          factType: 'interrupt_confirmed' as const,
          source: 'local' as const,
          payload: { userInitiated: true },
        };
      case 'interrupted':
        return {
          factType: 'recovery_interrupted' as const,
          source: 'recovery' as const,
          payload: { errorCode: 'ENGINE_INTERRUPTED' },
        };
      default:
        return {
          factType: 'engine_error' as const,
          source: 'realtime' as const,
          payload: { errorCode: 'ENGINE_FAILED' },
        };
    }
  })();
  return {
    id: `fact-${outcome}`,
    sessionId: 'session-1',
    attemptId: 'attempt-1',
    engineId: 'codex',
    connectionId: 'connection-1',
    externalTurnId: 'turn-1',
    factType: terminal.factType,
    source: terminal.source,
    sequence: 1,
    idempotencyKey: `fact-key-${outcome}`,
    observedAt: 30,
    payload: terminal.payload,
  };
}

function terminalDecision(outcome: EngineTerminalOutcome): EngineTerminalDecision {
  return {
    id: `decision-${outcome}`,
    sessionId: 'session-1',
    attemptId: 'attempt-1',
    engineId: 'codex',
    externalTurnId: 'turn-1',
    outcome,
    reasonCode: outcome === 'completed' ? 'FINAL_ANSWER_COMPLETED' : outcome === 'stopped' ? 'USER_STOPPED' : `ENGINE_${outcome.toUpperCase()}`,
    factId: `fact-${outcome}`,
    decidedAt: 40,
    projectedAt: null,
  };
}

function projectionInput(outcome: EngineTerminalOutcome, content = outcome === 'completed' ? '完成' : '已有输出') {
  return {
    decision: terminalDecision(outcome),
    snapshot: {
      messageId: `message-${outcome}`,
      turnId: 'turn-1',
      content,
      items: JSON.stringify([{ id: 'item-1', type: 'reasoning', status: 'completed' }]),
      duration: 25,
      metadata: {
        processContent: '处理过程',
        executionStage: 'responding' as const,
        errorCode: outcome === 'completed' ? undefined : `LEGACY_${outcome.toUpperCase()}`,
        errorMessage: outcome === 'completed' ? undefined : '兼容错误信息',
      },
    },
  };
}

test('决定、消息、revision、session 终态、活动字段和 projected_at 原子提交', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('completed'));
    const service = createEngineTerminalProjectionService({
      project: (input) => projectEngineTerminalInDatabase(db, input, 100),
    });

    const result = service.project(projectionInput('completed'));

    assert.equal(result.projected, true);
    assert.equal(result.savedMessage.revision, 1);
    assert.equal(result.savedMessage.message.phase, 'final_answer');
    assert.equal(result.savedMessage.message.stopped, 0);
    assert.equal(result.decision.projectedAt, 100);
    assert.equal(result.releasedResourceKey, 'codex:default');
    assert.equal(db.get("SELECT COUNT(*) AS count FROM engine_resource_leases")?.count, 0);
    assert.equal(db.get("SELECT COUNT(*) AS count FROM engine_queue_entries")?.count, 0);
    const session = getSessionInDatabase(db, 'session-1');
    assert.equal(session?.status, 'completed');
    assert.equal(session?.message_revision, 1);
    assert.equal(session?.active_attempt_id, null);
    assert.equal(session?.active_turn_id, null);
    assert.equal(session?.active_turn_usage, null);
    assert.equal(session?.active_turn_started_at, null);
    assert.equal(session?.recovery_previous_status, null);
    assert.equal(getEngineTerminalDecisionInDatabase(db, 'session-1', 'codex', 'attempt-1')?.projectedAt, 100);
    const page = getMessagePageInDatabase(db, 'session-1');
    assert.equal(page.revision, 1);
    assert.equal(page.messages[0]?.content, '完成');
  } finally {
    raw.close();
  }
});

test('四类终态保持旧消息 phase、stopped 和 metadata 兼容语义', async () => {
  for (const outcome of ['completed', 'failed', 'interrupted', 'stopped'] as const) {
    const { raw, db } = await createProjectionDatabase();
    try {
      appendEngineTurnFactInDatabase(db, terminalFact(outcome));
      const service = createEngineTerminalProjectionService({
        project: (input) => projectEngineTerminalInDatabase(db, input, 100),
      });

      const result = service.project(projectionInput(outcome));
      const metadata = parseMessageMetadata(result.savedMessage.message.metadata);
      const legacySession = db.get(
        "SELECT status, active_turn_id, active_attempt_id, active_turn_started_at, recovery_previous_status FROM sessions WHERE id = 'session-1'",
      );
      const legacyMessage = db.get(
        "SELECT content, phase, metadata, stopped FROM messages WHERE session_id = 'session-1'",
      );

      assert.equal(result.savedMessage.message.phase, outcome === 'completed' ? 'final_answer' : outcome === 'stopped' ? null : 'error');
      assert.equal(result.savedMessage.message.stopped, outcome === 'stopped' ? 1 : 0);
      assert.equal(metadata.outcome, outcome);
      assert.equal(metadata.processContent, '处理过程');
      assert.equal(metadata.executionStage, 'responding');
      assert.equal(metadata.errorCode, outcome === 'completed' ? undefined : `LEGACY_${outcome.toUpperCase()}`);
      assert.equal(metadata.errorMessage, outcome === 'completed' ? undefined : '兼容错误信息');
      assert.deepEqual(legacySession, {
        status: outcome,
        active_turn_id: null,
        active_attempt_id: null,
        active_turn_started_at: null,
        recovery_previous_status: null,
      });
      assert.equal(legacyMessage?.content, outcome === 'completed' ? '完成' : '已有输出');
      assert.equal(legacyMessage?.phase, outcome === 'completed' ? 'final_answer' : outcome === 'stopped' ? null : 'error');
      assert.equal(legacyMessage?.stopped, outcome === 'stopped' ? 1 : 0);
      assert.equal(parseMessageMetadata(String(legacyMessage?.metadata)).outcome, outcome);
    } finally {
      raw.close();
    }
  }
});

test('可靠的逐轮模型事实随四类终态写入消息 metadata', async () => {
  for (const outcome of ['completed', 'failed', 'interrupted', 'stopped'] as const) {
    const { raw, db } = await createProjectionDatabase();
    try {
      appendEngineTurnFactInDatabase(db, terminalFact(outcome));
      const service = createEngineTerminalProjectionService({
        project: (input) => projectEngineTerminalInDatabase(db, input, 100),
      });
      const input = projectionInput(outcome);
      const result = service.project({
        ...input,
        snapshot: {
          ...input.snapshot,
          metadata: {
            ...input.snapshot.metadata,
            modelInfo: {
              engineId: 'codex',
              requested: { id: 'gpt-requested', reasoningEffort: 'high' },
              effective: { id: 'gpt-effective', displayName: 'GPT Effective', provider: 'OpenAI' },
              rerouted: true,
            },
          },
        },
      });
      assert.equal(parseMessageMetadata(result.savedMessage.message.metadata).modelInfo?.effective.id, 'gpt-effective');
    } finally { raw.close(); }
  }
});

test('审批先于正文落库时仍保存完整终态、过程和工具项，重放不重复写入', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('completed'));
    saveMessageInDatabase(db, {
      id: 'approval', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant',
      content: '', phase: 'final_answer', metadata: '{"outcome":"completed"}',
      items: '[{"id":"approval-item","type":"interaction","status":"completed"}]',
    }, 50);
    const service = createEngineTerminalProjectionService({ project: (input) => projectEngineTerminalInDatabase(db, input, 100) });
    const saved = service.project(projectionInput('completed'));
    assert.equal(saved.savedMessage.message.content, '完成');
    assert.equal(parseMessageMetadata(saved.savedMessage.message.metadata).processContent, '处理过程');
    assert.match(saved.savedMessage.message.items!, /item-1/);
    assert.equal(saved.savedMessage.revision, 2);
    assert.equal(db.get("SELECT content FROM messages WHERE id = 'approval'")?.content, '');
    assert.equal(service.project(projectionInput('completed')).projected, false);
    assert.equal(getMessagePageInDatabase(db, 'session-1').messages.length, 2);
  } finally { raw.close(); }
});

test('补回已标记投影的空审批结果时不清理新回合，重复恢复保持幂等', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('completed'));
    const service = createEngineTerminalProjectionService({ project: (input) => projectEngineTerminalInDatabase(db, input, 100) });
    service.project(projectionInput('completed'));
    // Reproduce the old acknowledged-but-empty compatibility message.
    db.run("UPDATE messages SET content = '', items = '[]' WHERE id = 'message-completed'");
    db.run("UPDATE sessions SET active_attempt_id = 'attempt-2', active_turn_id = 'turn-2', status = 'processing' WHERE id = 'session-1'");
    const input = { ...projectionInput('completed'), snapshot: { ...projectionInput('completed').snapshot, messageId: 'repaired' } };
    const repaired = service.project(input);
    assert.equal(repaired.projected, true);
    assert.equal(repaired.savedMessage.message.content, '完成');
    assert.equal(repaired.releasedResourceKey, null);
    assert.equal(getSessionInDatabase(db, 'session-1')?.active_attempt_id, 'attempt-2');
    assert.equal(getSessionInDatabase(db, 'session-1')?.status, 'processing');
    assert.equal(service.project(input).projected, false);
    assert.equal(getSessionInDatabase(db, 'session-1')?.message_revision, 2);
  } finally { raw.close(); }
});

test('历史补回保持原完成时间、最新结果和侧栏顺序，revision 正常递增', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('completed'));
    const service = createEngineTerminalProjectionService({ project: (input) => projectEngineTerminalInDatabase(db, input, 100) });
    service.project(projectionInput('completed'));
    db.run("UPDATE messages SET content = '' WHERE id = 'message-completed'");
    saveMessageInDatabase(db, { id: 'later-result', session_id: 'session-1', turn_id: 'turn-2', role: 'assistant',
      content: '较新的结果', phase: 'final_answer', items: null, metadata: '{"outcome":"completed"}' }, 200);
    db.run("UPDATE sessions SET updated_at = 300, active_attempt_id = 'attempt-3', status = 'processing' WHERE id = 'session-1'");
    const input = { ...projectionInput('completed'), snapshot: { ...projectionInput('completed').snapshot, messageId: 'historical-result' } };
    const repaired = projectEngineTerminalInDatabase(db, {
      decision: terminalDecision('completed'), message: {
        id: input.snapshot.messageId, session_id: 'session-1', turn_id: 'turn-1', role: 'assistant',
        content: input.snapshot.content, phase: 'final_answer', items: null, metadata: '{"outcome":"completed"}',
      }, sessionStatus: 'completed',
    }, 10_000);
    assert.equal(repaired.savedMessage.message.created_at, 100);
    assert.equal(db.get("SELECT created_at FROM messages WHERE id = 'historical-result'")?.created_at, 100);
    const session = getSessionInDatabase(db, 'session-1')!;
    assert.equal(session.updated_at, 300);
    assert.equal(session.active_attempt_id, 'attempt-3');
    assert.equal(session.message_revision, 3);
    assert.equal(withSessionResults(db, [session])[0].last_result?.messageId, 'later-result');
    assert.equal(service.project(input).projected, false);
    assert.equal(getSessionInDatabase(db, 'session-1')?.message_revision, 3);
  } finally { raw.close(); }
});

test('重复投影返回既有消息且不增加 revision', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('failed'));
    const service = createEngineTerminalProjectionService({
      project: (input) => projectEngineTerminalInDatabase(db, input, 100),
    });

    const first = service.project(projectionInput('failed'));
    const duplicate = service.project({
      ...projectionInput('failed'),
      snapshot: { ...projectionInput('failed').snapshot, messageId: 'different-message' },
    });

    assert.equal(first.projected, true);
    assert.equal(duplicate.projected, false);
    assert.equal(duplicate.savedMessage.message.id, first.savedMessage.message.id);
    assert.equal(getSessionInDatabase(db, 'session-1')?.message_revision, 1);
    assert.equal(getMessagePageInDatabase(db, 'session-1').messages.length, 1);
  } finally {
    raw.close();
  }
});

test('事务最后一步抛错时决定、消息、revision 和 session 更新全部回滚', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('interrupted'));
    const failingDb = {
      exec: db.exec.bind(db),
      get: db.get.bind(db),
      run(sql: string, params: any[] = []) {
        db.run(sql, params);
        if (sql.includes('UPDATE engine_terminal_decisions SET projected_at')) throw new Error('injected failure');
      },
    };
    const service = createEngineTerminalProjectionService({
      project: (input) => projectEngineTerminalInDatabase(failingDb, input, 100),
    });

    assert.throws(() => service.project(projectionInput('interrupted')), /injected failure/);
    assert.equal(getEngineTerminalDecisionInDatabase(db, 'session-1', 'codex', 'attempt-1'), null);
    assert.equal(getMessagePageInDatabase(db, 'session-1').messages.length, 0);
    const session = getSessionInDatabase(db, 'session-1');
    assert.equal(session?.status, 'processing');
    assert.equal(session?.message_revision, 0);
    assert.equal(session?.active_attempt_id, 'attempt-1');
  } finally {
    raw.close();
  }
});

test('completed 必须包含非空正文且校验失败不写入任何终态数据', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('completed'));
    const service = createEngineTerminalProjectionService({
      project: (input) => projectEngineTerminalInDatabase(db, input, 100),
    });

    assert.throws(() => service.project(projectionInput('completed', '  ')), /正文/);
    assert.equal(getEngineTerminalDecisionInDatabase(db, 'session-1', 'codex', 'attempt-1'), null);
    assert.equal(getMessagePageInDatabase(db, 'session-1').messages.length, 0);
    assert.equal(getSessionInDatabase(db, 'session-1')?.message_revision, 0);
  } finally {
    raw.close();
  }
});

test('迟到终态不得清理已经切换到新 attempt 的会话状态', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('failed'));
    db.run("UPDATE sessions SET active_attempt_id = 'attempt-2', active_turn_id = 'turn-2' WHERE id = 'session-1'");
    const service = createEngineTerminalProjectionService({
      project: (input) => projectEngineTerminalInDatabase(db, input, 100),
    });

    assert.throws(() => service.project(projectionInput('failed')), /attempt 已失效/);
    assert.equal(getEngineTerminalDecisionInDatabase(db, 'session-1', 'codex', 'attempt-1'), null);
    assert.equal(getMessagePageInDatabase(db, 'session-1').messages.length, 0);
    const session = getSessionInDatabase(db, 'session-1');
    assert.equal(session?.active_attempt_id, 'attempt-2');
    assert.equal(session?.active_turn_id, 'turn-2');
    assert.equal(session?.status, 'processing');
  } finally {
    raw.close();
  }
});

test('发布只在事务提交后执行且发布失败不回滚数据库', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('completed'));
    let observedCommittedProjection = false;
    const diagnostics: string[] = [];
    const service = createEngineTerminalProjectionService({
      project: (input) => projectEngineTerminalInDatabase(db, input, 100),
      publish: () => {
        observedCommittedProjection = getEngineTerminalDecisionInDatabase(
          db, 'session-1', 'codex', 'attempt-1',
        )?.projectedAt === 100 && getMessagePageInDatabase(db, 'session-1').messages.length === 1;
        throw new Error('publish failed');
      },
      diagnostic: (message) => diagnostics.push(message),
    });

    assert.doesNotThrow(() => service.project(projectionInput('completed')));
    assert.equal(observedCommittedProjection, true);
    assert.deepEqual(diagnostics, ['ENGINE_TERMINAL_PROJECTION_PUBLISH_FAILED']);
    assert.equal(getSessionInDatabase(db, 'session-1')?.status, 'completed');
    assert.equal(getMessagePageInDatabase(db, 'session-1').revision, 1);
  } finally {
    raw.close();
  }
});

test('兼容 session status 可独立投影为 idle 而不改变终态决定', async () => {
  const { raw, db } = await createProjectionDatabase();
  try {
    appendEngineTurnFactInDatabase(db, terminalFact('completed'));
    const service = createEngineTerminalProjectionService({
      project: (input) => projectEngineTerminalInDatabase(db, input, 100),
    });

    const result = service.project({ ...projectionInput('completed'), sessionStatus: 'idle' });

    assert.equal(result.decision.outcome, 'completed');
    assert.equal(getSessionInDatabase(db, 'session-1')?.status, 'idle');
  } finally {
    raw.close();
  }
});
