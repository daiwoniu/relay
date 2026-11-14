export function getRenderedMessageCopyText(contentElement: HTMLElement | null): string | null {
  if (!contentElement) return null;

  const excludedElements = Array.from(
    contentElement.querySelectorAll<HTMLElement>('[data-message-copy-exclude]'),
  );
  const previousHiddenStates = excludedElements.map((element) => element.hidden);

  try {
    excludedElements.forEach((element) => {
      element.hidden = true;
    });
    return contentElement.innerText;
  } finally {
    excludedElements.forEach((element, index) => {
      element.hidden = previousHiddenStates[index];
    });
  }
}
