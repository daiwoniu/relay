interface RunTimes {
  startedAt?: string | null;
  createdAt?: string | null;
  runId?: string;
  taskId?: string | null;
}

export function normalizeRunTimestamp(value: string | null | undefined): string | null;
export function runTimestamp(value: string | null | undefined): number;
export function compareRunRecency(left: RunTimes, right: RunTimes): number;
