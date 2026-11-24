export function getVisualLineCount(
  scrollHeight: number,
  lineHeight: number,
  paddingTop: number,
  paddingBottom: number,
): number {
  const normalizedLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
  const textHeight = scrollHeight - Math.max(0, paddingTop) - Math.max(0, paddingBottom);
  return Math.max(1, Math.ceil((textHeight - 1) / normalizedLineHeight));
}
