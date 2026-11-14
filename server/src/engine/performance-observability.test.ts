import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEnginePerformanceObservation,
  ENGINE_PERFORMANCE_LOG_PREFIX,
} from './performance-observability.js';

test('collector emits one white-listed duration record at terminal', () => {
  const lines: string[] = [];
  const observation = createEnginePerformanceObservation({
    engine: 'codex',
    existingSession: true,
    connectionReused: false,
    recovery: false,
    startedAt: 100,
    write: (line) => lines.push(line),
  });

  observation.mark('connection_started', 110);
  observation.mark('transport_opened', 130);
  observation.mark('protocol_initialized', 170);
  observation.mark('configuration_ready', 190);
  observation.mark('external_session_ready', 250);
  observation.mark('provider_request_sent', 260);
  observation.mark('provider_turn_started', 300);
  observation.mark('first_engine_output', 410);
  observation.finish('completed', 600);
  observation.close();
  observation.close();

  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(ENGINE_PERFORMANCE_LOG_PREFIX));
  assert.deepEqual(JSON.parse(lines[0].slice(ENGINE_PERFORMANCE_LOG_PREFIX.length)), {
    engine: 'codex',
    existingSession: true,
    connectionReused: false,
    recovery: false,
    outcome: 'completed',
    connectionMs: 20,
    initializeMs: 40,
    configurationMs: 20,
    sessionReadyMs: 60,
    requestSendMs: 10,
    turnStartMs: 40,
    firstOutputMs: 150,
    terminalMs: 340,
    totalMs: 500,
  });
});

test('collector marks recovery and never logs unsupported failure or close fields', () => {
  const lines: string[] = [];
  const observation = createEnginePerformanceObservation({
    engine: 'codebuddy',
    existingSession: false,
    connectionReused: false,
    recovery: true,
    startedAt: 1_000,
    write: (line) => lines.push(line),
  });

  observation.mark('connection_started', 1_010);
  observation.mark('transport_opened', 1_030);
  observation.mark('transport_opened', 9_999);
  observation.finish('failed', 1_080);
  observation.close();

  const record = JSON.parse(lines[0].slice(ENGINE_PERFORMANCE_LOG_PREFIX.length));
  assert.deepEqual(record, {
    engine: 'codebuddy',
    existingSession: false,
    connectionReused: false,
    recovery: true,
    outcome: 'failed',
    connectionMs: 20,
    totalMs: 80,
  });
  assert.deepEqual(Object.keys(record).sort(), [
    'connectionMs', 'connectionReused', 'engine', 'existingSession', 'outcome', 'recovery', 'totalMs',
  ]);
});

test('observer failures never escape into the engine runtime', () => {
  const observation = createEnginePerformanceObservation({
    engine: 'codex',
    existingSession: false,
    recovery: false,
    write: () => { throw new Error('log unavailable'); },
  });
  assert.doesNotThrow(() => {
    observation.finish('closed');
    observation.close();
  });
});
