import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, Session, SharedRecord, SharedRecordWithSourceTitle } from '../db/queries.js';
import { createShareService, type ShareRepository } from './shares.js';

function createRepository() {
  const shares = new Map<string, SharedRecord>();
  const session: Session = {
    id: '11111111-1111-4111-8111-111111111111', title: '来源', title_manually_set: 0,
    created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: null,
    owner_user_id: 'owner-1',
    engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null,
  };
  const messages: Message[] = [
    { id: '22222222-2222-4222-8222-222222222222', session_id: session.id, turn_id: 'turn-1', role: 'user', content: '问题', phase: null, items: null, metadata: null, created_at: 1, duration: null, stopped: 0 },
    { id: '33333333-3333-4333-8333-333333333333', session_id: session.id, turn_id: 'turn-1', role: 'assistant', content: '回答', phase: null, items: null, metadata: JSON.stringify({ outcome: 'completed' }), created_at: 2, duration: 10, stopped: 0 },
    { id: '44444444-4444-4444-8444-444444444444', session_id: session.id, turn_id: 'turn-2', role: 'user', content: '截止线后', phase: null, items: null, metadata: null, created_at: 3, duration: null, stopped: 0 },
  ];
  const repository: ShareRepository = {
    getSession: (id) => id === session.id ? session : undefined,
    getAllMessages: () => messages,
    createSharedRecord(record) { shares.set(record.id, record); return record; },
    listSharedRecordsByOwner(owner, limit = 50, offset = 0) {
      return [...shares.values()].filter((share) => share.owner_user_id === owner).slice(offset, offset + limit)
        .map((share) => ({
          ...share,
          source_session_title: share.source_session_id ? session.title : null,
          source_session_engine: share.source_session_id ? session.engine : null,
        } satisfies SharedRecordWithSourceTitle));
    },
    countSharedRecordsByOwner: (owner) => [...shares.values()].filter((share) => share.owner_user_id === owner).length,
    getSharedRecordByPublicToken: (token) => [...shares.values()].find((share) => share.public_token === token),
    getSharedRecordForOwner: (id, owner) => {
      const share = shares.get(id); return share?.owner_user_id === owner ? share : undefined;
    },
    revokeSharedRecord(id, owner, now) { const share = shares.get(id); if (!share || share.owner_user_id !== owner || share.revoked_at !== null) return false; share.revoked_at = now ?? 0; return true; },
    deleteInvalidSharedRecord(id, owner, now) { const share = shares.get(id); if (!share || share.owner_user_id !== owner || (share.revoked_at === null && (share.expires_at === null || share.expires_at > (now ?? 0)))) return false; return shares.delete(id); },
    listSharedRecordsForActor(owner, limit = 50, offset = 0) {
      return [...shares.values()].filter((share) => owner === undefined || share.owner_user_id === owner).slice(offset, offset + limit)
        .map((share) => ({ ...share, source_session_title: session.title, source_session_engine: session.engine }));
    },
    countSharedRecordsForActor: (owner) => [...shares.values()].filter((share) => owner === undefined || share.owner_user_id === owner).length,
    getSharedRecordForActor: (id, owner) => { const share = shares.get(id); return owner === undefined || share?.owner_user_id === owner ? share : undefined; },
    revokeSharedRecordForActor(id, owner, now) { const share = shares.get(id); if (!share || (owner !== undefined && share.owner_user_id !== owner) || share.revoked_at !== null) return false; share.revoked_at = now ?? 0; return true; },
    deleteInvalidSharedRecordForActor(id, owner, now) { const share = shares.get(id); if (!share || (owner !== undefined && share.owner_user_id !== owner) || (share.revoked_at === null && (share.expires_at === null || share.expires_at > (now ?? 0)))) return false; return shares.delete(id); },
  };
  return { repository, shares, session, messages };
}

function request(scope: 'single' | 'selection' | 'session', messageIds?: string[]) {
  const base = { sessionId: '11111111-1111-4111-8111-111111111111', title: scope, includeProcess: false, expiry: { type: 'preset' as const, value: '1d' as const } };
  if (scope === 'session') return { ...base, scope } as const;
  return { ...base, scope, messageIds: messageIds || [] };
}

