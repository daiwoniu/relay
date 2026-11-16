import CopyIcon from './CopyIcon';

export function MenuIcon({ type, pinned = false, size = 14 }: {
  type: 'plus' | 'pin' | 'info' | 'copy' | 'edit' | 'fork' | 'unarchive' | 'share' | 'select' | 'files' | 'trash' | 'source' | 'render' | 'members' | 'shield';
  pinned?: boolean;
  size?: number;
}) {
  if (type === 'copy') return <CopyIcon size={size} />;
  const icons = {
    plus: <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
    pin: pinned
      ? <path d="M9.5 1.5v3.5l3 4v2.5H3.5V9l3-4V1.5h3zM7.5 11v4" fill="currentColor" />
      : <><path d="M9.5 1.5v3.5l3 4v2.5H3.5V9l3-4V1.5h3z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M7.5 11v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>,
    info: <><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7v4M8 4.8v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>,
    edit: <path d="M2 12l2-1 7-7-1-1-7 7-1 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
    fork: <><path d="M4 3v3.5A2.5 2.5 0 006.5 9H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M9 6l3 3-3 3M4 6.5V13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></>,
    unarchive: <><path d="M3 5h10v8H3V5zM2.5 3h11v2h-11V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M8 11V7.5M6.5 9L8 7.5 9.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></>,
    share: <path d="M6 4.5L8 2l2 2.5M8 2v8M3 7v6h10V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />,
    select: <><rect x="2.5" y="2.5" width="4" height="4" rx=".7" stroke="currentColor" strokeWidth="1.2" /><rect x="9.5" y="2.5" width="4" height="4" rx=".7" stroke="currentColor" strokeWidth="1.2" /><rect x="2.5" y="9.5" width="4" height="4" rx=".7" stroke="currentColor" strokeWidth="1.2" /><path d="M10 11.5l1 1 2-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></>,
    files: <><path d="M2.5 4h4l1.4 1.5h5.6V13h-11V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M2.5 6h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>,
    trash: <><path d="M4 5h8l-.7 8.5a1 1 0 01-1 .5H5.7a1 1 0 01-1-.5L4 5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M3 5h10M6.5 3h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
    source: <path d="M5 4L1 8l4 4M11 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
    render: <path d="M2 4l4 4-4 4M8 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
    members: <><circle cx="6" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.3" /><path d="M1.5 13c.3-3 1.8-4.5 4.5-4.5s4.2 1.5 4.5 4.5M10.5 3a2.2 2.2 0 0 1 0 4.4M12 9c1.5.5 2.3 1.8 2.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>,
    shield: <><path d="M8 1.5 13.5 4v4c0 3-2.5 5.1-5.5 6.5C5 13.1 2.5 11 2.5 8V4L8 1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="m5.5 8 1.7 1.7 3.3-3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">{icons[type]}</svg>;
}
