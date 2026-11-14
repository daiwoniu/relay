import type { SQLiteDB } from '../db/index.js';
import {
  insertSessionFollowup, listSessionFollowups, transitionSessionFollowup,
  type NewSessionFollowup, type SessionFollowupRecord,
} from '../db/session-followups.js';

export interface FollowupRuntime {
  isRunning: boolean;
  turnId: string | null;
  steer?: (input: { content: string; messageId: string; expectedTurnId: string }) => Promise<'accepted' | 'turn_changed' | 'unsupported'>;
}

export interface FollowupDeliveryDeps {
  db: SQLiteDB;
  ownerOf(sessionId: string): string | null;
  runtimeOf(sessionId: string): FollowupRuntime | null;
  recoveryOutcome(sessionId: string): 'completed' | 'failed' | 'unknown';
  dispatch(record: SessionFollowupRecord): Promise<void>;
  accepted(record: SessionFollowupRecord): Promise<void>;
  changed(record: SessionFollowupRecord): void;
}

export class SessionFollowupDelivery {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: FollowupDeliveryDeps) {}

  private serialize<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(action);
    const settled = result.catch(() => undefined);
    this.locks.set(sessionId, settled);
    void settled.then(() => { if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId); });
    return result;
  }

  private transition(record: SessionFollowupRecord, to: SessionFollowupRecord['state'], errorCode?: string): SessionFollowupRecord {
    const next = transitionSessionFollowup(this.deps.db, {
      id: record.id, from: record.state, to, updatedAt: Date.now(), errorCode,
    });
    this.deps.changed(next);
    return next;
  }

  async submitFollowup(input: NewSessionFollowup): Promise<SessionFollowupRecord> {
    return this.serialize(input.sessionId, async () => {
      if (this.deps.ownerOf(input.sessionId) !== input.userId) throw new Error('只有会话所有人可以发送后续消息');
      const previous = listSessionFollowups(this.deps.db, input.sessionId);
      let record = insertSessionFollowup(this.deps.db, {
        ...input, createdAt: Math.max(input.createdAt, (previous.at(-1)?.createdAt ?? 0) + 1),
      });
      if (record.state !== 'received') return record;
      this.deps.changed(record);
      const runtime = this.deps.runtimeOf(input.sessionId);
      const hasAttachments = (JSON.parse(input.attachmentsJson) as unknown[]).length > 0;
      const prior = listSessionFollowups(this.deps.db, input.sessionId);
      const position = prior.findIndex((item) => item.id === record.id);
      const earlierPending = prior.slice(0, position).some((item) =>
        !['steered', 'delivered', 'cancelled'].includes(item.state));
      if (!earlierPending && runtime?.isRunning && runtime.turnId && runtime.steer && !hasAttachments) {
        record = this.transition(record, 'steering');
        let outcome: 'accepted' | 'turn_changed' | 'unsupported';
        try {
          outcome = await runtime.steer({
            content: input.content, messageId: input.id, expectedTurnId: runtime.turnId,
          });
        } catch {
          return this.transition(record, 'uncertain', 'STEER_RESULT_UNKNOWN');
        }
        if (outcome === 'accepted') {
          try { await this.deps.accepted(record); }
          catch { return this.transition(record, 'uncertain', 'STEER_MESSAGE_SAVE_FAILED'); }
          return this.transition(record, 'steered');
        }
      }
      record = this.transition(record, 'queued');
      if (!this.deps.runtimeOf(input.sessionId)?.isRunning) await this.dispatchNext(input.sessionId);
      return record;
    });
  }

  private async dispatchNext(sessionId: string): Promise<void> {
    if (this.deps.runtimeOf(sessionId)?.isRunning) return;
    const next = listSessionFollowups(this.deps.db, sessionId).find((record) =>
      !['steered', 'delivered', 'cancelled'].includes(record.state));
    if (!next || next.state !== 'queued') return;
    const dispatching = this.transition(next, 'dispatching');
    try {
      await this.deps.dispatch(dispatching);
      this.transition(dispatching, 'delivered');
    } catch {
      this.transition(dispatching, 'paused', 'DISPATCH_FAILED');
    }
  }

  async onTerminal(sessionId: string, succeeded: boolean): Promise<void> {
    await this.serialize(sessionId, async () => {
      const queued = listSessionFollowups(this.deps.db, sessionId).filter((record) => record.state === 'queued');
      if (!succeeded) {
        for (const record of queued) this.transition(record, 'paused', 'PREVIOUS_TURN_FAILED');
        return;
      }
      await this.dispatchNext(sessionId);
    });
  }

  async recoverSessionFollowups(): Promise<void> {
    // Trash records are retained for restoration; they must not be replayed or
    // downgraded when the normal session service cannot access them.
    const rows = this.deps.db.all(`SELECT DISTINCT f.session_id FROM session_followups f
      INNER JOIN sessions s ON s.id = f.session_id AND s.deleted_at IS NULL
      INNER JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      WHERE f.state IN ('received','steering','steered','queued','dispatching')
        OR (f.state = 'uncertain' AND f.error_code = 'STEER_MESSAGE_SAVE_FAILED')`);
    for (const row of rows) {
      const sessionId = String(row.session_id);
      await this.serialize(sessionId, async () => {
        for (const record of listSessionFollowups(this.deps.db, sessionId)) {
          if (record.state === 'received') this.transition(record, 'queued');
          else if (record.state === 'steering' || record.state === 'dispatching') this.transition(record, 'uncertain', 'RESTART_RESULT_UNKNOWN');
          else if (record.state === 'steered'
            || (record.state === 'uncertain' && record.errorCode === 'STEER_MESSAGE_SAVE_FAILED')) {
            // This error is recorded only after a positive steer receipt. Retry
            // the idempotent local save, never the engine request itself.
            try {
              await this.deps.accepted(record);
              if (record.state === 'uncertain') this.transition(record, 'steered');
            } catch {
              if (record.state === 'steered') this.transition(record, 'uncertain', 'STEER_MESSAGE_SAVE_FAILED');
            }
          }
        }
        if (!this.deps.runtimeOf(sessionId)?.isRunning) {
          const outcome = this.deps.recoveryOutcome(sessionId);
          if (outcome !== 'completed') {
            for (const record of listSessionFollowups(this.deps.db, sessionId)) {
              if (record.state === 'queued') this.transition(record, 'paused', outcome === 'failed' ? 'PREVIOUS_TURN_FAILED' : 'PREVIOUS_TURN_UNCONFIRMED');
            }
            return;
          }
        }
        await this.dispatchNext(sessionId);
      });
    }
  }

  cancelSessionFollowup(sessionId: string, messageId: string, actorId: string): Promise<SessionFollowupRecord> {
    return this.serialize(sessionId, async () => {
      if (this.deps.ownerOf(sessionId) !== actorId) throw new Error('只有会话所有人可以取消后续消息');
      const record = listSessionFollowups(this.deps.db, sessionId).find((item) => item.id === messageId);
      if (!record || !['received', 'queued', 'paused', 'uncertain'].includes(record.state)) throw new Error('后续消息已无法取消');
      const cancelled = this.transition(record, 'cancelled');
      if (this.deps.recoveryOutcome(sessionId) === 'completed') await this.dispatchNext(sessionId);
      return cancelled;
    });
  }

  resumeSessionFollowups(sessionId: string): Promise<void> {
    return this.serialize(sessionId, async () => {
      for (const record of listSessionFollowups(this.deps.db, sessionId)) {
        if (record.state === 'paused') this.transition(record, 'queued');
      }
      await this.dispatchNext(sessionId);
    });
  }
}
