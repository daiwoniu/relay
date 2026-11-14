import type { Context } from 'hono';
import type { UserRole } from '../db/user-role.js';
import { ServiceError } from '../services/errors.js';
import type { StoragePrincipal } from '../storage/contracts.js';
import type { PublicUserDto } from '../contracts/index.js';

export interface Actor {
  userId: string;
  role: UserRole;
}

export interface OwnedResource {
  owner_user_id?: string | null;
}

export interface RelayEnv {
  Variables: {
    relayActor: Actor;
    relayStoragePrincipal?: Extract<StoragePrincipal, { kind: 'user' }>;
    relayAuthSession?: { user: PublicUserDto; tokenHash: string; expiresAt: number };
  };
}

export function canManageOwnedResource(actor: Actor, ownerUserId?: string | null): boolean {
  return Boolean(ownerUserId) && (actor.role === 'admin' || ownerUserId === actor.userId);
}

export function visibleOwnerUserId(actor: Actor): string | undefined {
  return actor.role === 'admin' ? undefined : actor.userId;
}

export function requireOwnedResource<T extends OwnedResource>(
  actor: Actor,
  resource: T | null | undefined,
  resourceName: string,
): T {
  if (!resource || !canManageOwnedResource(actor, resource.owner_user_id)) {
    throw new ServiceError(404, `${resourceName}不存在`);
  }
  return resource;
}

export function getRequestActor(c: Context<RelayEnv>): Actor {
  return c.get('relayActor');
}
