import type { RegionLoadState } from '../../stores/region-load-state';

export type SidebarRegionPresentation = 'loading_empty' | 'loading_cached' | 'error_empty' | 'error_cached' | 'ready';

export function getSidebarRegionPresentation(
  state: RegionLoadState,
  hasContent: boolean,
): SidebarRegionPresentation {
  if (state.status === 'loading' || state.status === 'idle') return hasContent ? 'loading_cached' : 'loading_empty';
  if (state.status === 'error') return hasContent ? 'error_cached' : 'error_empty';
  return 'ready';
}
