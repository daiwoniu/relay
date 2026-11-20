/** Break explanatory prose without splitting ordinary periods or existing lines. */
export function formatHelpText(content: string): string {
  return content.replace(/([。；;])[ \t]*(?=\S)/g, '$1\n');
}
