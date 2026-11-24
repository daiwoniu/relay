const paths = {
  corners: {
    expand: 'M6 2.5H2.5V6M10 2.5h3.5V6M2.5 10v3.5H6M13.5 10v3.5H10',
    collapse: 'M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5',
  },
  diagonal: {
    expand: 'M9.25 6.75 13.5 2.5M10 2.5h3.5V6M6.75 9.25 2.5 13.5M6 13.5H2.5V10',
    collapse: 'M13.5 2.5 9.25 6.75M9.25 3.5v3.25h3.25M2.5 13.5 6.75 9.25M3.5 9.25h3.25v3.25',
  },
};

export default function ExpandCornersIcon({ expanded, variant = 'corners' }: { expanded: boolean; variant?: keyof typeof paths }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-icon={expanded ? 'collapse-corners' : 'expand-corners'}>
      <path
        d={paths[variant][expanded ? 'collapse' : 'expand']}
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
