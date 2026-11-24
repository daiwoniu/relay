import { MenuIcon } from './MenuIcon';
import PageHostingIcon from './PageHostingIcon';

export default function UserMenuIcon({ type }: { type: 'share' | 'trash' | 'accounts' | 'pages' | 'analytics' | 'feishu' | 'server' | 'logout' | 'engines' | 'admin' | 'settings' }) {
  if (type === 'pages') return <PageHostingIcon />;
  if (type === 'share' || type === 'trash') return <MenuIcon type={type} size={18} />;
  if (type === 'feishu') return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="3.25" y="5.5" width="11.5" height="8.75" rx="2.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 3v2.5M1.75 9v2m14.5-2v2M7 9.75h.01m3.99 0h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
  if (type === 'analytics') return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2.5 2.5v13h13M6 12V8m4 4V4m4 8V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  if (type === 'accounts' || type === 'engines' || type === 'admin' || type === 'settings') return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === 'accounts' && <><circle cx="6.4" cy="5.8" r="2.2" /><path d="M2.3 14c.3-2.4 1.8-3.7 4.1-3.7s3.8 1.3 4.1 3.7m1.4-10a2.2 2.2 0 0 1 0 4.3m.6 2c1.8.3 2.9 1.5 3.2 3.7" /></>}
    {type === 'engines' && <><rect x="4.5" y="4.5" width="9" height="9" rx="1.5" /><rect x="7" y="7" width="4" height="4" rx=".5" /><path d="M7 2.5v2m4-2v2m-4 9v2m4-2v2m-8.5-8h2m-2 3h2m9-3h2m-2 3h2" /></>}
    {type === 'admin' && <path d="M9 2.6 14.7 5v3.8c0 3.1-2.2 5.1-5.7 6.6-3.5-1.5-5.7-3.5-5.7-6.6V5L9 2.6Zm-2.2 6.3 1.5 1.5 2.9-2.9" />}
    {type === 'settings' && <><path d="M7.5 2.5h3l.5 1.7 1.5.9 1.7-.4 1.5 2.6-1.3 1.2v1.8l1.3 1.2-1.5 2.6-1.7-.4-1.5.9-.5 1.7h-3L7 14.6l-1.5-.9-1.7.4-1.5-2.6 1.3-1.2V8.5L2.3 7.3l1.5-2.6 1.7.4L7 4.2Z" /><circle cx="9" cy="9.4" r="2" /></>}
  </svg>;
  if (type === 'server') return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="3" y="3" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4"/><rect x="3" y="10.5" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4"/><path d="M5.5 5.25h.01M8 5.25h4.5M5.5 12.75h.01M8 12.75h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M7.5 3.5H4.8A1.3 1.3 0 0 0 3.5 4.8v8.4a1.3 1.3 0 0 0 1.3 1.3h2.7M11 6l3 3-3 3M14 9H7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
