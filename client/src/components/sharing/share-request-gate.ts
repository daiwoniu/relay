/** A closed or replaced draft must never receive an earlier request's UI result. */
export function createShareRequestGate() {
  let context: unknown;
  let revision = 0;
  return {
    synchronize(next: unknown) { if (next !== context) { context = next; revision += 1; } },
    invalidate() { revision += 1; },
    begin() {
      const request = ++revision;
      return () => request === revision && context !== null;
    },
  };
}
