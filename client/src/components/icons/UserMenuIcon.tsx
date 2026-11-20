import { MenuIcon } from './MenuIcon';
import PageHostingIcon from './PageHostingIcon';

export default function UserMenuIcon({ type }: { type: 'share' | 'trash' | 'accounts' | 'pages' | 'analytics' | 'server' | 'logout' }) {
  if (type === 'pages') return <PageHostingIcon />;
  if (type === 'share' || type === 'trash') return <MenuIcon type={type} size={18} />;
  if (type === 'analytics') return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2.5 2.5v13h13M6 12V8m4 4V4m4 8V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  if (type === 'accounts') return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="6.8" cy="5.7" r="2.2" stroke="currentColor" strokeWidth="1.4"/><path d="M2.8 13.7c.5-2.8 1.8-4.2 4-4.2 1.3 0 2.3.5 3 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><circle cx="13.3" cy="12.7" r="2.1" stroke="currentColor" strokeWidth="1.2"/><path d="M13.3 9.7v.9m0 4.2v.9m3-3h-.9m-4.2 0h-.9m5.1-2.1-.6.6m-3 3-.6.6m4.2 0-.6-.6m-3-3-.6-.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>;
  if (type === 'server') return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="3" y="3" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4"/><rect x="3" y="10.5" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4"/><path d="M5.5 5.25h.01M8 5.25h4.5M5.5 12.75h.01M8 12.75h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M7.5 3.5H4.8A1.3 1.3 0 0 0 3.5 4.8v8.4a1.3 1.3 0 0 0 1.3 1.3h2.7M11 6l3 3-3 3M14 9H7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