test('三种范围创建不可变快照且默认有效期为一天', () => {
  const { repository, shares } = createRepository();
  let id = 0;
  const service = createShareService({ repository, now: () => 1000, createId: () => `share-${++id}`, createPublicToken: () => `token-${id}` });
  service.create('owner-1', request('single', ['33333333-3333-4333-8333-333333333333']));
  service.create('owner-1', request('selection', ['33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222']));
  service.create('owner-1', request('session'));
  assert.equal(shares.size, 3);
  assert.equal(shares.get('share-1')?.expires_at, 1000 + 86_400_000);
  assert.deepEqual(JSON.parse(shares.get('share-2')!.snapshot_json).messages.map((entry: { id: string }) => entry.id), [
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
  ]);
  assert.equal(JSON.parse(shares.get('share-3')!.snapshot_json).messages.some((entry: { id: string }) => entry.id.startsWith('4444')), false);
});

test('来源会话删除后分享管理从不可变快照保留 CodeBuddy 来源', () => {
  const { repository, shares, session } = createRepository();
  session.engine = 'codebuddy';
  const service = createShareService({
    repository,
    now: () => 1000,
    createId: () => 'share-codebuddy',
    createPublicToken: () => 'token-codebuddy',
  });
  service.create('owner-1', request('session'));
  shares.get('share-codebuddy')!.source_session_id = null;
  assert.equal(service.list('owner-1').items[0]?.sourceEngine, 'codebuddy');
});

test('预览复用正式快照规则且不会创建分享记录', () => {
  const { repository, shares } = createRepository();
  const service = createShareService({ repository, now: () => 1000 });
  const preview = service.preview('owner-1', request('selection', [
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
  ]));
  assert.equal(preview.title, 'selection');
  assert.equal(preview.messageCount, 2);
  assert.equal(preview.createdAt, 1000);
  assert.equal(preview.expiresAt, 1000 + 86_400_000);
  assert.deepEqual(preview.snapshot.messages.map((entry) => entry.id), [
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
  ]);
  assert.equal(shares.size, 0);
});

test('支持自定义与永久有效期并隔离所有者管理操作', () => {
  const { repository, shares } = createRepository();
  let id = 0;
  const service = createShareService({ repository, now: () => 1000, createId: () => `share-${++id}`, createPublicToken: () => `token-${id}` });
  service.create('owner-1', { ...request('session'), expiry: { type: 'custom', expiresAt: 1000 + 600_000 } });
  service.create('owner-1', { ...request('session'), expiry: { type: 'permanent' } });
  assert.equal(shares.get('share-1')?.expires_at, 601_000);
  assert.equal(shares.get('share-2')?.expires_at, null);
  assert.throws(() => service.revoke('owner-2', 'share-1'), /不存在/);
  service.revoke('owner-1', 'share-1');
  service.delete('owner-1', 'share-1');
  assert.equal(shares.has('share-1'), false);
  assert.throws(() => service.delete('owner-1', 'share-2'), /先取消/);
});

test('来源会话引用消失不影响公开读取', () => {
  const { repository, shares } = createRepository();
  const service = createShareService({ repository, now: () => 1000, createId: () => 'share-1', createPublicToken: () => 'token-1' });
  service.create('owner-1', request('session'));
  shares.get('share-1')!.source_session_id = null;
  assert.equal(service.readPublic('token-1').state, 'active');
  assert.equal(service.list('owner-1').items[0].sourceSessionTitle, null);
});

test('Actor 分享授权隔离来源与管理范围，管理员新分享仍归自己', () => {
  const { repository, shares } = createRepository();
  let id = 0;
  const service = createShareService({ repository, now: () => 1000, createId: () => `actor-share-${++id}`, createPublicToken: () => `actor-token-${id}` });
  const memberA = { userId: 'owner-1', role: 'member' as const };
  const memberB = { userId: 'owner-2', role: 'member' as const };
  const admin = { userId: 'admin', role: 'admin' as const };

  assert.throws(() => service.previewForActor(memberB, request('session')), (error: unknown) => (error as { status?: number }).status === 404);
  service.createForActor(memberA, request('session'));
  const adminShare = service.createForActor(admin, request('session'));
  assert.equal(shares.get(adminShare.id)?.owner_user_id, 'admin');
  assert.equal(service.listForActor(memberB).total, 0);
  assert.equal(service.listForActor(admin).total, 2);
  assert.throws(() => service.revokeForActor(memberB, 'actor-share-1'), (error: unknown) => (error as { status?: number }).status === 404);
  service.revokeForActor(admin, 'actor-share-1');
  service.deleteForActor(admin, 'actor-share-1');
  assert.equal(shares.has('actor-share-1'), false);
});
