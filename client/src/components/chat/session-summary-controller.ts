export interface SessionSummaryRequest {
  sessionId: string;
  generation: number;
  controller: AbortController;
}

export function replaceSessionSummaryRequest(
  current: SessionSummaryRequest | null,
  sessionId: string,
  generation: number,
): SessionSummaryRequest {
  current?.controller.abort();
  return { sessionId, generation, controller: new AbortController() };
}

export function isCurrentSessionSummaryRequest(
  request: SessionSummaryRequest,
  activeSessionId: string | null,
  latestGeneration: number,
): boolean {
  return !request.controller.signal.aborted
    && request.sessionId === activeSessionId
    && request.generation === latestGeneration;
}

export function disposeSessionSummaryRequest(request: SessionSummaryRequest | null): void {
  request?.controller.abort();
}
