export function splitTrashHighlight(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const parts: Array<{ text: string; match: boolean }> = [];
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const found = lower.indexOf(target, cursor);
    if (found < 0) break;
    if (found > cursor) parts.push({ text: text.slice(cursor, found), match: false });
    parts.push({ text: text.slice(found, found + needle.length), match: true });
    cursor = found + needle.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts.length ? parts : [{ text, match: false }];
}
