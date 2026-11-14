export const MAX_PREVIEW_LINE_NUMBERS = 100_000;
export const MAX_HIGHLIGHTED_PREVIEW_BYTES = 512 * 1024;

export function isLargeCodePreview(contentSize: number | undefined): boolean {
  return contentSize !== undefined && contentSize >= MAX_HIGHLIGHTED_PREVIEW_BYTES;
}

export function shouldUseHtmlVisualization(
  contentSize: number | undefined,
  mode: 'source' | 'visualization' | undefined,
): boolean {
  return mode === 'visualization' && !isLargeCodePreview(contentSize);
}

function longestCharacterRun(content: string, target: string): number {
  let longest = 0;
  let current = 0;
  for (const character of content) {
    if (character === target) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

export function buildCodePreviewMarkdown(content: string, language: string): string {
  const backtickLength = Math.max(3, longestCharacterRun(content, '`') + 1);
  const tildeLength = Math.max(3, longestCharacterRun(content, '~') + 1);
  const fenceCharacter = backtickLength <= tildeLength ? '`' : '~';
  const fence = fenceCharacter.repeat(fenceCharacter === '`' ? backtickLength : tildeLength);
  const safeLanguage = /^[a-z0-9_+-]+$/i.test(language) ? language : 'plaintext';
  const closingSeparator = content.endsWith('\n') || content.endsWith('\r') ? '' : '\n';
  return `${fence}${safeLanguage}\n${content}${closingSeparator}${fence}`;
}

export function buildPreviewLineNumbers(content: string): string | null {
  let lineCount = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      lineCount += 1;
    } else if (content[index] === '\r') {
      lineCount += 1;
      if (content[index + 1] === '\n') index += 1;
    }
    if (lineCount > MAX_PREVIEW_LINE_NUMBERS) return null;
  }
  return Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n');
}
