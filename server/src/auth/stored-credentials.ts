import { randomUUID } from 'node:crypto';
import { createSessionToken, SESSION_TTL_MS } from './session.js';
import { parseCredentialRequest, type CredentialInputs, type CredentialName, type CredentialRequest, type CredentialResult, type CredentialStoragePort } from '../storage/credential-contracts.js';
import type { StoragePrincipal } from '../storage/contracts.js';

type UserPrincipal = Extract<StoragePrincipal, { kind: 'user' }>;
/** Prepared intents are private, memory-only values. Never serialize them into logs, queues or HTTP responses. */
export class StoredCredentialService {
  private readonly storeId: string;
  private readonly generation: number;
  constructor(private readonly port: CredentialStoragePort, options: { storeId: string; generation: number }) {
    this.storeId = options.storeId; this.generation = options.generation;
  }
  private prepare<K extends CredentialName>(principal: CredentialRequest['principal'], name: K, input: CredentialInputs[K]): CredentialRequest<K> {
    return parseCredentialRequest({ protocolVersion: 1, storeId: this.storeId, workerGeneration: this.generation,
      requestId: randomUUID(), operationId: `credential:${randomUUID()}`, principal,
      command: { name, input } } as CredentialRequest<K>);
  }
  prepareLogin(username: string, password: string, policy: { ttlMs?: number; requiredRole?: 'admin' } = {}) {
    const { token, tokenHash } = createSessionToken();
    const operation = this.prepare({ kind: 'login' }, 'auth.login', { username, password, tokenHash,
      ttlMs: policy.ttlMs ?? SESSION_TTL_MS, ...(policy.requiredRole ? { requiredRole: policy.requiredRole } : {}) });
    return { token, operation };
  }
  preparePasswordChange(principal: UserPrincipal, currentPassword: string, newPassword: string) {
    return this.prepare(principal, 'account.changePassword', { currentPassword, newPassword });
  }
  prepareLogout(principal: UserPrincipal) {
    return this.prepare(principal, 'auth.logout', {});
  }
  prepareRename(principal: UserPrincipal, currentPassword: string, username: string) {
    return this.prepare(principal, 'account.rename', { currentPassword, username });
  }
  preparePasswordReset(principal: UserPrincipal, currentPassword: string, userId: string, newPassword: string) {
    return this.prepare(principal, 'account.resetPassword', { currentPassword, userId, newPassword });
  }
  prepareCreateMember(principal: UserPrincipal, input: CredentialInputs['account.createMember']) {
    return this.prepare(principal, 'account.createMember', input);
  }
  /** Resolve once from the exact receipt. Not-found / unavailable never triggers a blind second write. */
  async run<K extends CredentialName>(intent: CredentialRequest<K>): Promise<CredentialResult<K>> {
    const request = parseCredentialRequest(intent);
    const result = await this.port.executeCredential(request);
    if (result.state !== 'unknown') return result;
    try {
      const lookup = await this.port.lookupCredential(request);
      if (lookup.state === 'committed') return lookup;
      // A denied/expired lookup says nothing about whether the original transaction committed.
      // A retained receipt for different input is the one definite intent conflict.
      return lookup.state === 'rejected' && lookup.code === 'CONFLICT' ? lookup : result;
    } catch { return result; }
  }
}
