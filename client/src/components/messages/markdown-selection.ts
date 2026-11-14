type SelectionRange = Pick<Range, 'intersectsNode'>;

type TextSelection = Pick<Selection, 'isCollapsed' | 'rangeCount'> & {
  getRangeAt(index: number): SelectionRange;
};

export function hasExpandedSelectionWithin(
  element: Node,
  selection: TextSelection | null = typeof window === 'undefined' ? null : window.getSelection(),
): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(element)) return true;
    } catch {
      // 节点已脱离 DOM 时按普通点击处理。
    }
  }
  return false;
}
