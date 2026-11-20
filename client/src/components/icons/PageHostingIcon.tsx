export default function PageHostingIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="2" y="3" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M2 6h14M6 6v9" stroke="currentColor" strokeWidth="1.4" />
  </svg>;
}
