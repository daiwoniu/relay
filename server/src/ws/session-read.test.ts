import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSessionRead } from './session-read.js';
import type { FrontendClient } from './frontend-client-hub.js';

test('已读指令拒绝越权、后台会话和过期回合，只按发起用户同步收据', () => {
  const client = { userId: 'viewer', activeSubscriptionSessionId: 's' } as FrontendClient;
  const writes: unknown[][] = [];
  const sent: unknown[][] = [];
  const ports = { persist: (...args: string[]) => { writes.push(args); return true; }, publish: (...args: unknown[]) => { sent.push(args); } };
  const result = { messageId: 'result-2', turnId: 'turn-2', status: 'completed' as const, createdAt: 1 };
  const getSession = () => ({ last_result: result });
  handleSessionRead(client, { sessionId: 's', messageId: 'result-2' }, () => false, getSession, ports);
  handleSessionRead(client, { sessionId: 'background', messageId: 'result-2' }, () => true, getSession, ports);
  handleSessionRead(client, { sessionId: 's', messageId: 'result-1' }, () => true, getSession, ports);
  assert.equal(writes.length, 0);
  assert.equal(sent.length, 0);
  handleSessionRead(client, { sessionId: 's', messageId: 'result-2' }, () => true, getSession, ports);
  assert.deepEqual(writes, [['viewer', 's', 'result-2']]);
  assert.deepEqual(sent, [['viewer', { type: 'session_reads', receipts: { s: 'result-2' } }]]);
});
