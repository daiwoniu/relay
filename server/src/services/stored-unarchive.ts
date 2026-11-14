import { createHash, randomUUID } from 'node:crypto';
import type { CoreStoragePort, StoragePrincipal, StorageCommandEnvelope, CoreCommandInputs } from '../storage/contracts.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { StorageContractError, operationIdentity } from '../storage/command-boundary.js';
import type { SessionDto } from '../contracts/index.js';
type Principal = Extract<StoragePrincipal, { kind: 'user' }>;
type Outcome = { state: 'unknown' } | { state: 'committed'; session: SessionDto | null };
type Finish = { sessionId: string; externalOperationId: string; threadId: string };
function deadline<T>(work: () => Promise<T>,timeoutMs:number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('EXTERNAL_DEADLINE')), timeoutMs); timer.unref();
    Promise.resolve().then(work).then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new Error('EXTERNAL_UNAVAILABLE')); });
  });
}
/** Durable at-most-once external dispatch; process restarts and ambiguous replies use read-only verification. */
export class StoredUnarchiveService {
  private closed=false;private readonly physical=new Set<Promise<unknown>>();
  private readonly pending = new Map<string, Promise<Outcome>>();
  constructor(private readonly options: { port: CoreStoragePort; storeId: string; generation: number;
    /** Recheck mayDispatch after any asynchronous connection setup and immediately before the provider write. */
    unarchiveThread: (threadId: string, mayDispatch: () => Promise<boolean>) => Promise<void>;
    /** Fresh, complete provider observation; a cached absence is not evidence of external success. */
    isThreadArchived: (threadId: string) => Promise<boolean | null>;
    /** Capture the runtime object and recheck it after await mayClose(), before closing an idle connection. */
    closeIdleConnection: (sessionId: string, threadId: string, mayClose: () => Promise<boolean>) => void | Promise<void>;
    changed: (sessionId: string) => void | Promise<void>;
    externalTimeoutMs?:number;
  }) { this.options = Object.freeze({ ...options });if(options.externalTimeoutMs!==undefined&&(!Number.isSafeInteger(options.externalTimeoutMs)||options.externalTimeoutMs<1||options.externalTimeoutMs>30000))throw new StorageContractError('INVALID_ARGUMENT'); }
  private timed<T>(work:()=>Promise<T>):Promise<T>{
    if(this.physical.size>=16)return Promise.reject(new StorageContractError('OVERLOADED'));
    const physical=Promise.resolve().then(work);this.physical.add(physical);void physical.finally(()=>this.physical.delete(physical)).catch(()=>undefined);
    return deadline(()=>physical,this.options.externalTimeoutMs??10000);
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending.values()]);await Promise.allSettled([...this.physical]);}
  run(principal: Principal, sessionId: string, key: string,expectedThreadId?:string,verifyOnly=false): Promise<Outcome> {
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    const identity = JSON.stringify([principal.userId, principal.authSessionHash, sessionId, key,expectedThreadId??null,verifyOnly]);
    const existing = this.pending.get(identity); if (existing) return existing;
    if (this.pending.size >= 128) return Promise.reject(new StorageContractError('OVERLOADED'));
    const run = this.perform(principal, sessionId, key,expectedThreadId,verifyOnly);
    const tracked = run.finally(() => { if (this.pending.get(identity) === tracked) this.pending.delete(identity); });
    this.pending.set(identity, tracked); return tracked;
  }
  private request<K extends 'session.prepareUnarchive' | 'session.claimUnarchive' | 'session.finishUnarchive'>(
    principal: Principal, operationId: string, name: K, input: CoreCommandInputs[K]) {
    return { protocolVersion: 1 as const, storeId: this.options.storeId, workerGeneration: this.options.generation,
      requestId: randomUUID(), operationId, principal, command: { name, input } } as StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } };
  }
  private async complete(principal: Principal, value: Finish): Promise<Outcome> {
    const o = this.options;
    try { await o.closeIdleConnection(value.sessionId, value.threadId, () => o.port.checkSessionEffectFence({ principal,
      sessionId: value.sessionId, externalOperationId: value.externalOperationId })); }
    catch { console.warn('[Unarchive] 空闲连接重核暂不可用'); }
    try { await o.changed(value.sessionId); } catch { console.warn('[Unarchive] 当前会话通知暂不可用'); }
    try { return { state: 'committed', session: await o.port.readSession({ principal, sessionId: value.sessionId }) }; }
    catch { return { state: 'committed', session: null }; }
  }
  private async perform(principal: Principal, sessionId: string, key: string,expectedThreadId?:string,verifyOnly=false): Promise<Outcome> {
    const o = this.options, userKey = createHash('sha256').update(principal.userId).digest('hex').slice(0,32);
    const prefix = `unarchive:${userKey}:${key}`;
    // Find an already committed finish before re-preparing or issuing any external operation.
    const prior = await o.port.lookup({ storeId: o.storeId, operationId: prefix+':finish', principal });
    if (prior.state === 'committed') {
      if (prior.commandName !== 'session.finishUnarchive' || prior.value.sessionId !== sessionId) throw new StorageContractError('CONFLICT');
      if(expectedThreadId!==undefined&&prior.value.threadId!==expectedThreadId)throw new StorageContractError('CONFLICT');
      const finish = this.request(principal, prefix+':finish', 'session.finishUnarchive', { sessionId, externalOperationId: prior.value.externalOperationId });
      const identity = operationIdentity(finish);
      const exact = await o.port.lookup({ storeId: o.storeId, operationId: finish.operationId, principal,
        expected: { commandName: finish.command.name, inputDigest: identity.inputDigest } });
      return exact.state === 'committed' && exact.commandName === 'session.finishUnarchive' ? this.complete(principal, exact.value) : { state: 'unknown' };
    }
    if (prior.state === 'expired') throw new StorageContractError('OPERATION_EXPIRED');
    if (prior.state !== 'not-found') return { state: 'unknown' };
    const prepared = await executeStoredCommand(o.port, this.request(principal, prefix+':prepare', 'session.prepareUnarchive', { sessionId,...(expectedThreadId!==undefined?{expectedThreadId}:{}) }));
    if (prepared.state === 'rejected') throw new StorageContractError(prepared.code);
    if (prepared.state !== 'committed') return { state: 'unknown' };
    const input = { sessionId, externalOperationId: prepared.value.externalOperationId };
    let verifiedOnly=false;
    if(verifyOnly){
      try{verifiedOnly=await this.timed(()=>o.isThreadArchived(prepared.value.threadId))===false;}catch{/* No proof; leave the unused dispatch right prepared. */}
      if(!verifiedOnly)return {state:'unknown'};
    }
    // A fresh, private nonce is generated once for this in-memory dispatch attempt. Retrying the HTTP operation uses a new claim,
    // which observes durable dispatched and cannot repeat the old external write.
    const claim = await executeStoredCommand(o.port, this.request(principal, 'unarchive:claim:'+randomUUID(), 'session.claimUnarchive', input));
    if (claim.state !== 'committed') return { state: 'unknown' };
    let confirmed = claim.value.alreadyApplied||verifiedOnly;
    if (!confirmed) try { confirmed = await this.timed(() => o.isThreadArchived(prepared.value.threadId)) === false; } catch { /* A fresh claim can still send once if current authority remains valid. */ }
    if (claim.value.claimed && !confirmed && !verifyOnly) {
      const mayDispatch = async() => !this.closed&&await o.port.checkSessionEffectDispatch({ principal, ...input });
      try {
        if (!await mayDispatch()) return { state: 'unknown' };
        await this.timed(() => o.unarchiveThread(prepared.value.threadId, mayDispatch)); confirmed = true;
      } catch { /* May have reached the provider. Verify, never blind-retry. */ }
    }
    if (!confirmed) try { confirmed = await this.timed(() => o.isThreadArchived(prepared.value.threadId)) === false; } catch { /* Preserve the durable dispatched intent. */ }
    if (!confirmed) return { state: 'unknown' };
    const result = await executeStoredCommand(o.port, this.request(principal, prefix+':finish', 'session.finishUnarchive', input));
    return result.state === 'committed' ? this.complete(principal, result.value) : { state: 'unknown' };
  }
}
