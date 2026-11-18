// Count a visit once it lasts long enough; cancelling a brief visit leaves no record.
export const TOOL_USE_MIN_MS = 5000;
export function scheduleToolUse(record: () => void) {
  const timer = setTimeout(record, TOOL_USE_MIN_MS);
  return () => clearTimeout(timer);
}
