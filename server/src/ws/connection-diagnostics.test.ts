import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionDiagnostics } from './connection-diagnostics.js';

test('connection events correlate close code, age and last inbound activity without peer content', () => {
  let clock = 0;
  const entries: Array<Record<string, unknown>> = [];
  const trace = createConnectionDiagnostics({ now: () => clock,
    write: (line) => entries.push(JSON.parse(line.slice('[Relay:FrontendConnection] '.length))) });
  clock = 100;
  trace.message();
  clock = 22_100;
  trace.error();
  trace.close(1006, Buffer.from('secret peer reason'));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].event, 'open');
  assert.equal(entries[0].sinceLastMessageMs, null);
  assert.equal(entries[1].event, 'error');
  assert.equal(entries[2].connectionId, entries[0].connectionId);
  assert.equal(entries[2].code, 1006);
  assert.equal(entries[2].lifetimeMs, 22_100);
  assert.equal(entries[2].sinceLastMessageMs, 22_000);
  assert.equal(entries[2].receivedMessages, 1);
  assert.equal(entries[2].reasonBytes, 18);
  assert.ok(!JSON.stringify(entries).includes('secret'));
});

test('logging failures do not disrupt connection lifecycle', () => {
  const trace = createConnectionDiagnostics({ write: () => { throw Error('logger failed'); } });
  assert.doesNotThrow(() => { trace.message(); trace.error(); trace.close(1000, Buffer.alloc(0)); });
});
