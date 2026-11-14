import { randomUUID } from 'node:crypto';

export class FileAccessGrants {
  private readonly grants = new Map<string, { realPath: string; ownerUserId?: string; expiresAt: number }>();

  constructor(private readonly ttlMs = 60 * 60 * 1000) {}

  grant(realPath: string, ownerUserIdOrNow?: string | number, now = Date.now()): string {
    const ownerUserId = typeof ownerUserIdOrNow === 'string' ? ownerUserIdOrNow : undefined;
    const createdAt = typeof ownerUserIdOrNow === 'number' ? ownerUserIdOrNow : now;
    const accessToken = randomUUID();
    this.grants.set(accessToken, { realPath, ownerUserId, expiresAt: createdAt + this.ttlMs });
    return accessToken;
  }

  allows(realPath: string, accessToken: string | undefined, ownerUserIdOrNow?: string | number, now = Date.now()): boolean {
    const ownerUserId = typeof ownerUserIdOrNow === 'string' ? ownerUserIdOrNow : undefined;
    const checkedAt = typeof ownerUserIdOrNow === 'number' ? ownerUserIdOrNow : now;
    if (!accessToken) return false;
    const grant = this.grants.get(accessToken);
    if (!grant) return false;
    if (grant.expiresAt <= checkedAt) {
      this.grants.delete(accessToken);
      return false;
    }
    return grant.realPath === realPath && (grant.ownerUserId === undefined || grant.ownerUserId === ownerUserId);
  }

  revoke(accessToken: string, ownerUserId?: string): void {
    const grant = this.grants.get(accessToken);
    if (grant?.ownerUserId !== undefined && grant.ownerUserId !== ownerUserId) return;
    this.grants.delete(accessToken);
  }

  consume(realPath: string, accessToken: string | undefined, ownerUserIdOrNow?: string | number, now = Date.now()): boolean {
    if (!this.allows(realPath, accessToken, ownerUserIdOrNow, now) || !accessToken) return false;
    this.grants.delete(accessToken);
    return true;
  }
}

export const fileAccessGrants = new FileAccessGrants();
