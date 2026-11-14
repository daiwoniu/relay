import { randomUUID } from 'node:crypto';
import type { EngineQueueEntry } from '../db/engine-concurrency.js';
import { cancelQueuedTurnInDatabase, enqueueTurnWithMessageInDatabase } from '../db/engine-concurrency.js';
export { MAX_QUEUED_TURNS_PER_USER } from '../db/engine-concurrency.js';
import type { SQLiteDB } from '../db/index.js';
import type { NewMessageRecord, SavedMessageRecord } from '../db/query-types.js';
import type { EngineConcurrencyResource } from '../engine/concurrency/types.js';
import type { EngineId } from '../engine/types.js';

export class TurnAdmissionError extends Error {
  constructor(readonly code: 'SESSION_ALREADY_ACTIVE_OR_QUEUED' | 'SESSION_ENGINE_PREFERENCES_CONFLICT' | 'USER_QUEUE_LIMIT_REACHED' | 'TURN_ADMISSION_FAILED', message: string) {
    super(message);
    this.name = 'TurnAdmissionError';
  }
}

export interface TurnAdmissionResult {
  savedMessage: SavedMessageRecord;
  queue: EngineQueueEntry;
}

export class TurnAdmissionService {
  constructor(
    private readonly db: SQLiteDB,
    private readonly now: () => number = Date.now,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  enqueue(input: {
    sessionId: string;
    engineId: EngineId;
    requestedByUserId: string;
    attemptId: string;
    message: NewMessageRecord;
    resource: EngineConcurrencyResource;
    bindEngine?: boolean;
    enginePreferences?: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null; expectedRevision: number };
    enginePreferencesRevision?: number;
    workspaceTaskLink?: { taskId: string; workspacePath: string };
  }): TurnAdmissionResult {
    const beforeTaskAdmission = input.workspaceTaskLink ? this.db.raw().export() : null;
    try {
      const result = enqueueTurnWithMessageInDatabase(this.db, {
        message: input.message,
        queue: {
          id: this.idFactory(),
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          engineId: input.engineId,
          resourceKey: input.resource.resourceKey,
          requestedByUserId: input.requestedByUserId,
          createdAt: this.now(),
        },
        now: this.now(),
        ...(input.enginePreferencesRevision !== undefined
          ? { expectedPreferencesRevision: input.enginePreferencesRevision }
          : {}),
        ...(input.bindEngine ? {
          bind: { engineId: input.engineId, ...(input.enginePreferences ? { preferences: input.enginePreferences } : {}) },
        } : {}),
        ...(input.workspaceTaskLink ? { workspaceTaskLink: input.workspaceTaskLink } : {}),
      });
      this.db.saveToFile(input.workspaceTaskLink ? { failOnLocked: true } : undefined);
      return result;
    } catch (error) {
      if (beforeTaskAdmission) this.db.restoreFromBytes(beforeTaskAdmission);
      const message = error instanceof Error ? error.message : '发送准入失败';
      if (/已有排队|活动回合|UNIQUE constraint failed/.test(message)) {
        throw new TurnAdmissionError('SESSION_ALREADY_ACTIVE_OR_QUEUED', '该会话已有任务正在执行或排队');
      }
      if (/模型偏好已在其他设备更新/.test(message)) {
        throw new TurnAdmissionError('SESSION_ENGINE_PREFERENCES_CONFLICT', message);
      }
      if (/账号待排队任务已达上限/.test(message)) {
        throw new TurnAdmissionError('USER_QUEUE_LIMIT_REACHED', message);
      }
      throw new TurnAdmissionError('TURN_ADMISSION_FAILED', message);
    }
  }

  cancelQueued(sessionId: string): { savedMessage: SavedMessageRecord; resourceKey: string; attemptId: string } | null {
    const row = this.db.get(
      "SELECT attempt_id FROM engine_queue_entries WHERE session_id = ? AND state = 'queued'",
      [sessionId],
    );
    if (!row) return null;
    const attemptId = String(row.attempt_id);
    const result = cancelQueuedTurnInDatabase(this.db, {
      sessionId,
      now: this.now(),
      message: {
        id: this.idFactory(), session_id: sessionId, turn_id: attemptId, role: 'assistant', content: '',
        phase: null, items: null, metadata: null, duration: null, stopped: 1,
      },
    });
    if (result) this.db.saveToFile();
    return result;
  }
}
