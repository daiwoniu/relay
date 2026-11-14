const KEYBOARD_HEIGHT_DELTA = 120;

export interface LoginViewportState {
  width: number;
  maxHeight: number;
  keyboardOpen: boolean;
}

export function createLoginViewportState(width: number, height: number): LoginViewportState {
  return { width, maxHeight: height, keyboardOpen: false };
}

export function updateLoginViewportState(
  previous: LoginViewportState,
  width: number,
  height: number,
): { state: LoginViewportState; shouldResetScroll: boolean } {
  if (Math.abs(width - previous.width) > 1) {
    return {
      state: createLoginViewportState(width, height),
      shouldResetScroll: false,
    };
  }

  const maxHeight = Math.max(previous.maxHeight, height);
  const keyboardOpen = maxHeight - height >= KEYBOARD_HEIGHT_DELTA;
  return {
    state: { width, maxHeight, keyboardOpen },
    shouldResetScroll: previous.keyboardOpen && !keyboardOpen,
  };
}
