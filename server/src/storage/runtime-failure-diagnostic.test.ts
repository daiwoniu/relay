import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRuntimeFailure } from './runtime-failure-diagnostic.js';
test('runtime diagnostics retain controlled cause and hashed correlation without private error text',()=>{
  const value=formatRuntimeFailure({sessionId:'private-session',attemptId:'private-attempt',connectionId:'private-connection',stage:'event',code:'RUNTIME_EVENT_OVERLOADED',eventType:'delta',pending:256,bytes:100});
  const parsed=JSON.parse(value);assert.equal(parsed.code,'RUNTIME_EVENT_OVERLOADED');assert.equal(parsed.pending,256);
  assert.match(parsed.session,/^[0-9a-f]{12}$/);assert.ok(!value.includes('private'));
  const invalid=JSON.parse(formatRuntimeFailure({sessionId:'s',attemptId:'a',connectionId:'c',stage:'secret/path',code:'secret token',pending:NaN,bytes:-1}));
  assert.equal(invalid.stage,'UNCLASSIFIED');assert.equal(invalid.code,'UNCLASSIFIED');assert.equal(invalid.pending,0);assert.equal(invalid.bytes,0);
});
