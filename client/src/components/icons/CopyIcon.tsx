export default function CopyIcon({ copied = false, size = 14 }: { copied?: boolean; size?: number }) {
  if (copied) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="8" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 11V4a1 1 0 011-1h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
