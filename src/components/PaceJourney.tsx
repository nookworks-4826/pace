/** Small code-native illustration: a clear route, a checkpoint and a destination. */
export function PaceJourney() {
  return (
    <svg
      className="pace-journey"
      viewBox="0 0 280 148"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="211" cy="48" r="34" fill="var(--journey-sun, #ffdb67)" />
      <path
        d="M22 118h63c28 0 18-63 58-63h89"
        stroke="var(--line-strong)"
        strokeWidth="13"
        strokeLinecap="round"
      />
      <path
        className="journey-path"
        d="M22 118h63c28 0 18-63 58-63h89"
        stroke="var(--accent)"
        strokeWidth="4"
        strokeLinecap="round"
        pathLength="1"
      />
      <rect
        x="31"
        y="43"
        width="53"
        height="43"
        rx="12"
        fill="var(--surface)"
        stroke="var(--line-strong)"
        strokeWidth="2"
      />
      <path
        d="m47 65 7 7 15-17"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        className="journey-marker"
        cx="232"
        cy="55"
        r="8"
        fill="var(--accent)"
        stroke="var(--surface)"
        strokeWidth="4"
      />
      <path
        d="M172 111h13m-6-6v12"
        stroke="var(--muted)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
