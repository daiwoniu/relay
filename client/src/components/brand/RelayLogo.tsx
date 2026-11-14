interface RelayLogoProps {
  className?: string;
}

export default function RelayLogo({ className = '' }: RelayLogoProps) {
  return (
    <svg
      viewBox="2.5 1.5 27 29"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M17.5 6.5C10.8 3.2 5 7.5 5 16S10.8 28.8 17.5 25.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M14.5 6.5C21.2 3.2 27 7.5 27 16S21.2 28.8 14.5 25.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M14.5 10.5H17.5M14.5 21.5H17.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
