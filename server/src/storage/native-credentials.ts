import type { SQLiteDB } from '../db/index.js';
import type { User } from '../db/query-types.js';
import { presentPublicUser } from '../contracts/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import { createMemberWithDefaultProjectInDatabase } from '../db/queries-account.js';
import path from 'node:path';
import { recordRejectedAdminOperation } from './native-admin-outcome.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import { credentialIdentity, parseCredentialRequest, type CredentialRequest, type CredentialResult, type CredentialReason } from './credential-contracts.js';

type DB = Pick<SQLiteDB, 'get' | 'all' | 'run' | 'exec' | 'saveToFile'>;
const userColumns = 'id,username,password_hash,role,display_name,avatar_updated_at,default_project_id,default_engine,default_model_id,must_change_password,disabled_at,can_create_project';
class CredentialError extends StorageContractError {
  constructor(code: ConstructorParameters<typeof StorageContractError>[0], readonly reason?: CredentialReason) { super(code); }
}
function deny(code: ConstructorParameters<typeof StorageContractError>[0], reason?: CredentialReason): never { throw new CredentialError(code, reason); }

/** Worker-only, shares the outer native transaction. No raw token or plaintext password is journaled. */
export function executeNativeCredential(db: DB, transaction: <T>(work: () => T) => T,
  input: CredentialRequest, storeId: string, generation: number, lookupOnly = false): CredentialResult | { state: 'not-found' } {
  const request = parseCredentialRequest(input);
  if (request.storeId !== storeId || request.workerGeneration !== generation) deny('CONFLICT');
  const identity = credentialIdentity(request);
  const findUser = (id: string) => db.get(`SELECT ${userColumns} FROM users WHERE id=?`, [id]) as User | undefined;
  const validSession = (id: string, token: string, now: number) => !!db.get('SELECT user_id FROM auth_sessions WHERE user_id=? AND token_hash=? AND expires_at>?', [id, token, now]);
  try {
    return transaction(() => {
      const now = Date.now();
      const prior = db.get('SELECT * FROM _relay_credential_operations WHERE operation_id=?', [request.operationId]);
      const actor = request.principal.kind === 'user' ? findUser(request.principal.userId) : undefined;
      if (request.principal.kind === 'user') {
        if (!actor || actor.disabled_at != null) deny('FORBIDDEN');
        // Password changes and logout revoke the presenting session. Only their exact receipt may be recovered.
        const revokedByThisOperation = prior && ['account.changePassword', 'auth.logout'].includes(request.command.name)
          && prior.owner_key === identity.owner && prior.authorizer_hash === identity.authorizer;
        if (!validSession(actor.id, identity.authorizer, now) && !revokedByThisOperation) deny('FORBIDDEN');
        if (actor.must_change_password === 1 && !['account.changePassword', 'auth.logout'].includes(request.command.name)) deny('FORBIDDEN');
        if (['account.resetPassword', 'account.createMember'].includes(request.command.name) && actor.role !== 'admin') deny('FORBIDDEN');
      }
      if (prior) {
        if (prior.owner_key !== identity.owner || prior.authorizer_hash !== identity.authorizer) deny('FORBIDDEN');
        if (prior.command_name !== request.command.name || prior.public_digest !== identity.publicDigest
          || !verifyPassword(identity.secretInput, prior.secret_verifier)) deny('CONFLICT');
        if (prior.expired || prior.result_json == null) deny('OPERATION_EXPIRED');
        const value = JSON.parse(prior.result_json);
        if (request.command.name === 'auth.login') {
          const user = findUser(prior.subject_user_id);
          if (!user || user.disabled_at != null || !validSession(user.id, identity.authorizer, now)
            || request.command.input.requiredRole && request.command.input.requiredRole !== user.role) deny('OPERATION_EXPIRED');
          value.user = presentPublicUser(user); // A replay must not restore an outdated role or account preference.
        }
        if (request.command.name === 'account.rename') value.user = presentPublicUser(actor!);
        if (request.command.name === 'account.createMember') {
          const subject = findUser(prior.subject_user_id);
          if (!subject) deny('OPERATION_EXPIRED');
          value.user = presentPublicUser(subject);
        }
        return { state: 'committed', operationId: request.operationId, committedAt: prior.committed_at, replayed: true, value };
      }
      if (lookupOnly) return { state: 'not-found' };
      let value: unknown; let subjectId: string;
      const command = request.command;
      if (command.name === 'auth.login') {
        const user = db.get(`SELECT ${userColumns} FROM users WHERE username=? COLLATE NOCASE`, [command.input.username]) as User | undefined;
        if (!user || user.disabled_at != null || !verifyPassword(command.input.password, user.password_hash)
          || command.input.requiredRole && command.input.requiredRole !== user.role) deny('FORBIDDEN', 'invalid_credentials');
        if (db.get('SELECT user_id FROM auth_sessions WHERE token_hash=?', [command.input.tokenHash])
          || db.get("SELECT operation_id FROM _relay_credential_operations WHERE command_name='auth.login' AND authorizer_hash=?", [command.input.tokenHash])) deny('CONFLICT');
        const expiresAt = now + command.input.ttlMs;
        db.run('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)', [command.input.tokenHash, user.id, now, expiresAt]);
        subjectId = user.id; value = { user: presentPublicUser(user), expiresAt, ttlMs: command.input.ttlMs };
      } else if (command.name === 'account.createMember') {
        if (!actor) deny('FORBIDDEN');
        if (!path.isAbsolute(command.input.workspacePath)) deny('INVALID_ARGUMENT');
        if (db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE', [command.input.username])) deny('CONFLICT', 'username_exists');
        for (const id of command.input.projectIds) {
          if (!db.get('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL', [id])) deny('NOT_FOUND', 'project_unavailable');
        }
        const { initialPassword, ...member } = command.input;
        const created = createMemberWithDefaultProjectInDatabase(db, { ...member,
          passwordHash: hashPassword(initialPassword), displayName: member.displayName || null, now });
        subjectId = created.user.id;
        appendAdminAuditEventInDatabase(db, { actorUserId: actor.id, action: 'account.create', resourceType: 'user',
          resourceId: subjectId, ownerUserId: subjectId, result: 'succeeded', occurredAt: now });
        value = { user: presentPublicUser(created.user), projectId: created.project.id };
      } else if (command.name === 'auth.logout') {
        if (!actor) deny('FORBIDDEN');
        subjectId = actor.id;
        db.run('DELETE FROM auth_sessions WHERE user_id=? AND token_hash=?', [actor.id, identity.authorizer]);
        value = { revokedSessions: 1 };
      } else {
        if (!actor || !verifyPassword(command.input.currentPassword, actor.password_hash)) deny('FORBIDDEN', 'invalid_current_password');
        subjectId = command.name === 'account.resetPassword' ? command.input.userId : actor.id;
        if (command.name === 'account.resetPassword' && subjectId === actor.id) deny('CONFLICT', 'self_target');
        const target = findUser(subjectId);
        if (!target) deny('NOT_FOUND', 'user_not_found');
        if (command.name === 'account.rename') {
          if (actor.username === command.input.username) deny('CONFLICT', 'same_username');
          const conflict = db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?', [command.input.username, actor.id]);
          if (conflict) deny('CONFLICT', 'username_exists');
          const revokedSessions = Number(db.get('SELECT count(*) AS n FROM auth_sessions WHERE user_id=? AND token_hash<>?', [actor.id, identity.authorizer])?.n);
          db.run('UPDATE users SET username=?,updated_at=? WHERE id=?', [command.input.username, now, actor.id]);
          db.run('DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?', [actor.id, identity.authorizer]);
          value = { user: presentPublicUser(findUser(actor.id)!), revokedSessions };
        } else {
          if (verifyPassword(command.input.newPassword, target.password_hash)) deny('CONFLICT', 'same_password');
          const revokedSessions = Number(db.get('SELECT count(*) AS n FROM auth_sessions WHERE user_id=?', [subjectId])?.n);
          db.run('UPDATE users SET password_hash=?,must_change_password=?,updated_at=? WHERE id=?',
            [hashPassword(command.input.newPassword), Number(command.name === 'account.resetPassword'), now, subjectId]);
          db.run('DELETE FROM auth_sessions WHERE user_id=?', [subjectId]);
          if (command.name === 'account.resetPassword') appendAdminAuditEventInDatabase(db, {
            actorUserId: actor.id, action: 'account.reset_password', resourceType: 'user', resourceId: subjectId,
            ownerUserId: subjectId, result: 'succeeded', occurredAt: now });
          value = { revokedSessions };
        }
      }
      db.run(`INSERT INTO _relay_credential_operations
        (operation_id,owner_key,authorizer_hash,command_name,public_digest,secret_verifier,subject_user_id,result_json,committed_at,expired)
        VALUES(?,?,?,?,?,?,?,?,?,0)`, [request.operationId, identity.owner, identity.authorizer, command.name, identity.publicDigest,
        hashPassword(identity.secretInput), subjectId, canonicalJson(value), now]);
      return { state: 'committed', operationId: request.operationId, committedAt: now, replayed: false, value } as CredentialResult;
    });
  } catch (error) {
    if (!lookupOnly && error instanceof StorageContractError && request.command.name === 'account.resetPassword' && request.principal.kind === 'user') {
      try { recordRejectedAdminOperation(db, transaction, { principal: request.principal,
        operationId: request.operationId, action: 'account.reset_password', resourceType: 'user', resourceId: request.command.input.userId }); }
      catch { return { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' }; }
    }
    if (error instanceof StorageContractError) return { state: 'rejected', operationId: request.operationId, code: error.code,
      ...(error instanceof CredentialError && error.reason ? { reason: error.reason } : {}) };
    return { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' };
  }
}
