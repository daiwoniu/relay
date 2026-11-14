import assert from 'node:assert/strict';
import test from 'node:test';
import { createUncheckedEngineHealth } from './health.js';

test('兼容健康快照明确标记未经检查的维度', () => {
  const health = createUncheckedEngineHealth({
    engineId: 'codebuddy', available: true, code: 'AVAILABLE', message: '可用', process: 'on_demand',
  });
  assert.equal(health.engineId, 'codebuddy');
  assert.equal(health.protocol, 'unchecked');
  assert.equal(health.readiness, 'unchecked');
  assert.equal(health.process, 'on_demand');
});
