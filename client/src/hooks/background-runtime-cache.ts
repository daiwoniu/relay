import type { ProcessItemDto, SessionStatus } from '../generated/relay-contracts.ts';
import { appendNarrativeDelta, insertOperationReference } from '../stores/process-timeline.ts';
import { isProcessTimelineOperationType } from '../stores/process-timeline.ts';
import {
  projectRuntimeSnapshot,
  shouldPresentRuntimeSnapshot,
  type RuntimeSnapshotInput,
  type RuntimeSnapshotProjection,
} from './runtime-snapshot-policy.ts';

export const MAX_CACHED_RUNTIME_CHARS = 1_000_000;
const MAX_CACHED_PROCESS_STEPS = 256;

export type CachedRuntimeSnapshot = RuntimeSnapshotProjection;

export interface RuntimeCacheApplyResult {
  snapshot: CachedRuntimeSnapshot;
  shouldPresent: boolean;
}

function emptySnapshot(sessionId: string): CachedRuntimeSnapshot {
  return {
    sessionId,
    startTime: null,
    waitingStage: 'submitted',
    isStreaming: true,
    isStopping: false,
    currentContent: '',
    processContent: '',
    processSteps: [],
    processTimeline: [],
  };
}

function encodedStringContentLength(value: string): number {
  return JSON.stringify(value).length - 2;
}

function serializedSizeDelta(previous: unknown, next: unknown): number {
  return JSON.stringify(next).length - JSON.stringify(previous).length;
}

export class BackgroundRuntimeCache {
  private readonly snapshots = new Map<string, CachedRuntimeSnapshot>();
  private readonly snapshotSizes = new Map<string, number>();
  private readonly overflown = new Set<string>();

  get(sessionId: string): CachedRuntimeSnapshot | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  applyRuntimeSync(input: RuntimeSnapshotInput, sessionStatus?: SessionStatus | null): RuntimeCacheApplyResult {
    const snapshot = projectRuntimeSnapshot(input, sessionStatus);
    const shouldPresent = shouldPresentRuntimeSnapshot(input);
    if (shouldPresent) this.storeWithinLimits(snapshot);
    else this.delete(input.sessionId);
    return { snapshot, shouldPresent };
  }

  appendDelta(sessionId: string, content: string, phase?: string, itemId?: string, observedAt?: number): CachedRuntimeSnapshot {
    if (this.overflown.has(sessionId)) return emptySnapshot(sessionId);
    const current = this.snapshots.get(sessionId) ?? emptySnapshot(sessionId);
    const isNarrativePhase = phase === 'commentary' || phase === 'final_answer';
    let sizeDelta = encodedStringContentLength(content);
    if (isNarrativePhase && itemId) {
      const narrativeExists = current.processTimeline.some(
        (entry) => entry.type === 'narrative' && entry.itemId === itemId,
      );
      if (narrativeExists) {
        sizeDelta += encodedStringContentLength(content);
      } else {
        sizeDelta += JSON.stringify(appendNarrativeDelta([], itemId, content, observedAt)[0]).length
          + (current.processTimeline.length > 0 ? 1 : 0);
      }
    }
    const snapshot = isNarrativePhase
      ? {
          ...current,
          processContent: current.processContent + content,
          processTimeline: itemId
            ? appendNarrativeDelta(current.processTimeline, itemId, content, observedAt)
            : current.processTimeline,
        }
      : { ...current, currentContent: current.currentContent + content };
    this.storeIncremental(snapshot, current, sizeDelta);
    return snapshot;
  }

