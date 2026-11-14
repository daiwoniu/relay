import type { RuntimeTurnItem, SessionRuntime } from '../engine/runtime.js';

const detailsOf = (item: RuntimeTurnItem) => {
  const source = item.details ?? item.raw;
  return source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : item;
};
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Recovery may update content/status, but cannot erase already observed server timing. */
export function preserveProcessTiming(runtime: Pick<SessionRuntime, 'engine' | 'turnItems'>, item: RuntimeTurnItem): RuntimeTurnItem {
  if (runtime.engine !== 'codex') return item;
  const previous = runtime.turnItems.find(value => value.id === item.id);
  if (!previous) return item;
  const old = detailsOf(previous);
  const timing = Object.fromEntries(['firstObservedAt', 'startedObservedAt', 'completedObservedAt'].filter(key => timestamp(old[key])).map(key => [key, old[key]]));
  return Object.keys(timing).length ? { ...item, details: { ...detailsOf(item), ...timing } } : item;
}

/** Server observation times, never inferred engine execution times or replay arrival times. */
export function recordProcessTiming(runtime: Pick<SessionRuntime, 'engine' | 'turnItems'>, item: RuntimeTurnItem, observedAt: number, phase: 'start' | 'complete' | 'instant'): RuntimeTurnItem {
  if (runtime.engine !== 'codex' || !timestamp(observedAt)) return item;
  const previous = runtime.turnItems.find(value => value.id === item.id);
  const old = previous ? detailsOf(previous) : {};
  const details = { ...detailsOf(item) };
  details.firstObservedAt = timestamp(old.firstObservedAt) ? old.firstObservedAt : observedAt;
  delete details.startedObservedAt; delete details.completedObservedAt;
  if (timestamp(old.startedObservedAt)) details.startedObservedAt = old.startedObservedAt;
  else if (phase === 'start' && !timestamp(old.completedObservedAt)) details.startedObservedAt = observedAt;
  if (timestamp(old.completedObservedAt)) details.completedObservedAt = old.completedObservedAt;
  else if (phase !== 'start') details.completedObservedAt = observedAt;
  return { ...item, details };
}
