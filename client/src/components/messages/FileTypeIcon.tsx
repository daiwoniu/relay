import type { ReactNode } from 'react';
import { getFileIconType } from './file-icon-type';

interface Props {
  filePath: string;
  size?: number;
  className?: string;
}

const ICON_PATHS: Record<ReturnType<typeof getFileIconType>, ReactNode> = {
  image: <><path d="M2.5 3h11v10h-11z"/><circle cx="6" cy="6.5" r="1"/><path d="M3.5 11l2.7-2.7 1.8 1.8 1.7-1.7 2.8 2.8"/></>,
  code: <><path d="M3 2.5h7l3 3v8H3zM10 2.5v3h3"/><path d="M6.3 8L4.8 9.5 6.3 11M9.7 8l1.5 1.5-1.5 1.5"/></>,
  markdown: <><path d="M3 2.5h7l3 3v8H3zM10 2.5v3h3"/><path d="M5 11V7.7l1.5 1.5L8 7.7V11M9.5 9.5h2M10.5 8.5v2"/></>,
  config: <><path d="M3 2.5h7l3 3v8H3zM10 2.5v3h3"/><path d="M5 8h6M5 10.5h6"/><circle cx="7" cy="8" r=".7" fill="currentColor" stroke="none"/><circle cx="9.5" cy="10.5" r=".7" fill="currentColor" stroke="none"/></>,
  archive: <><path d="M3 2.5h10v11H3zM3 5.5h10M6.5 2.5v3M9.5 2.5v3"/><path d="M6 9h4v2H6z"/></>,
  audio: <><path d="M4.5 3v8.2M11 2.5v7.2M4.5 4l6.5-1.5"/><circle cx="3.2" cy="11.5" r="1.3"/><circle cx="9.7" cy="10" r="1.3"/></>,
  video: <><rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M6.5 6l4 2.5-4 2.5z"/></>,
  table: <><path d="M2.5 3h11v10h-11zM2.5 6.5h11M2.5 10h11M6.2 3v10M10 3v10"/></>,
  document: <><path d="M3 2.5h7l3 3v8H3zM10 2.5v3h3"/><path d="M5 8h6M5 10h6M5 12h4"/></>,
  generic: <><path d="M3 2.5h7l3 3v8H3zM10 2.5v3h3"/></>,
};

export default function FileTypeIcon({ filePath, size = 16, className = '' }: Props) {
  const type = getFileIconType(filePath);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-file-icon={type}
      aria-hidden="true"
    >
      {ICON_PATHS[type]}
    </svg>
  );
}
