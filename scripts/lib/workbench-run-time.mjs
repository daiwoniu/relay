export function normalizeRunTimestamp(value) {
  if (!value) return null;
  // Older workspace runners wrote timestamps in China Standard Time without an offset.
  const normalized = value.trim().replace(' ', 'T')
    .replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/, '$1+08:00');
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) && Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

export function runTimestamp(value) {
  const normalized = normalizeRunTimestamp(value);
  return normalized ? Date.parse(normalized) : 0;
}

export function compareRunRecency(left, right) {
  const at = run => runTimestamp(run.startedAt) || runTimestamp(run.createdAt);
  return at(right) - at(left) || (left.runId ?? '').localeCompare(right.runId ?? '')
    || (left.taskId ?? '').localeCompare(right.taskId ?? '');
}
