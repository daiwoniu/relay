import test from 'node:test';
import assert from 'node:assert/strict';
import { fitsTextPreviewResponse } from './filesystem-preview.js';

test('text response budget includes UTF-8 bytes and JSON escaping without allocating the expanded payload', () => {
  for (const content of ['', 'plain', '中文🍚', '\t\n\r\b\f', '\u001b', '\\"', 'x\t\u001b中文']) {
    const bytes = Buffer.byteLength(JSON.stringify(content));
    assert.equal(fitsTextPreviewResponse(content, bytes), true);
    assert.equal(fitsTextPreviewResponse(content, bytes - 1), false);
  }
});
