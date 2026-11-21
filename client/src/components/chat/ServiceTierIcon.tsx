export default function ServiceTierIcon({ tier }: { tier: string }) {
  if (tier === 'default') return null;
  return <svg className="model-settings-tier-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
    {tier === 'ultrafast' ? <>
      <path d="M12 2 2 14h6l-1 8L17 10h-6l1-8Z" opacity=".65" />
      <path d="M18 3 8 15h6l-1 8L23 11h-6l1-8Z" stroke="var(--color-overlay-surface)" strokeWidth="1.25" strokeLinejoin="round" />
    </> : <path d="M14 2 4 14h6l-1 8L20 10h-7l1-8Z" />}
  </svg>;
}
