export const SIDEBAR_DESKTOP_BREAKPOINT = 1024;

export function isDesktopSidebarViewport(width: number): boolean {
  return width >= SIDEBAR_DESKTOP_BREAKPOINT;
}

export function resolveSidebarOpenAfterViewportChange(
  previousDesktop: boolean,
  nextDesktop: boolean,
  currentOpen: boolean,
): boolean {
  return previousDesktop === nextDesktop ? currentOpen : nextDesktop;
}
