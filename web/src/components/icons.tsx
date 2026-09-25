import type { ReactNode } from 'react';

const svg = (d: ReactNode, box = 16) => (
  <svg viewBox={`0 0 ${box} ${box}`} width="15" height="15" fill="none" stroke="currentColor" strokeWidth={(1.3 * box) / 16} strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

/** Line icons in the step rows' style: 15px, 1.3 stroke, round caps. */
export const ICONS = {
  chevron: svg(<path d="M6 4l4 4-4 4" />),
  terminal: svg(<path d="M2.5 4.5l3.5 3.5-3.5 3.5M8 12h5.5" />),
  wrench: svg(<path d="M10.2 2.6a3.2 3.2 0 0 0-3.9 4.2L2.6 10.5a1.4 1.4 0 0 0 2 2l3.7-3.7a3.2 3.2 0 0 0 4.2-3.9l-2 2-1.6-.4-.4-1.6z" />),
  file: svg(<path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3h3" />),
  pencil: svg(<path d="M10.5 2.5l3 3-8 8H2.5v-3zM9 4l3 3" />),
  search: svg(
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2l3.3 3.3" />
    </>,
  ),
  globe: svg(
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6M8 2.2c1.6 1.7 2.4 3.6 2.4 5.8S9.6 12.1 8 13.8M8 2.2C6.4 3.9 5.6 5.8 5.6 8s.8 4.1 2.4 5.8" />
    </>,
  ),
  agent: svg(<path d="M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z" />),
  lock: svg(
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>,
  ),
  // Lucide's brain.
  brain: svg(
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18ZM15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4M17.599 6.5a3 3 0 0 0 .399-1.375M6.003 5.125A3 3 0 0 0 6.401 6.5M3.477 10.896a4 4 0 0 1 .585-.396M19.938 10.5a4 4 0 0 1 .585.396M6 18a4 4 0 0 1-1.967-.516M19.967 17.484A4 4 0 0 1 18 18" />,
    24,
  ),
  // A speech bubble with a line of text: reply in a side thread.
  thread: svg(<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM5 6.5h6M5 8.8h3.5" />),
  reply: svg(<path d="M3 3v4.5a2 2 0 0 0 2 2h8M10 6.5l3 3-3 3" />),
  hash: svg(<path d="M6.5 2.5l-1.5 11M11 2.5l-1.5 11M3 6h10.5M2.5 10H13" />),
  // Lucide's rotate-ccw and trash-2, on the 16 grid.
  reset: svg(<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.7M2.5 2.5v3.2h3.2" />),
  trash: svg(<path d="M2.5 4h11M6 4V2.8h4V4M4 4l.7 9.2h6.6L12 4M6.8 6.8v3.8M9.2 6.8v3.8" />),
  close: svg(<path d="M4 4l8 8M12 4l-8 8" />),
  arrow: svg(<path d="M5 11l6-6M6 5h5v5" />),
};
