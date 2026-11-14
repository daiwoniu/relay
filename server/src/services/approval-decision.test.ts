import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedInteraction, NormalizedInteractionKind } from '../engine/interactions.js';
import type { EffectiveApprovalTrust } from './approval-trust.js';
import { attemptAutoAccept, decideApprovalRoute } from './approval-decision.js';

function interaction(
  kind: NormalizedInteractionKind,
  options: { autoApprovable?: boolean; actions?: NormalizedInteraction['availableActions'] } = {},
): NormalizedInteraction {
  return {
    id: `interaction:${kind}`,
    requestId: kind,
    kind,
    snapshot: { title: '测试请求' },
    availableActions: options.actions ?? ['accept_once', 'decline'],
    autoApprovable: options.autoApprovable ?? true,
  };
}

function trust(
  source: EffectiveApprovalTrust['source'],
  options: { trusted?: boolean; expiresAt?: number | null } = {},
): EffectiveApprovalTrust {
  return {
    trusted: options.trusted ?? source !== 'manual',
    source,
    effectiveScope: source === 'session_trust' ? 'session' : source === 'project_trust' ? 'project' : null,
    expiresAt: options.expiresAt ?? null,
    sessionOverridesProject: false,
    diagnostic: null,
  };
}

test('普通授权在有效会话或项目信任下只路由为一次性自动允许', () => {
  for (const kind of ['command', 'file', 'permissions'] as const) {
    assert.deepEqual(decideApprovalRoute(interaction(kind), trust('session_trust', { expiresAt: 20_000 })), {
      route: 'auto_accept', source: 'session_trust', expiresAt: 20_000,
    });
    assert.deepEqual(decideApprovalRoute(interaction(kind), trust('project_trust')), {
      route: 'auto_accept', source: 'project_trust', expiresAt: null,
    });
  }
});

test('人工覆盖、诊断失败和默认人工全部保持人工', () => {
  for (const effective of [
    trust('manual'),
    { ...trust('manual'), diagnostic: 'read_failed' as const },
    { ...trust('project_trust'), trusted: false },
  ]) {
    assert.equal(decideApprovalRoute(interaction('command'), effective).route, 'manual');
  }
});

test('MCP、用户输入和未知请求即使存在信任也永远人工', () => {
  for (const kind of ['mcp_elicitation', 'user_input', 'unknown'] as const) {
    assert.equal(decideApprovalRoute(interaction(kind), trust('session_trust')).route, 'manual');
  }
});

test('缺少 accept_once 或标准分面禁止自动时保持人工', () => {
  assert.equal(decideApprovalRoute(interaction('command', { actions: ['accept_for_session', 'decline'] }), trust('session_trust')).route, 'manual');
  assert.equal(decideApprovalRoute(interaction('file', { autoApprovable: false }), trust('project_trust')).route, 'manual');
});

test('自动响应只构造并发送 accept_once 一次', () => {
  const commands: unknown[] = [];
  const responses: unknown[] = [];
  const request = { requestId: 7, method: 'approval', params: {} };
  const decision = decideApprovalRoute(interaction('command'), trust('session_trust'));
  assert.equal(decision.route, 'auto_accept');
  if (decision.route !== 'auto_accept') return;

  const outcome = attemptAutoAccept({
    decision,
    adapter: {
      normalize: () => interaction('command'),
      buildResponse: (_request, command) => { commands.push(command); return { decision: 'accept' }; },
    },
    request,
    respond: (requestId, result) => responses.push({ requestId, result }),
  });

  assert.deepEqual(outcome, { outcome: 'accepted', decision });
  assert.deepEqual(commands, [{ action: 'accept_once' }]);
  assert.deepEqual(responses, [{ requestId: 7, result: { decision: 'accept' } }]);
});

test('响应构造或引擎响应异常都安全回落人工', () => {
  const request = { requestId: 7, method: 'approval', params: {} };
  const decision = decideApprovalRoute(interaction('command'), trust('project_trust'));
  assert.equal(decision.route, 'auto_accept');
  if (decision.route !== 'auto_accept') return;
  const base = {
    decision,
    request,
    adapter: { normalize: () => interaction('command'), buildResponse: () => ({ decision: 'accept' }) },
  };

  assert.deepEqual(attemptAutoAccept({
    ...base,
    adapter: { ...base.adapter, buildResponse: () => { throw new Error('unsupported'); } },
    respond: () => assert.fail('构造失败后不得发送'),
  }), { outcome: 'manual', reason: 'build_response_failed' });
  assert.deepEqual(attemptAutoAccept({
    ...base,
    respond: () => { throw new Error('connection failed'); },
  }), { outcome: 'manual', reason: 'respond_failed' });
});
