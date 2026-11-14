import { createHash, randomUUID } from 'node:crypto';
import type { CoreStoragePort, RepairCandidate, RepairEntry, StoragePrincipal, StorageCommandEnvelope } from '../storage/contracts.js';
import { canonicalJson, operationIdentity, parseCommandEnvelope, StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import type { TerminalRepairPreview } from './online-terminal-repair.js';
type Principal = Extract<StoragePrincipal,{kind:'user'}>;
type Result = { state: 'committed'; restoredCount: number } | { state: 'unknown' };
interface Plan { owner: string; expiresAt: number; entries: RepairEntry[]; intent?: StorageCommandEnvelope & { command: { name: 'repair.apply'; input: { backupId: string; entries: RepairEntry[] } } }; }
/** Candidate repair coordinator. Source parsing/compaction belongs in the bounded I/O worker, never in this coordinator. */
export class StoredMessageRepair {
  private readonly plans = new Map<string,Plan>();
  private busy = false;
  constructor(private readonly options: { port: CoreStoragePort; storeId: string; generation: number;
    loadSnapshots: (candidates: readonly RepairCandidate[]) => Promise<RepairEntry[]>;
    maintenanceBusy: () => boolean;
    changed: (sessionId: string) => void | Promise<void>;
    now?: () => number;
  }) { this.options = Object.freeze({ ...options }); }
  private now() { return (this.options.now ?? Date.now)(); }
  private async publish(ids: string[]) {
    const results = await Promise.allSettled(ids.map((id) => Promise.resolve().then(() => this.options.changed(id))));
    if (results.some((r) => r.status === 'rejected')) console.warn('[MessageRepair] 当前修复状态通知暂不可用');
  }
  async preview(principal: Principal, cursor: string | null = null): Promise<TerminalRepairPreview> {
    if (this.busy) throw new StorageContractError('CONFLICT'); this.busy = true;
    try {
      for (const [id,plan] of this.plans) if (plan.expiresAt <= this.now()) this.plans.delete(id);
      const source = await this.options.port.readRepairCandidates({ principal, cursor });
      let loaded: RepairEntry[] = [];
      try {
        if (source.candidates.length) loaded = await new Promise<RepairEntry[]>((resolve,reject) => {
          const timer = setTimeout(() => reject(new Error('REPAIR_SOURCE_DEADLINE')), 30_000); timer.unref();
          Promise.resolve().then(() => this.options.loadSnapshots(source.candidates)).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
        });
      } catch { /* Missing/unreadable local sources become per-turn issues, not unverified writes. */ }
      if (!Array.isArray(loaded) || loaded.length > 20) loaded = [];
      const current = await this.options.port.readRepairCandidates({ principal, cursor });
      const entries: RepairEntry[] = [], issues: TerminalRepairPreview['issues'] = []; let bytes = 2;
      const planId = randomUUID();
      for (const candidate of source.candidates) {
        try {
          if (candidate.contentDigest === null || candidate.contentLength === null || !current.candidates.some((c) => c.decisionId === candidate.decisionId && c.sourceDigest === candidate.sourceDigest)) throw new Error('STALE_SOURCE');
          const supplied = loaded.find((entry) => entry?.candidate?.decisionId === candidate.decisionId);
          if (!supplied) throw new Error('SOURCE_MISSING');
          const entry: RepairEntry = { candidate, snapshot: supplied.snapshot };
          const input = parseCommandEnvelope({ protocolVersion: 1, storeId: this.options.storeId, workerGeneration: this.options.generation,
            requestId: planId, operationId: 'repair:preview:'+planId, principal, command: { name: 'repair.apply', input: { backupId: planId, entries: [entry] } } });
          if (input.command.name !== 'repair.apply') throw new Error('INVALID_SNAPSHOT');
          const parsed = input.command.input.entries[0];
          if (!parsed.snapshot.content.trim() || parsed.snapshot.content.length !== candidate.contentLength
            || createHash('sha256').update(parsed.snapshot.content).digest('hex') !== candidate.contentDigest) throw new Error('DIGEST_MISMATCH');
          const cost = Buffer.byteLength(canonicalJson(parsed))+1;
          if (bytes+cost > 6*1024*1024) throw new Error('PLAN_TOO_LARGE'); bytes += cost; entries.push(parsed);
        } catch { issues.push({ sessionId: candidate.sessionId, title: candidate.title, turnCount: 1, reason: '本机记录缺失、已变化或未通过完整性校验，未修改消息' }); }
      }
      for (const [id,plan] of this.plans) if (plan.owner === principal.userId) this.plans.delete(id);
      while (entries.length && this.plans.size >= 3) this.plans.delete(this.plans.keys().next().value!);
      const expiresAt = entries.length ? this.now()+10*60_000 : null;
      if (entries.length && expiresAt !== null) this.plans.set(planId, { owner: principal.userId, expiresAt, entries });
      return { planId: entries.length ? planId : null, expiresAt, turnCount: entries.length, nextCursor: source.nextCursor, issues,
        sessions: [...new Set(entries.map((e) => e.candidate.sessionId))].map((id) => ({ id,
          title: entries.find((e) => e.candidate.sessionId === id)!.candidate.title, turnCount: entries.filter((e) => e.candidate.sessionId === id).length })) };
    } finally { this.busy = false; }
  }
  async apply(principal: Principal, planId: string): Promise<Result> {
    if (this.busy) throw new StorageContractError('CONFLICT'); this.busy = true;
    try {
      const operationId = 'repair:'+planId;
      const existing = await this.options.port.lookup({ storeId: this.options.storeId, operationId, principal });
      if (existing.state === 'committed') {
        if (existing.commandName !== 'repair.apply') throw new StorageContractError('CONFLICT');
        await this.publish(existing.value.sessionIds); this.plans.delete(planId);
        return { state: 'committed', restoredCount: existing.value.restoredCount };
      }
      if (existing.state === 'unavailable') return { state: 'unknown' };
      if (existing.state === 'expired') throw new StorageContractError('OPERATION_EXPIRED');
      const plan = this.plans.get(planId);
      if (!plan || plan.owner !== principal.userId || plan.expiresAt <= this.now()) throw new StorageContractError('OPERATION_EXPIRED');
      if (this.options.maintenanceBusy()) throw new StorageContractError('CONFLICT');
      if (!plan.intent) plan.intent = { protocolVersion: 1, storeId: this.options.storeId, workerGeneration: this.options.generation,
        requestId: randomUUID(), operationId, principal, command: { name: 'repair.apply', input: { backupId: planId, entries: plan.entries } } };
      // A renewed login must authorize this call; the intent's business payload and operation ID remain unchanged.
      const request = { ...plan.intent, requestId: randomUUID(), principal };
      if (existing.state === 'rejected') throw new StorageContractError(existing.code);
      const result = await executeStoredCommand(this.options.port, request);
      if (result.state === 'unknown') return { state: 'unknown' };
      if (result.state === 'rejected') throw new StorageContractError(result.code);
      // Verify receipt identity before publishing even if the reply was recovered after a transport loss.
      const identity = operationIdentity(request);
      const record = await this.options.port.lookup({ storeId: this.options.storeId, operationId, principal,
        expected: { commandName: 'repair.apply', inputDigest: identity.inputDigest } });
      if (record.state !== 'committed' || record.commandName !== 'repair.apply') return { state: 'unknown' };
      await this.publish(record.value.sessionIds); this.plans.delete(planId);
      return { state: 'committed', restoredCount: record.value.restoredCount };
    } finally { this.busy = false; }
  }
}
