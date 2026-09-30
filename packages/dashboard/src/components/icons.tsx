import type { SVGProps } from "react";

/**
 * A small line-icon set, inline so the dashboard adds no dependency for it. Every icon is
 * a 24-unit box, 1.75 stroke, currentColor — so it takes the colour of the text beside
 * it and never carries meaning on its own (the label does).
 */
type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...rest }: P) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    ...rest,
  };
}

export const Icon = {
  grid: (p: P) => (
    <svg {...base(p)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  check: (p: P) => (
    <svg {...base(p)}><path d="M20 6 9 17l-5-5" /></svg>
  ),
  clipboardCheck: (p: P) => (
    <svg {...base(p)}>
      <rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  ),
  user: (p: P) => (
    <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
  ),
  users: (p: P) => (
    <svg {...base(p)}>
      <circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9" r="3" /><path d="M15.5 14.5A5.5 5.5 0 0 1 22 20" />
    </svg>
  ),
  clock: (p: P) => (
    <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
  ),
  hourglass: (p: P) => (
    <svg {...base(p)}><path d="M6 3h12M6 21h12M7 3v3a5 5 0 0 0 10 0V3M7 21v-3a5 5 0 0 1 10 0v3" /></svg>
  ),
  pin: (p: P) => (
    <svg {...base(p)}><path d="M12 17v5M9 3h6l-1 6 3 3H7l3-3-1-6Z" /></svg>
  ),
  bell: (p: P) => (
    <svg {...base(p)}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" /></svg>
  ),
  barChart: (p: P) => (
    <svg {...base(p)}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
  ),
  scroll: (p: P) => (
    <svg {...base(p)}>
      <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" /><path d="M19 17V5a2 2 0 0 0-2-2H4M12 8h6M12 12h6" />
    </svg>
  ),
  search: (p: P) => (
    <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
  ),
  sparkle: (p: P) => (
    <svg {...base(p)}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M12 8l1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5Z" /></svg>
  ),
  folder: (p: P) => (
    <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
  ),
  alert: (p: P) => (
    <svg {...base(p)}><path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" /></svg>
  ),
  alertCircle: (p: P) => (
    <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
  ),
  checkCircle: (p: P) => (
    <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>
  ),
  ban: (p: P) => (
    <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></svg>
  ),
  refresh: (p: P) => (
    <svg {...base(p)}><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>
  ),
  logout: (p: P) => (
    <svg {...base(p)}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
  ),
  chevronRight: (p: P) => (
    <svg {...base(p)}><path d="m9 6 6 6-6 6" /></svg>
  ),
  arrowRight: (p: P) => (
    <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
  ),
  hand: (p: P) => (
    <svg {...base(p)}><path d="M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.6-2.7L3 14.4a2 2 0 0 1 3.3-2.2L8 14" /></svg>
  ),
  table: (p: P) => (
    <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></svg>
  ),
  x: (p: P) => (
    <svg {...base(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>
  ),
  home: (p: P) => (
    <svg {...base(p)}><path d="M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10" /></svg>
  ),
  menu: (p: P) => (
    <svg {...base(p)}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
  ),
  shield: (p: P) => (
    <svg {...base(p)}><path d="M12 3 5 6v6c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6Z" /><path d="m9 12 2 2 4-4" /></svg>
  ),
  chevronLeft: (p: P) => (
    <svg {...base(p)}><path d="m15 6-6 6 6 6" /></svg>
  ),
};

export type IconName = keyof typeof Icon;
