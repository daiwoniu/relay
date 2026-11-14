export default function ToolboxIcon({ className }: { className?: string }) {
  return <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    <path d="M7 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <rect x="2.5" y="6" width="15" height="11" rx="2" />
    <path d="M2.5 10h6m3 0h6" />
    <rect x="8.5" y="9" width="3" height="3" rx=".5" />
  </svg>;
}
