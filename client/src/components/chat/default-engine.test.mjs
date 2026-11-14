import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDefaultEngine } from './default-engine.ts';

const status = (id, available) => ({ id, available });

test('账号默认引擎可用时直接采用', () => {
  assert.deepEqual(resolveDefaultEngine('codebuddy', [status('codex', true), status('codebuddy', true)]), {
    engine: 'codebuddy', fallback: false,
  });
});

test('账号默认引擎不可用时临时回退但不改写偏好', () => {
  assert.deepEqual(resolveDefaultEngine('codebuddy', [status('codex', true), status('codebuddy', false)]), {
    engine: 'codex', fallback: true,
  });
  assert.deepEqual(resolveDefaultEngine('codex', [status('codex', false), status('codebuddy', false)]), {
    engine: null, fallback: false,
  });
});
