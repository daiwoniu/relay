export function hasMultipleVisualLines(
  scrollHeight: number,
  lineHeight: number,
  paddingTop: number,
  paddingBottom: number,
): boolean {
  const normalizedLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
  const singleLineHeight = normalizedLineHeight + Math.max(0, paddingTop) + Math.max(0, paddingBottom);
  return scrollHeight > singleLineHeight + 1;
}
