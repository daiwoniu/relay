import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMcpDefaults,
  getAvailableApprovalActions,
  getApprovalDecisionAvailability,
  getMcpChoices,
  getMcpDirectSubmission,
  getSafeMcpUrl,
  isMcpFormComplete,
  isSupportedMcpForm,
} from './interaction-model.ts';

test('授权按钮严格跟随 Codex 提供的决定列表', () => {
  assert.deepEqual(getAvailableApprovalActions({ availableDecisions: ['accept', 'acceptForSession', 'unknown', 1] }), [
    'accept',
    'accept_for_session',
  ]);
  assert.deepEqual(getAvailableApprovalActions({ availableDecisions: [] }), [
  ]);
  assert.deepEqual(getAvailableApprovalActions({}), [
    'accept', 'accept_for_session', 'decline', 'cancel',
  ]);
  assert.deepEqual(getApprovalDecisionAvailability({ availableDecisions: ['accept', 'decline'] }), {
    accept: true,
    acceptForSession: false,
    decline: true,
    cancel: false,
  });
  assert.deepEqual(getApprovalDecisionAvailability({ availableDecisions: [] }), {
    accept: false,
    acceptForSession: false,
    decline: false,
    cancel: false,
  });
});

test('MCP 表单识别 titled oneOf 和数组多选', () => {
  assert.deepEqual(getMcpChoices({ type: 'string', oneOf: [{ const: 'a', title: '选项 A' }] }), {
    choices: [{ value: 'a', label: '选项 A' }],
    multiple: false,
  });
  assert.deepEqual(getMcpChoices({ type: 'array', items: { enum: ['a', 'b'] } }), {
    choices: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }],
    multiple: true,
  });
});

test('MCP 授权页面只允许 HTTP 和 HTTPS', () => {
  assert.equal(getSafeMcpUrl('https://example.com/oauth?state=relay'), 'https://example.com/oauth?state=relay');
  assert.equal(getSafeMcpUrl('http://127.0.0.1:3000/callback'), 'http://127.0.0.1:3000/callback');
  assert.equal(getSafeMcpUrl('javascript:alert(1)'), null);
  assert.equal(getSafeMcpUrl('data:text/html,unsafe'), null);
  assert.equal(getSafeMcpUrl('/relative'), null);
});

test('MCP 表单应用默认值并校验必填字段', () => {
  const details = {
    mode: 'form',
    requestedSchema: {
      properties: { name: { type: 'string', default: 'Relay' }, tags: { type: 'array', items: { enum: ['a'] } } },
      required: ['name', 'tags'],
    },
  };
  assert.equal(isSupportedMcpForm(details), true);
  assert.deepEqual(buildMcpDefaults(details), { name: 'Relay' });
  assert.equal(isMcpFormComplete(details, { name: 'Relay', tags: [] }), false);
  assert.equal(isMcpFormComplete(details, { name: 'Relay', tags: ['a'] }), true);
  assert.equal(isSupportedMcpForm({ mode: 'form' }), false);
});

test('MCP 批量继续只接受 URL、空表单或默认值完整的表单', () => {
  assert.deepEqual(getMcpDirectSubmission({ mode: 'url' }), { formData: {} });
  assert.deepEqual(getMcpDirectSubmission({ mode: 'form', requestedSchema: { type: 'object', properties: {} } }), { formData: {} });
  assert.deepEqual(getMcpDirectSubmission({ mode: 'form', requestedSchema: { type: 'object' } }), { formData: {} });
  assert.deepEqual(getMcpDirectSubmission({
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: { environment: { type: 'string', default: 'staging' } },
      required: ['environment'],
    },
  }), { formData: { environment: 'staging' } });
  assert.equal(getMcpDirectSubmission({
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: { environment: { type: 'string' } },
      required: ['environment'],
    },
  }), null);
  assert.equal(getMcpDirectSubmission({ mode: 'form' }), null);
  assert.equal(getMcpDirectSubmission({ mode: 'future', requestedSchema: { type: 'object', properties: {} } }), null);
  assert.equal(getMcpDirectSubmission({
    mode: 'form',
    requestedSchema: {
      type: 'object',
      oneOf: [
        { properties: { environment: { const: 'staging' } } },
        { properties: { environment: { const: 'production' } } },
      ],
    },
  }), null);
  assert.equal(getMcpDirectSubmission({
    mode: 'form',
    requestedSchema: { type: 'object', required: ['environment'] },
  }), null);
});
