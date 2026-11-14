import { toAsyncQuestionItem } from '../codex/async-questions.js';
import type { RuntimeTurnItem, SessionRuntime } from '../engine/runtime.js';
import { presentProcessItem } from '../messages/presenter.js';
import { insertOperationReference, removeNarrativeItem } from '../process-timeline.js';
import { broadcastFrontendEvent } from './frontend-client-hub.js';
import { upsertTurnItem } from './frontend-protocol.js';

export function appendAsyncQuestionItem(runtime: SessionRuntime, source: RuntimeTurnItem): void {
  if (runtime.engine !== 'codex') return;
  const question = toAsyncQuestionItem(source);
  if (!question) return;
  runtime.turnItems = upsertTurnItem(runtime.turnItems, question);
  runtime.processTimeline = insertOperationReference(removeNarrativeItem(runtime.processTimeline, source.id), question.id);
  const presented = presentProcessItem(question, 'in_progress');
  if (presented) broadcastFrontendEvent({ type: 'item_start', sessionId: runtime.sessionId, item: presented });
}
