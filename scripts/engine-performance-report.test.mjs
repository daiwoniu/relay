import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePerformanceLines, summarizePerformanceRecords } from './engine-performance-report.mjs';

test('parser ignores broken and invalid records and projects only white-listed fields', () => {
  const records = parsePerformanceLines([
    '[server] [Relay:EnginePerformance] {"engine":"codex","existingSession":true,"connectionReused":false,"recovery":false,"outcome":"completed","connectionMs":10,"secret":"nope"}',
    '[Relay:EnginePerformance] not-json',
    '[Relay:EnginePerformance] {"engine":"other","outcome":"completed"}',
    'ordinary log line',
  ]);
  assert.deepEqual(records, [{
    engine: 'codex', existingSession: true, connectionReused: false, recovery: false, outcome: 'completed', connectionMs: 10,
  }]);
});

test('summary groups engines and calculates nearest-rank percentiles', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    engine: index < 10 ? 'codex' : 'codebuddy',
    existingSession: index % 5 !== 0,
    connectionReused: index % 5 === 1,
    recovery: index % 5 === 2,
    outcome: index === 19 ? 'failed' : 'completed',
    connectionMs: index + 1,
  }));
  assert.deepEqual(summarizePerformanceRecords(records), [
    { engine: 'codex', count: 10, successCount: 10, successRate: 100, decisionSamples: 4, newSessions: 2, recoverySamples: 2, reusedConnections: 2, metrics: { connectionMs: { count: 4, p50: 5, p95: 10, max: 10 } } },
    { engine: 'codebuddy', count: 10, successCount: 9, successRate: 90, decisionSamples: 3, newSessions: 2, recoverySamples: 2, reusedConnections: 2, metrics: { connectionMs: { count: 3, p50: 15, p95: 19, max: 19 } } },
  ]);
});
