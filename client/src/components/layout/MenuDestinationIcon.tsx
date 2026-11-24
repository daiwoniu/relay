export default function MenuDestinationIcon({ external = false }: { external?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]">
    {external ? <path d="M9 3h4v4m0-4L7 9m0-5H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9" /> : <path d="m6 4 4 4-4 4" />}
  </svg>;
}