  upsertProcessStep(sessionId: string, item: ProcessItemDto): CachedRuntimeSnapshot {
    if (this.overflown.has(sessionId)) return emptySnapshot(sessionId);
    const current = this.snapshots.get(sessionId) ?? emptySnapshot(sessionId);
    const index = current.processSteps.findIndex((candidate) => candidate.id === item.id);
    let sizeDelta = JSON.stringify(item).length;
    const processSteps = [...current.processSteps];
    if (index >= 0) {
      sizeDelta -= JSON.stringify(current.processSteps[index]).length;
      processSteps[index] = item;
    } else {
      if (processSteps.length > 0) sizeDelta += 1;
      processSteps.push(item);
    }
    const addsTimelineReference = isProcessTimelineOperationType(item.type)
      && !current.processTimeline.some((entry) => entry.type === 'operation' && entry.itemId === item.id);
    if (addsTimelineReference) {
      sizeDelta += JSON.stringify({ type: 'operation', itemId: item.id }).length
        + (current.processTimeline.length > 0 ? 1 : 0);
    }
    const snapshot = {
      ...current,
      processSteps,
      processTimeline: isProcessTimelineOperationType(item.type)
        ? insertOperationReference(current.processTimeline, item.id)
        : current.processTimeline,
    };
    this.storeIncremental(snapshot, current, sizeDelta);
    return snapshot;
  }

  markForwarded(sessionId: string): CachedRuntimeSnapshot {
    if (this.overflown.has(sessionId)) return emptySnapshot(sessionId);
    const current = this.snapshots.get(sessionId) ?? emptySnapshot(sessionId);
    const snapshot = { ...current, waitingStage: 'forwarded' as const };
    this.storeIncremental(
      snapshot,
      current,
      serializedSizeDelta(current.waitingStage, snapshot.waitingStage),
    );
    return snapshot;
  }

  startStreaming(sessionId: string): CachedRuntimeSnapshot {
    if (this.overflown.has(sessionId)) return emptySnapshot(sessionId);
    const current = this.snapshots.get(sessionId) ?? emptySnapshot(sessionId);
    const snapshot = { ...current, waitingStage: 'started' as const, isStreaming: true, isStopping: false };
    this.storeIncremental(
      snapshot,
      current,
      serializedSizeDelta(current.waitingStage, snapshot.waitingStage)
        + serializedSizeDelta(current.isStreaming, snapshot.isStreaming)
        + serializedSizeDelta(current.isStopping, snapshot.isStopping),
    );
    return snapshot;
  }

  startStopping(sessionId: string): CachedRuntimeSnapshot {
    if (this.overflown.has(sessionId)) return emptySnapshot(sessionId);
    const current = this.snapshots.get(sessionId) ?? emptySnapshot(sessionId);
    const snapshot = { ...current, isStopping: true };
    this.storeIncremental(snapshot, current, serializedSizeDelta(current.isStopping, snapshot.isStopping));
    return snapshot;
  }

  delete(sessionId: string): void {
    this.snapshots.delete(sessionId);
    this.snapshotSizes.delete(sessionId);
    this.overflown.delete(sessionId);
  }

  clear(): void {
    this.snapshots.clear();
    this.snapshotSizes.clear();
    this.overflown.clear();
  }

  private storeWithinLimits(snapshot: CachedRuntimeSnapshot): boolean {
    const size = JSON.stringify(snapshot).length;
    const withinLimits = size <= MAX_CACHED_RUNTIME_CHARS
      && snapshot.processSteps.length <= MAX_CACHED_PROCESS_STEPS;
    if (withinLimits) {
      this.overflown.delete(snapshot.sessionId);
      this.snapshots.set(snapshot.sessionId, snapshot);
      this.snapshotSizes.set(snapshot.sessionId, size);
      return true;
    }
    this.snapshots.delete(snapshot.sessionId);
    this.snapshotSizes.delete(snapshot.sessionId);
    this.overflown.add(snapshot.sessionId);
    return false;
  }

  private storeIncremental(
    snapshot: CachedRuntimeSnapshot,
    previous: CachedRuntimeSnapshot,
    sizeDelta: number,
  ): boolean {
    const size = (this.snapshotSizes.get(snapshot.sessionId) ?? JSON.stringify(previous).length) + sizeDelta;
    const withinLimits = size <= MAX_CACHED_RUNTIME_CHARS
      && snapshot.processSteps.length <= MAX_CACHED_PROCESS_STEPS;
    if (withinLimits) {
      this.snapshots.set(snapshot.sessionId, snapshot);
      this.snapshotSizes.set(snapshot.sessionId, size);
      return true;
    }
    this.snapshots.delete(snapshot.sessionId);
    this.snapshotSizes.delete(snapshot.sessionId);
    this.overflown.add(snapshot.sessionId);
    return false;
  }
}
