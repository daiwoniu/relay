import type { PublicUserDto } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';

export interface StoredAuthClient {
  userId: string; tokenHash: string;
  isCurrent(): boolean;
  /** Async implementations must recheck the guard after their own awaits. */
  revoke(isCurrent: () => boolean): void | Promise<void>;
  refresh(user: PublicUserDto, expiresAt: number, isCurrent: () => boolean): void | Promise<void>;
}
/** Recheck live tokens, never close every connection blindly on an old command replay. */
export class StoredAuthRevocations {
  private readonly checks = new Map<string, Promise<void>>();
  constructor(private readonly port: Pick<CoreStoragePort, 'authenticateSession'>, private readonly clients: () => readonly StoredAuthClient[]) {}
  recheckUser(userId: string): Promise<void> {
    const previous = this.checks.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      for (const client of this.clients().filter((c) => c.userId === userId)) {
        const tokenHash = client.tokenHash;
        const isCurrent = () => client.isCurrent() && client.tokenHash === tokenHash && client.userId === userId;
        if (!isCurrent()) continue;
        const current = await this.port.authenticateSession({ tokenHash });
        if (!isCurrent()) continue;
        if (!current || current.user.id !== userId || current.user.mustChangePassword) await client.revoke(isCurrent);
        else await client.refresh(current.user, current.expiresAt, isCurrent);
      }
    });
    const tracked = run.finally(() => { if (this.checks.get(userId) === tracked) this.checks.delete(userId); });
    this.checks.set(userId, tracked); return tracked;
  }
}
