import { randomBytes } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import {
  CreateShareResponseDtoSchema,
  SharePreviewResponseDtoSchema,
  ShareListResponseDtoSchema,
  type CreateShareRequest,
  type CreateShareResponseDto,
  type PublicShareResponseDto,
  type SharePreviewResponseDto,
  type ShareListResponseDto,
} from '../contracts/index.js';
import * as queries from '../db/queries.js';
import type { Message, Session, SharedRecord, SharedRecordWithSourceTitle } from '../db/queries.js';
import {
  SHARE_SNAPSHOT_BYTES_MAX,
  SHARE_SNAPSHOT_MESSAGE_MAX,
  getShareManagementStatus,
  resolveShareExpiry,
  validateShareSelection,
} from '../shares/model.js';
import { buildShareSnapshot, readShareSnapshot } from '../shares/snapshot.js';
import { ServiceError } from './errors.js';
import { canManageOwnedResource, visibleOwnerUserId, type Actor } from '../auth/authorization.js';
import { recordAdminAudit, runAdminAuditedAction, type AdminAuditInput } from '../db/admin-audit.js';

export interface ShareRepository {
  getSession(id: string): Session | undefined;
  getAllMessages(sessionId: string): Message[];
  createSharedRecord(record: SharedRecord): SharedRecord;
  listSharedRecordsByOwner(ownerUserId: string, limit?: number, offset?: number): SharedRecordWithSourceTitle[];
  countSharedRecordsByOwner(ownerUserId: string): number;
  getSharedRecordByPublicToken(publicToken: string): SharedRecord | undefined;
  getSharedRecordForOwner(id: string, ownerUserId: string): SharedRecord | undefined;
  revokeSharedRecord(id: string, ownerUserId: string, now?: number): boolean;
  deleteInvalidSharedRecord(id: string, ownerUserId: string, now?: number): boolean;
  listSharedRecordsForActor?(ownerUserId: string | undefined, limit?: number, offset?: number): SharedRecordWithSourceTitle[];
  countSharedRecordsForActor?(ownerUserId?: string): number;
  getSharedRecordForActor?(id: string, ownerUserId?: string): SharedRecord | undefined;
  revokeSharedRecordForActor?(id: string, ownerUserId: string | undefined, now?: number): boolean;
  deleteInvalidSharedRecordForActor?(id: string, ownerUserId: string | undefined, now?: number): boolean;
}

