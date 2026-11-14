export function formatGitDiffHunkHeader(line: string, newFile: boolean): string {
  const range = (start: string, count = '1') => count === '0'
    ? '无对应行'
    : `第 ${start}${count === '1' ? '' : `–${+start + +count - 1}`} 行`;
  return line.replace(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/, (
    _, beforeStart: string, beforeCount: string | undefined, afterStart: string, afterCount: string | undefined,
  ) => newFile && beforeCount === '0'
    ? `新增文件 · ${range(afterStart, afterCount)}`
    : `变更前${range(beforeStart, beforeCount)} → 变更后${range(afterStart, afterCount)}`);
}
