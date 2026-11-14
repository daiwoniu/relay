import { isDesktopSidebarViewport } from '../utils/sidebar-responsive.ts';

export type DeviceCategory = 'desktop' | 'mobile';

export function detectDeviceCategory(input: { viewportWidth?: number; userAgentDataMobile?: boolean; userAgent?: string } = {}): DeviceCategory {
  if (typeof input.viewportWidth === 'number' && Number.isFinite(input.viewportWidth) && input.viewportWidth > 0) {
    return isDesktopSidebarViewport(input.viewportWidth) ? 'desktop' : 'mobile';
  }
  if (typeof input.userAgentDataMobile === 'boolean') return input.userAgentDataMobile ? 'mobile' : 'desktop';
  const userAgent = input.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(userAgent) ? 'mobile' : 'desktop';
}

export function getCurrentDeviceCategory(): DeviceCategory {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return detectDeviceCategory({
    viewportWidth: typeof window === 'undefined' ? undefined : window.innerWidth,
    userAgentDataMobile: nav?.userAgentData?.mobile,
    userAgent: nav?.userAgent,
  });
}
