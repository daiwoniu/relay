import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSharesRouter } from '../server/src/routes/shares.ts';
import { createPublicSharesRouter } from '../server/src/routes/public-shares.ts';
import { createShareService } from '../server/src/services/shares.ts';
import { PublicShareRateLimiter } from '../server/src/shares/public-rate-limit.ts';

const sessionId = '11111111-1111-4111-8111-111111111111';
const userMessageId = '22222222-2222-4222-8222-222222222222';
const assistantMessageId = '33333333-3333-4333-8333-333333333333';
const laterMessageId = '44444444-4444-4444-8444-444444444444';
const shares = new Map();
let sessionExists = true;
let currentTime = 1_000_000;
let sequence = 0;

const session = {
  id: sessionId, title: '生命周期测试', title_manually_set: 0, created_at: 1, updated_at: 1,
  pinned: 0, archived: 0, project_id: null, codex_thread_id: null, codex_archived: 0,
  status: 'idle', token_usage: null, active_turn_usage: null,
};
const messages = [
  { id: userMessageId, session_id: sessionId, turn_id: 'turn-1', role: 'user', content: '问题', phase: null, items: null, metadata: null, created_at: 1, duration: null, stopped: 0 },
  { id: assistantMessageId, session_id: sessionId, turn_id: 'turn-1', role: 'assistant', content: '回答', phase: null, items: null, metadata: JSON.stringify({ outcome: 'completed' }), created_at: 2, duration: 100, stopped: 0 },
  { id: laterMessageId, session_id: sessionId, turn_id: 'turn-2', role: 'user', content: '不能进入旧分享', phase: null, items: null, metadata: null, created_at: 3, duration: null, stopped: 0 },
];

const repository = {
  getSession: (id) => sessionExists && id === sessionId ? session : undefined,
  getAllMessages: () => messages,
  createSharedRecord(record) { shares.set(record.id, record); return record; },
  listSharedRecordsByOwner(owner, limit = 50, offset = 0) { return [...shares.values()].filter((share) => share.owner_user_id === owner).slice(offset, offset + limit).map((share) => ({ ...share, source_session_title: share.source_session_id ? session.title : null })); },
  countSharedRecordsByOwner: (owner) => [...shares.values()].filter((share) => share.owner_user_id === owner).length,
  getSharedRecordByPublicToken: (token) => [...shares.values()].find((share) => share.public_token === token),
  getSharedRecordForOwner: (id, owner) => { const share = shares.get(id); return share?.owner_user_id === owner ? share : undefined; },
  revokeSharedRecord(id, owner, now) { const share = shares.get(id); if (!share || share.owner_user_id !== owner || share.revoked_at !== null) return false; share.revoked_at = now; return true; },
  deleteInvalidSharedRecord(id, owner, now) { const share = shares.get(id); if (!share || share.owner_user_id !== owner || (share.revoked_at === null && (share.expires_at === null || share.expires_at > now))) return false; return shares.delete(id); },
};

const service = createShareService({
  repository,
  now: () => currentTime,
  createId: () => `share-${++sequence}`,
  createPublicToken: () => sequence.toString(16).padStart(64, '0'),
});
const users = {
  owner1: { id: 'owner-1', username: 'owner1', role: 'admin' },
  owner2: { id: 'owner-2', username: 'owner2', role: 'member' },
};
const privateRouter = createSharesRouter({ service, authenticate: (cookie) => users[cookie] || null });
const publicRouter = createPublicSharesRouter({ service, limiter: new PublicShareRateLimiter(100), getClientId: () => 'integration-client', isOriginAllowed: () => true });

async function createShare(body, cookie = 'owner1') {
  const response = await privateRouter.request('http://relay/', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return response.json();
}

try {
  const base = { sessionId, title: '分享', includeProcess: false, expiry: { type: 'preset', value: '1d' } };
  const single = await createShare({ ...base, scope: 'single', messageIds: [assistantMessageId] });
  const selection = await createShare({ ...base, scope: 'selection', messageIds: [assistantMessageId, userMessageId] });
  const whole = await createShare({ ...base, scope: 'session' });
  const permanent = await createShare({ ...base, scope: 'session', expiry: { type: 'permanent' } });

  assert.deepEqual(JSON.parse(shares.get(selection.id).snapshot_json).messages.map((message) => message.id), [userMessageId, assistantMessageId]);
  assert.equal(JSON.parse(shares.get(whole.id).snapshot_json).messages.some((message) => message.id === laterMessageId), false);
  assert.equal(shares.get(permanent.id).expires_at, null);

  const publicResponse = await publicRouter.request(`http://relay/${single.publicToken}`);
  assert.equal(publicResponse.status, 200);
  assert.equal((await publicResponse.json()).state, 'active');

  sessionExists = false;
  for (const share of shares.values()) share.source_session_id = null;
  assert.equal((await publicRouter.request(`http://relay/${single.publicToken}`)).status, 200);

  const ownerIsolation = await privateRouter.request(`http://relay/${single.id}/revoke`, { method: 'POST', headers: { cookie: 'owner2' } });
  assert.equal(ownerIsolation.status, 404);
  assert.equal((await privateRouter.request(`http://relay/${single.id}/revoke`, { method: 'POST', headers: { cookie: 'owner1' } })).status, 200);
  const revokedBody = await (await publicRouter.request(`http://relay/${single.publicToken}`)).json();
  assert.deepEqual(revokedBody, { state: 'revoked' });
  assert.equal(JSON.stringify(revokedBody).includes('messages'), false);

  currentTime += 86_400_001;
  const expiredBody = await (await publicRouter.request(`http://relay/${selection.publicToken}`)).json();
  assert.deepEqual(expiredBody, { state: 'expired' });
  assert.equal(JSON.stringify(expiredBody).includes('messages'), false);
  assert.equal((await publicRouter.request(`http://relay/${permanent.publicToken}`)).status, 200);

  const pageSource = fs.readFileSync(path.resolve('client/src/components/sharing/PublicSharePage.tsx'), 'utf8');
  for (const forbidden of ['useRelayWebSocket', 'readFile(', '<Layout', '<ChatView']) assert.equal(pageSource.includes(forbidden), false);

  console.log(`分享生命周期验收通过：${shares.size} 个快照，单条/多选/整会话/永久/删除来源/取消/过期/所有者隔离均符合预期`);
} finally {
  shares.clear();
}
