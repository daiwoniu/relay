import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PublicUserDto } from '../contracts/index.js';
import { SESSION_TTL_MS, ACCEPTANCE_SESSION_TTL_MS } from '../auth/session.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import type { StoragePrincipal, StorageRejectionCode } from './contracts.js';

export interface CredentialInputs {
  'auth.login': { username: string; password: string; tokenHash: string; ttlMs: number; requiredRole?: 'admin' };
  'auth.logout': Record<string, never>;
  'account.changePassword': { currentPassword: string; newPassword: string };
  'account.rename': { currentPassword: string; username: string };
  'account.resetPassword': { currentPassword: string; newPassword: string; userId: string };
  'account.createMember': { username: string; initialPassword: string; workspacePath: string; displayName?: string;
    canCreateProject: boolean; projectIds: string[] };
}
export interface CredentialOutputs {
  'auth.login': { user: PublicUserDto; expiresAt: number; ttlMs: number };
  'auth.logout': { revokedSessions: number };
  'account.changePassword': { revokedSessions: number };
  'account.rename': { user: PublicUserDto; revokedSessions: number };
  'account.resetPassword': { revokedSessions: number };
  'account.createMember': { user: PublicUserDto; projectId: string };
}
export type CredentialName = keyof CredentialInputs;
export type CredentialRequest<K extends CredentialName = CredentialName> = {
  protocolVersion: 1; storeId: string; requestId: string; workerGeneration: number; operationId: string;
  principal: { kind: 'login' } | Extract<StoragePrincipal, { kind: 'user' }>;
  command: { [N in K]: { name: N; input: CredentialInputs[N] } }[K];
};
export type CredentialReason = 'invalid_credentials' | 'invalid_current_password' | 'same_password' | 'same_username'
  | 'username_exists' | 'self_target' | 'user_not_found' | 'project_unavailable';
export type CredentialResult<K extends CredentialName = CredentialName> =
  | { state: 'committed'; operationId: string; committedAt: number; replayed: boolean; value: CredentialOutputs[K] }
  | { state: 'rejected'; operationId: string; code: StorageRejectionCode; reason?: CredentialReason }
  | { state: 'unknown'; operationId: string; cause: 'deadline' | 'worker-exit' | 'transport'; recovery: 'lookup' };
export interface CredentialStoragePort {
  executeCredential<K extends CredentialName>(request: CredentialRequest<K>): Promise<CredentialResult<K>>;
  /** Receipt-only verification with the exact original intent; never creates an effect. */
  lookupCredential<K extends CredentialName>(request: CredentialRequest<K>): Promise<CredentialResult<K> | { state: 'not-found' | 'unavailable' }>;
}

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const password = z.string().min(1).max(256);
const newPassword = z.string().min(6).max(50);
const username = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const inputs = {
  'auth.login': z.object({ username: z.string().trim().min(1).max(64), password, tokenHash: hash,
    ttlMs: z.union([z.literal(SESSION_TTL_MS), z.literal(ACCEPTANCE_SESSION_TTL_MS)]), requiredRole: z.literal('admin').optional() }).strict(),
  'auth.logout': z.object({}).strict(),
  'account.changePassword': z.object({ currentPassword: password, newPassword }).strict(),
  'account.rename': z.object({ currentPassword: password, username }).strict(),
  'account.resetPassword': z.object({ currentPassword: password, newPassword, userId: id }).strict(),
  'account.createMember': z.object({ username, initialPassword: newPassword, workspacePath: z.string().min(1).max(32768),
    displayName: z.string().trim().max(40).optional(), canCreateProject: z.boolean(),
    projectIds: z.array(z.string().uuid()).max(100).refine((v) => new Set(v).size === v.length) }).strict(),
} satisfies Record<CredentialName, z.ZodTypeAny>;
const envelope = z.object({ protocolVersion: z.literal(1), storeId: id, requestId: id,
  workerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  operationId: z.string().regex(/^credential:[A-Za-z0-9:._-]{1,240}$/),
  principal: z.union([z.object({ kind: z.literal('login') }).strict(),
    z.object({ kind: z.literal('user'), userId: id, authSessionHash: hash }).strict()]),
  command: z.object({ name: z.enum(Object.keys(inputs) as [CredentialName, ...CredentialName[]]), input: z.unknown() }).strict(),
}).strict();

export function parseCredentialRequest<K extends CredentialName>(input: CredentialRequest<K>): CredentialRequest<K> {
  canonicalJson(input, 16384);
  const parsed = envelope.safeParse(input);
  if (!parsed.success) throw new StorageContractError('INVALID_ARGUMENT');
  const body = inputs[parsed.data.command.name].safeParse(parsed.data.command.input);
  if (!body.success) throw new StorageContractError('INVALID_ARGUMENT');
  if ((parsed.data.command.name === 'auth.login') !== (parsed.data.principal.kind === 'login')) throw new StorageContractError('FORBIDDEN');
  if (parsed.data.command.name === 'auth.login' && (body.data as CredentialInputs['auth.login']).ttlMs === ACCEPTANCE_SESSION_TTL_MS
    && (body.data as CredentialInputs['auth.login']).requiredRole !== 'admin') throw new StorageContractError('FORBIDDEN');
  return { ...parsed.data, command: { name: parsed.data.command.name, input: body.data } } as CredentialRequest<K>;
}

/** Only non-password fields enter the fast digest. Secrets get a separate salted scrypt verifier. */
export function credentialIdentity(request: CredentialRequest) {
  const command = request.command;
  let publicInput: object; let secrets: object;
  switch (command.name) {
    case 'auth.logout': publicInput = {}; secrets = {}; break;
    case 'account.createMember': {
      const { initialPassword, ...rest } = command.input; publicInput = rest; secrets = { initialPassword }; break;
    }
    case 'auth.login': {
      const { password, ...rest } = command.input; publicInput = rest; secrets = { password }; break;
    }
    case 'account.rename': {
      const { currentPassword, ...rest } = command.input; publicInput = rest; secrets = { currentPassword }; break;
    }
    default: {
      const { currentPassword, newPassword, ...rest } = command.input; publicInput = rest; secrets = { currentPassword, newPassword };
    }
  }
  const owner = request.principal.kind === 'login' ? `login:${(command.input as CredentialInputs['auth.login']).tokenHash}` : `user:${request.principal.userId}`;
  return { owner, authorizer: request.principal.kind === 'login' ? (command.input as CredentialInputs['auth.login']).tokenHash : request.principal.authSessionHash,
    publicDigest: createHash('sha256').update(canonicalJson({ command: command.name, principal: request.principal, input: publicInput })).digest('hex'),
    secretInput: canonicalJson(secrets) };
}
