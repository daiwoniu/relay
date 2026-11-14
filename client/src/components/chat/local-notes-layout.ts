export const LOCAL_NOTES_PANEL_MIN_WIDTH = 320;
export const LOCAL_NOTES_PANEL_MAX_WIDTH = 520;
export const LOCAL_NOTE_EDITOR_MAX_LINES = 8;
export const LOCAL_NOTE_EDITOR_LINE_HEIGHT = 24;

export function getLocalNoteEditorSize(scrollHeight: number, initialHeight?: number) {
  const maxHeight = LOCAL_NOTE_EDITOR_MAX_LINES * LOCAL_NOTE_EDITOR_LINE_HEIGHT;
  const requestedHeight = initialHeight ?? scrollHeight;
  return {
    height: Math.min(requestedHeight, maxHeight),
    scrollable: scrollHeight > Math.min(requestedHeight, maxHeight),
  };
}

export function getLocalNoteInitialEditorHeight(viewHeight: number) {
  return getLocalNoteEditorSize(viewHeight, viewHeight).height;
}

function getLineDisplayUnits(line: string) {
  return [...line].reduce((total, character) => {
    if (character === '\t') return total + 4;
    return total + (/^[\x00-\xff]$/.test(character) ? 1 : 2);
  }, 0);
}

export function getLocalNotesPanelWidth(contents: string[]) {
  const longestLineUnits = contents.reduce((longest, content) => {
    const contentLongest = content
      .split(/\r?\n/)
      .reduce((lineLongest, line) => Math.max(lineLongest, getLineDisplayUnits(line)), 0);
    return Math.max(longest, contentLongest);
  }, 0);
  const contentWidth = Math.ceil(longestLineUnits * 7 + 56);
  return Math.min(
    LOCAL_NOTES_PANEL_MAX_WIDTH,
    Math.max(LOCAL_NOTES_PANEL_MIN_WIDTH, contentWidth),
  );
}
