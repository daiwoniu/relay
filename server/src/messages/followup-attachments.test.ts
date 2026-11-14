import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { presentFollowupAttachments } from './followup-attachments.js';

test('followup display keeps images and files without publishing draft authorization fields', () => {
  const host = { id: randomUUID(), kind: 'host_file', name: 'notes.txt', path: 'D:/notes.txt', size: 12, accessToken: randomUUID() };
  const image = { id: randomUUID(), kind: 'uploaded_file', name: 'image.png', path: 'D:/uploads/image.png', size: 2048,
    mimeType: 'image/png', messageId: randomUUID(), projectId: randomUUID(), uploadId: randomUUID() };
  const result = presentFollowupAttachments(JSON.stringify([host, image]));
  assert.deepEqual(result, [
    { id: host.id, kind: 'host_file', name: host.name, path: host.path, size: host.size },
    { id: image.id, kind: 'uploaded_file', name: image.name, path: image.path, size: image.size, mimeType: image.mimeType, available: true },
  ]);
  assert.deepEqual(presentFollowupAttachments(JSON.stringify(result)), result);
  assert.deepEqual(presentFollowupAttachments('[]'), []);
  assert.equal(presentFollowupAttachments(JSON.stringify([{ ...result[1], available: false }]))[0].kind, 'uploaded_file');
  assert.deepEqual(presentFollowupAttachments(JSON.stringify([{ ...result[1], available: false }])), [{ ...result[1], available: false }]);
});
