import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexResetIdempotencyKey } from './codex-reset-key.ts';

test('reset key is a UUID v4 even when randomUUID is unavailable on an HTTP page', () => {
  const random = { getRandomValues: (bytes) => bytes.map((_, index) => index) };
  assert.equal(createCodexResetIdempotencyKey(random), '00010203-0405-4607-8809-0a0b0c0d0e0f');
});
