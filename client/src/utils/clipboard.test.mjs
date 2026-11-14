import assert from 'node:assert/strict';
import test from 'node:test';
import { copyToClipboard } from './clipboard.ts';

test('a failed HTTP clipboard fallback rejects instead of reporting a successful copy', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let removed = false;
  const textarea = { value: '', style: {}, select() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => textarea, execCommand: () => false,
    body: { appendChild() {}, removeChild() { removed = true; } },
  } });
  try {
    await assert.rejects(copyToClipboard('local content'), /复制失败/);
    assert.equal(removed, true);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
  }
});
