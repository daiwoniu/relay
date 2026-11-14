import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendNarrativeDelta,
  buildProcessTimelineFromTurnItems,
  insertOperationReference,
  removeNarrativeItem,
  takeFinalAnswerFromTimeline,
  type ProcessTimelineEntry,
} from './process-timeline.js';

test('split last final narrative from interleaved timeline', () => {
  const timeline = buildProcessTimelineFromTurnItems([
    { id: 'mid', type: 'agentMessage', text: 'mid-answer' },
    { id: 'command-a', type: 'commandExecution' },
    { id: 'final', type: 'agentMessage', text: 'final-answer' },
  ]);
  assert.deepEqual(takeFinalAnswerFromTimeline(timeline, 'final'), {
    processTimeline: [
      { type: 'narrative', itemId: 'mid', content: 'mid-answer' },
      { type: 'operation', itemId: 'command-a' },
    ],
    finalContent: 'final-answer',
    processContent: 'mid-answer',
  });
});
