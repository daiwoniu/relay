import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearProjectApprovalTrust,
  clearSessionApprovalTrust,
  getProjectApprovalTrust,
  getSessionApprovalTrust,
  putProjectApprovalTrust,
  putSessionApprovalTrust,
} from './approval-trust.ts';

const state = {
  projectSetting: null,
  sessionSetting: null,
  effective: {
    trusted: false,
    source: 'manual',
    effectiveScope: null,
    expiresAt: null,
    sessionOverridesProject: false,
    diagnostic: null,
  },
};

test('授权信任 API 使用正确的项目与会话 GET 路径', async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push([String(input), init]);
    return new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  assert.deepEqual(await getProjectApprovalTrust('project id', { fetchImpl }), state);
  assert.deepEqual(await getSessionApprovalTrust('session/id', { fetchImpl }), state);
  assert.equal(calls[0][0], '/api/projects/project%20id/approval-trust');
  assert.equal(calls[1][0], '/api/sessions/session%2Fid/approval-trust');
  assert.equal(calls[0][1]?.method, undefined);
});

test('授权信任 API 的 PUT 仅提交服务端期限与模式枚举', async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push([String(input), init]);
    return new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await putProjectApprovalTrust('p1', 'eight_hours', { fetchImpl });
  await putSessionApprovalTrust('s1', { mode: 'manual', duration: 'permanent' }, { fetchImpl });
  assert.equal(calls[0][1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0][1].body), { duration: 'eight_hours' });
  assert.equal(calls[1][1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1][1].body), { mode: 'manual', duration: 'permanent' });
});

test('授权信任 API 的 DELETE 返回删除后的权威状态', async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push([String(input), init]);
    return new Response(JSON.stringify(state), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  assert.deepEqual(await clearProjectApprovalTrust('p1', { fetchImpl }), state);
  assert.deepEqual(await clearSessionApprovalTrust('s1', { fetchImpl }), state);
  assert.deepEqual(calls.map((call) => call[1].method), ['DELETE', 'DELETE']);
});
