function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function shouldShowApprovalReason(reason: unknown, summary?: string): boolean {
  if (typeof reason !== 'string' || !reason.trim()) return false;
  if (!summary?.trim()) return true;
  const normalizedReason = normalizeComparableText(reason);
  const normalizedSummary = normalizeComparableText(summary);
  return normalizedSummary !== normalizedReason && !normalizedSummary.endsWith(normalizedReason);
}
