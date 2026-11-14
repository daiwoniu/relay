function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTitle(value: unknown): string | null {
  if (!isRecord(value) || typeof value.title !== 'string') return null;
  return value.title.trim() || null;
}

export function getToolCallTitle(input: unknown, fallback: string): string {
  const directTitle = readTitle(input);
  if (directTitle) return directTitle;

  if (typeof input === 'string') {
    try {
      const parsedTitle = readTitle(JSON.parse(input));
      if (parsedTitle) return parsedTitle;
    } catch {
      // 非 JSON 参数继续使用工具名兜底。
    }
  }

  return fallback;
}
