import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupDiagnostics } from './startup-diagnostics.js';

function fixture() {
  let wall = 0;
  let cpu = 0;
  const entries: Array<Record<string, string | number>> = [];
  const trace = createStartupDiagnostics({ now: () => wall, cpu: () => cpu,
    write: (line) => entries.push(JSON.parse(line.slice('[Relay:Startup] '.length))) });
  return { trace, entries, advance: (ms: number, cpuMs = 0) => { wall += ms; cpu += cpuMs; } };
}

test('startup span begins before work and distinguishes wall time from CPU time', () => {
  const { trace, entries, advance } = fixture();
  trace.start();
  trace.stage('database-init');
  trace.measureSync('database-save', () => {
    assert.equal(entries.at(-1)?.event, 'begin');
    advance(900, 70);
  });
  trace.stage('http-listen-wait');
  assert.deepEqual(entries.find((entry) => entry.stage === 'database-save' && entry.event === 'end'), {
    stage: 'database-save', event: 'end', wallMs: 900, cpuMs: 70, elapsedMs: 900,
  });
});

for (const first of ['http-listen', 'bootstrap'] as const) {
  test(`startup completes only after both gates, ${first} first`, () => {
    const { trace, entries } = fixture();
    trace.start();
    trace.stage('initializing');
    trace.ready(first);
    trace.ready(first);
    assert.equal(entries.some((entry) => entry.event === 'complete'), false);
    trace.ready(first === 'http-listen' ? 'bootstrap' : 'http-listen');
    const count = entries.length;
    trace.stage('ignored');
    trace.ready('bootstrap');
    assert.equal(trace.measureSync('not-startup', () => 42), 42);
    assert.equal(entries.length, count);
    assert.equal(entries.filter((entry) => entry.event === 'complete').length, 1);
  });
}

test('diagnostics preserve the original exception and do not log its contents', () => {
  const { trace, entries } = fixture();
  trace.start();
  const error = new Error('private data');
  assert.throws(() => trace.measureSync('database-write', () => { throw error; }), (actual) => actual === error);
  assert.equal(entries.at(-1)?.event, 'end');
  assert.equal(JSON.stringify(entries).includes('private data'), false);
});

test('a broken diagnostic writer cannot prevent work or completion', () => {
  const trace = createStartupDiagnostics({ write: () => { throw new Error('log unavailable'); } });
  assert.equal(trace.measureSync('inactive', () => 1), 1);
  trace.start();
  trace.stage('initializing');
  assert.equal(trace.measureSync('save', () => 2), 2);
  trace.ready('bootstrap');
  trace.ready('http-listen');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('background recovery retains database spans after bootstrap without recording unrelated work', async () => {
  const { trace, entries, advance } = fixture();
  const gate = deferred();
  const later = deferred();
  let descendant: Promise<void> | undefined;
  trace.start();
  trace.stage('active-session-recovery');
  const recovery = trace.measureAsync('session-followup-recovery', async () => {
    await gate.promise;
    trace.measureSync('database-save', () => advance(500, 30));
    descendant = (async () => {
      await later.promise;
      trace.measureSync('after-recovery', () => undefined);
    })();
    return 42;
  });
  trace.stage('http-listen-wait');
  trace.ready('bootstrap');
  trace.ready('http-listen');
  assert.equal(entries.at(-1)?.event, 'complete');
  trace.measureSync('unrelated-request-save', () => undefined);
  gate.resolve();
  assert.equal(await recovery, 42);
  const save = entries.find((entry) => entry.stage === 'database-save' && entry.event === 'end');
  assert.equal(save?.parentStage, 'session-followup-recovery');
  assert.equal(save?.wallMs, 500);
  assert.equal(save?.cpuMs, 30);
  assert.equal(entries.at(-1)?.stage, 'session-followup-recovery');
  assert.equal(entries.at(-1)?.event, 'end');
  const count = entries.length;
  later.resolve();
  await descendant;
  trace.measureSync('normal-save', () => undefined);
  assert.equal(entries.length, count);
  assert.equal(entries.some((entry) => entry.stage === 'unrelated-request-save'), false);
});

test('overlapping background tasks retain independent diagnostic scopes', async () => {
  const { trace, entries } = fixture();
  const firstGate = deferred();
  const secondGate = deferred();
  trace.start();
  const first = trace.measureAsync('first-recovery', async () => {
    await firstGate.promise;
    trace.measureSync('first-save', () => undefined);
  });
  const second = trace.measureAsync('second-recovery', async () => {
    await secondGate.promise;
    trace.measureSync('second-save', () => undefined);
  });
  trace.ready('http-listen');
  trace.ready('bootstrap');
  firstGate.resolve();
  await first;
  secondGate.resolve();
  await second;
  assert.equal(entries.find((entry) => entry.stage === 'first-save')?.parentStage, 'first-recovery');
  assert.equal(entries.find((entry) => entry.stage === 'second-save')?.parentStage, 'second-recovery');
});

test('async spans end on rejection and preserve synchronous and asynchronous errors', async () => {
  const { trace, entries } = fixture();
  trace.start();
  const error = new Error('private data');
  assert.throws(() => trace.measureAsync('sync-failure', () => { throw error; }), (actual) => actual === error);
  await assert.rejects(trace.measureAsync('async-failure', async () => { throw error; }), (actual) => actual === error);
  for (const stage of ['sync-failure', 'async-failure']) {
    assert.deepEqual(entries.filter((entry) => entry.stage === stage).map((entry) => entry.event), ['begin', 'end']);
  }
  trace.ready('bootstrap');
  trace.ready('http-listen');
  const count = entries.length;
  assert.equal(await trace.measureAsync('inactive', async () => 7), 7);
  assert.equal(entries.length, count);
  assert.equal(JSON.stringify(entries).includes('private data'), false);
});
