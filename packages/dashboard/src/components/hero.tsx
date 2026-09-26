import { Icon, type IconName } from "./icons";

/**
 * The band at the top of the Overview — FreshNow's own green, with the day's shape in one
 * sentence and the three things the viewer is most likely to do next.
 *
 * Two rules it keeps. The brand greens are FILLS: near-black ink on them measures ~9.8:1,
 * white on them 1.9:1, so every word here is `on-brand` ink and never white. And it states
 * only counts the API returned — the sentence is assembled from numbers, never estimated,
 * so it cannot disagree with the cards underneath it.
 */
export function Hero({
  greeting,
  name,
  dateLabel,
  done,
  pending,
  problems,
  isToday,
  actions,
}: {
  greeting: string;
  name: string;
  dateLabel: string;
  done: number;
  pending: number;
  problems: number;
  isToday: boolean;
  actions: { label: string; icon: IconName; onClick: () => void; primary?: boolean }[];
}) {
  const reported = done + pending + problems;
  const summary =
    reported === 0
      ? isToday
        ? "nothing has been reported yet today"
        : "nothing was reported on this day"
      : [
          `${done} completed`,
          `${pending} still going`,
          problems ? `${problems} ${problems === 1 ? "problem" : "problems"}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <section
      className="relative mb-4 overflow-hidden rounded-3xl px-5 py-5 sm:px-7 sm:py-6"
      style={{ background: "linear-gradient(110deg, var(--color-brand-2) 0%, var(--color-brand) 62%, var(--color-brand) 100%)" }}
    >
      {/* A citrus slice, borrowed from the brand's own imagery: pith ring, eight segments
          separated by gaps in the flesh colour. Decorative only — aria-hidden, and it sits
          where no text goes. */}
      <svg className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 opacity-80 sm:-right-10 sm:-top-12 sm:h-64 sm:w-64 sm:opacity-90" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="47" fill="var(--color-accent)" />
        <circle cx="50" cy="50" r="41" fill="#fff6e6" />
        {Array.from({ length: 8 }).map((_, i) => {
          // Each segment spans 45° minus a 5° gap, drawn as a wedge from the centre.
          const a1 = ((i * 45 + 2.5) * Math.PI) / 180;
          const a2 = (((i + 1) * 45 - 2.5) * Math.PI) / 180;
          const r = 38;
          const x1 = 50 + r * Math.cos(a1), y1 = 50 + r * Math.sin(a1);
          const x2 = 50 + r * Math.cos(a2), y2 = 50 + r * Math.sin(a2);
          return <path key={i} d={`M50 50 L${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2} Z`} fill="var(--color-accent)" />;
        })}
        <circle cx="50" cy="50" r="4" fill="#fff6e6" />
      </svg>
      {/* A second, smaller slice in the brand's darker green, half off the bottom edge. */}
      <svg className="pointer-events-none absolute -bottom-16 right-48 hidden h-36 w-36 opacity-30 lg:block" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="47" fill="var(--color-brand-b)" />
        <circle cx="50" cy="50" r="40" fill="var(--color-brand)" />
      </svg>

      <div className="relative">
        {/* pr on small screens keeps the heading clear of the citrus in the corner. */}
        <h2 className="pr-16 text-2xl font-extrabold tracking-tight text-on-brand sm:pr-0 sm:text-[1.75rem]">
          {greeting}, {name} <span aria-hidden>👋</span>
        </h2>
        <p className="mt-1 max-w-2xl text-sm font-medium text-on-brand/80">
          {dateLabel} — {summary}. Every number below is counted in the database, never estimated.
        </p>

        {actions.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {actions.map((a) => {
              const I = Icon[a.icon];
              return (
                <button
                  key={a.label}
                  onClick={a.onClick}
                  className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold shadow-sm transition-transform hover:-translate-y-0.5 ${
                    a.primary
                      ? "bg-accent text-on-brand"
                      : "bg-canvas/90 text-ink hover:bg-canvas"
                  }`}
                >
                  <I size={16} />
                  {a.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
