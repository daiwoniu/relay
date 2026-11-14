export function canAcknowledgeSessionResult(visible: boolean, focused: boolean, intersecting: boolean): boolean {
  return visible && focused && intersecting;
}