export function createShareService({
  repository = queries,
  now = () => Date.now(),
  createId = () => uuid(),
  createPublicToken = () => randomBytes(32).toString('hex'),
  audit = repository === queries ? recordAdminAudit : () => false,
}: {
  repository?: ShareRepository;
  now?: () => number;
  createId?: () => string;
  createPublicToken?: () => string;
  audit?: (input: AdminAuditInput) => boolean;
} = {}) {
  const useDefaultAudit = repository === queries && audit === recordAdminAudit;
  const audited = <T>(input: AdminAuditInput, action: () => T): T => {
    if (useDefaultAudit) return runAdminAuditedAction(input, action);
    const result = action();
    audit({ ...input, result: 'succeeded' });
    return result;
  };
  const sourceEngineForRecord = (record: SharedRecordWithSourceTitle) => {
    if (record.source_session_engine) return record.source_session_engine;
    try {
      return readShareSnapshot(record.snapshot_version, record.snapshot_json).sourceEngine;
    } catch {
      return 'codex' as const;
    }
  };

  const prepareShare = (request: CreateShareRequest, actor?: Actor) => {
    const selectionError = validateShareSelection(request);
    if (selectionError) throw new ServiceError(400, selectionError);
    const session = repository.getSession(request.sessionId);
    if (!session || (actor && !canManageOwnedResource(actor, session.owner_user_id))) throw new ServiceError(404, '会话不存在');
    const createdAt = now();
    let expiresAt: number | null;
    try {
      expiresAt = resolveShareExpiry(request.expiry, createdAt);
    } catch (error) {
      throw new ServiceError(400, error instanceof Error ? error.message : '无效的分享有效期');
    }
    let snapshot;
    try {
      snapshot = buildShareSnapshot(repository.getAllMessages(session.id), {
        scope: request.scope,
        includeProcess: request.includeProcess,
        ...(session.engine ? { sourceEngine: session.engine } : {}),
        ...('messageIds' in request ? { messageIds: request.messageIds } : {}),
      });
    } catch (error) {
      throw new ServiceError(400, error instanceof Error ? error.message : '无法创建分享快照');
    }
    if (snapshot.messages.length > SHARE_SNAPSHOT_MESSAGE_MAX) {
      throw new ServiceError(400, `分享消息不能超过 ${SHARE_SNAPSHOT_MESSAGE_MAX} 条`);
    }
    const snapshotJson = JSON.stringify(snapshot);
    if (Buffer.byteLength(snapshotJson, 'utf8') > SHARE_SNAPSHOT_BYTES_MAX) {
      throw new ServiceError(400, '分享内容过大，请减少消息数量或关闭处理过程');
    }
    return { session, createdAt, expiresAt, snapshot, snapshotJson };
  };

  return {
    previewForActor(actor: Actor, request: CreateShareRequest): SharePreviewResponseDto {
      const prepared = prepareShare(request, actor);
      return SharePreviewResponseDtoSchema.parse({ title: request.title, messageCount: prepared.snapshot.messages.length, createdAt: prepared.createdAt, expiresAt: prepared.expiresAt, snapshot: prepared.snapshot });
    },

    createForActor(actor: Actor, request: CreateShareRequest): CreateShareResponseDto {
      const { session, createdAt, expiresAt, snapshot, snapshotJson } = prepareShare(request, actor);
      const record: SharedRecord = { id: createId(), public_token: createPublicToken(), owner_user_id: actor.userId, source_session_id: session.id, title: request.title, scope: request.scope, message_count: snapshot.messages.length, include_process: request.includeProcess ? 1 : 0, snapshot_version: snapshot.version, snapshot_json: snapshotJson, created_at: createdAt, expires_at: expiresAt, revoked_at: null };
      if (session.owner_user_id) audited({ actorUserId: actor.userId, action: 'share.create_from_session', resourceType: 'session', resourceId: session.id, ownerUserId: session.owner_user_id }, () => repository.createSharedRecord(record));
      else repository.createSharedRecord(record);
      return CreateShareResponseDtoSchema.parse({ id: record.id, publicToken: record.public_token, createdAt, expiresAt });
    },

    preview(_ownerUserId: string, request: CreateShareRequest): SharePreviewResponseDto {
      const prepared = prepareShare(request);
      return SharePreviewResponseDtoSchema.parse({
        title: request.title,
        messageCount: prepared.snapshot.messages.length,
        createdAt: prepared.createdAt,
        expiresAt: prepared.expiresAt,
        snapshot: prepared.snapshot,
      });
    },

    create(ownerUserId: string, request: CreateShareRequest): CreateShareResponseDto {
      const { session, createdAt, expiresAt, snapshot, snapshotJson } = prepareShare(request);
      const record: SharedRecord = {
        id: createId(),
        public_token: createPublicToken(),
        owner_user_id: ownerUserId,
        source_session_id: session.id,
        title: request.title,
        scope: request.scope,
        message_count: snapshot.messages.length,
        include_process: request.includeProcess ? 1 : 0,
        snapshot_version: snapshot.version,
        snapshot_json: snapshotJson,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
      };
      repository.createSharedRecord(record);
      return CreateShareResponseDtoSchema.parse({
        id: record.id,
        publicToken: record.public_token,
        createdAt,
        expiresAt,
      });
    },

    list(ownerUserId: string, limit = 50, offset = 0): ShareListResponseDto {
      const currentTime = now();
      return ShareListResponseDtoSchema.parse({
        items: repository.listSharedRecordsByOwner(ownerUserId, limit, offset).map((record) => ({
          id: record.id,
          publicToken: record.public_token,
          title: record.title,
          scope: record.scope,
          messageCount: record.message_count,
          includeProcess: record.include_process === 1,
          sourceSessionId: record.source_session_id,
          sourceSessionTitle: record.source_session_title,
          sourceEngine: sourceEngineForRecord(record),
          createdAt: record.created_at,
          expiresAt: record.expires_at,
          revokedAt: record.revoked_at,
          status: getShareManagementStatus({ expiresAt: record.expires_at, revokedAt: record.revoked_at }, currentTime),
        })),
        total: repository.countSharedRecordsByOwner(ownerUserId),
      });
    },

    listForActor(actor: Actor, limit = 50, offset = 0): ShareListResponseDto {
      const ownerUserId = visibleOwnerUserId(actor);
      const records = repository.listSharedRecordsForActor
        ? repository.listSharedRecordsForActor(ownerUserId, limit, offset)
        : repository.listSharedRecordsByOwner(actor.userId, limit, offset);
      const currentTime = now();
      return ShareListResponseDtoSchema.parse({
        items: records.map((record) => ({
          id: record.id, publicToken: record.public_token, title: record.title, scope: record.scope,
          messageCount: record.message_count, includeProcess: record.include_process === 1,
          sourceSessionId: record.source_session_id, sourceSessionTitle: record.source_session_title,
          sourceEngine: sourceEngineForRecord(record), createdAt: record.created_at, expiresAt: record.expires_at,
          revokedAt: record.revoked_at,
          status: getShareManagementStatus({ expiresAt: record.expires_at, revokedAt: record.revoked_at }, currentTime),
        })),
        total: repository.countSharedRecordsForActor
          ? repository.countSharedRecordsForActor(ownerUserId)
          : repository.countSharedRecordsByOwner(actor.userId),
      });
    },

    revoke(ownerUserId: string, id: string): void {
      if (!repository.getSharedRecordForOwner(id, ownerUserId)) throw new ServiceError(404, '分享不存在');
      if (!repository.revokeSharedRecord(id, ownerUserId, now())) throw new ServiceError(409, '分享已经取消');
    },

    revokeForActor(actor: Actor, id: string): void {
      const ownerUserId = visibleOwnerUserId(actor);
      const record = repository.getSharedRecordForActor
        ? repository.getSharedRecordForActor(id, ownerUserId)
        : repository.getSharedRecordForOwner(id, actor.userId);
      if (!record) throw new ServiceError(404, '分享不存在');
      audited({ actorUserId: actor.userId, action: 'share.revoke', resourceType: 'share', resourceId: id, ownerUserId: record.owner_user_id }, () => {
        const changed = repository.revokeSharedRecordForActor
          ? repository.revokeSharedRecordForActor(id, ownerUserId, now())
          : repository.revokeSharedRecord(id, actor.userId, now());
        if (!changed) throw new ServiceError(409, '分享已经取消');
      });
    },

    delete(ownerUserId: string, id: string): void {
      if (!repository.getSharedRecordForOwner(id, ownerUserId)) throw new ServiceError(404, '分享不存在');
      if (!repository.deleteInvalidSharedRecord(id, ownerUserId, now())) {
        throw new ServiceError(409, '有效分享需要先取消后才能删除');
      }
    },

    deleteForActor(actor: Actor, id: string): void {
      const ownerUserId = visibleOwnerUserId(actor);
      const record = repository.getSharedRecordForActor
        ? repository.getSharedRecordForActor(id, ownerUserId)
        : repository.getSharedRecordForOwner(id, actor.userId);
      if (!record) throw new ServiceError(404, '分享不存在');
      audited({ actorUserId: actor.userId, action: 'share.delete', resourceType: 'share', resourceId: id, ownerUserId: record.owner_user_id }, () => {
        const deleted = repository.deleteInvalidSharedRecordForActor
          ? repository.deleteInvalidSharedRecordForActor(id, ownerUserId, now())
          : repository.deleteInvalidSharedRecord(id, actor.userId, now());
        if (!deleted) throw new ServiceError(409, '有效分享需要先取消后才能删除');
      });
    },

    readPublic(publicToken: string): PublicShareResponseDto {
      const record = repository.getSharedRecordByPublicToken(publicToken);
      if (!record) return { state: 'not_found' };
      const status = getShareManagementStatus({ expiresAt: record.expires_at, revokedAt: record.revoked_at }, now());
      if (status === 'expired') return { state: 'expired' };
      if (status === 'revoked') return { state: 'revoked' };
      try {
        return {
          state: 'active',
          title: record.title,
          messageCount: record.message_count,
          createdAt: record.created_at,
          expiresAt: record.expires_at,
          snapshot: readShareSnapshot(record.snapshot_version, record.snapshot_json),
        };
      } catch {
        return { state: 'unreadable' };
      }
    },
  };
}

export type ShareService = ReturnType<typeof createShareService>;
export const shareService = createShareService();
