import { useId, useState } from "react";
import type { WeekDay } from "../lib/api";
import { Icon } from "./icons";

/**
 * The last seven company days as stacked columns: completed / pending / blocked.
 *
 * Every number here was counted by Postgres under the viewer's row-level rules
 * (`/dashboard/week`); the browser only draws. The three series are STATES, so they wear
 * the status marks (validated in both themes — see index.css), never a categorical
 * rainbow. Per the data-viz rules: thin columns with a 2px surface gap between
 * segments, a legend (three series), selective direct labels (the day total on the cap,
 * nothing on every segment), a tooltip on hover and keyboard focus, and a table view so
 * nothing is reachable by colour alone.
 */
const SERIES = [
  { key: "completed", label: "Completed", color: "var(--color-mark-ok)", icon: Icon.checkCircle },
  { key: "pending", label: "Pending", color: "var(--color-mark-info)", icon: Icon.hourglass },
  { key: "blocked", label: "Blocked", color: "var(--color-mark-crit)", icon: Icon.ban },
] as const;

const W = 640;
const H = 220;
const PAD = { top: 22, right: 8, bottom: 28, left: 34 };
const GAP = 2; // the surface gap between stacked segments
const MAX_BAR = 24; // columns never fill their slot

function niceMax(n: number): number {
  if (n <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(n));
  const c = n / p;
  return (c <= 1 ? 1 : c <= 2 ? 2 : c <= 5 ? 5 : 10) * p;
}

function dayLabel(iso: string, long = false): string {
  const d = new Date(`${iso}T12:00:00+04:00`);
  return new Intl.DateTimeFormat("en-GB", long ? { weekday: "long", day: "numeric", month: "short" } : { weekday: "short" }).format(d);
}

export function WeekChart({ days, onDay }: { days: WeekDay[]; onDay?: (day: string) => void }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();

  const totals = days.map((d) => d.completed + d.pending + d.blocked);
  const max = niceMax(Math.max(1, ...totals));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, days.length);
  const bar = Math.min(MAX_BAR, slot * 0.5);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max].map((v) => Math.round(v));
  const weekTotal = totals.reduce((a, b) => a + b, 0);

  return (
    <div className="viz-root">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {/* Legend: mirrors the mark (a rect), always present for three series. */}
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-mut">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="flex-1" />
        <button
          onClick={() => setTable((t) => !t)}
          className="inline-flex items-center gap-1 rounded-md border border-edge bg-sunken px-2 py-1 text-mut hover:border-link hover:text-ink"
          aria-pressed={table}
          title={table ? "Show the chart" : "Show the numbers as a table"}
        >
          {table ? <Icon.barChart size={14} /> : <Icon.table size={14} />}
          {table ? "Chart" : "Table"}
        </button>
      </div>

      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-mut">
                <th className="py-1 pr-2 font-medium">Day</th>
                {SERIES.map((s) => <th key={s.key} className="py-1 pr-2 text-right font-medium">{s.label}</th>)}
                <th className="py-1 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {days.map((d, i) => (
                <tr key={d.day} className="border-t border-edge">
                  <td className="py-1 pr-2">{dayLabel(d.day, true)}</td>
                  <td className="py-1 pr-2 text-right">{d.completed}</td>
                  <td className="py-1 pr-2 text-right">{d.pending}</td>
                  <td className="py-1 pr-2 text-right">{d.blocked}</td>
                  <td className="py-1 text-right font-semibold">{totals[i]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-labelledby={`${id}-t`}>
            <title id={`${id}-t`}>
              {`Reports per day, last seven days: ${weekTotal} in total`}
            </title>
            {/* Hairline gridlines and tick labels — recessive. */}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-grid)" strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--color-mut)" className="tabular-nums">{t}</text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = PAD.left + slot * i + slot / 2;
              const x0 = cx - bar / 2;
              let acc = 0;
              const segs = SERIES.map((s) => {
                const v = d[s.key];
                const top = y(acc + v);
                const bottom = y(acc);
                acc += v;
                return { ...s, v, top, bottom };
              });
              const total = totals[i]!;
              const isHover = hover === i;
              return (
                <g
                  key={d.day}
                  tabIndex={0}
                  role="button"
                  aria-label={`${dayLabel(d.day, true)}: ${d.completed} completed, ${d.pending} pending, ${d.blocked} blocked`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onClick={() => onDay?.(d.day)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDay?.(d.day); } }}
                  style={{ cursor: onDay ? "pointer" : "default", outline: "none" }}
                >
                  {/* The hit target is the whole slot, never just the painted pixels. */}
                  <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} fill="transparent" />
                  {segs.map((s, k) => {
                    if (s.v === 0) return null;
                    const h = Math.max(0, s.bottom - s.top - (k > 0 ? GAP : 0));
                    const yTop = s.top + (k > 0 ? GAP : 0);
                    const last = segs.slice(k + 1).every((z) => z.v === 0);
                    return (
                      <rect
                        key={s.key}
                        x={x0}
                        y={yTop}
                        width={bar}
                        height={h}
                        fill={s.color}
                        opacity={isHover ? 1 : 0.92}
                        // 4px rounded data-end on the topmost segment only; square at the baseline.
                        rx={last ? 4 : 0}
                        ry={last ? 4 : 0}
                      />
                    );
                  })}
                  {/* The one direct label per column: the day's total on the cap. */}
                  {total > 0 ? (
                    <text x={cx} y={y(total) - 5} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--color-ink)">{total}</text>
                  ) : null}
                  <text x={cx} y={H - 9} textAnchor="middle" fontSize={11} fill={isHover ? "var(--color-ink)" : "var(--color-mut)"}>{dayLabel(d.day)}</text>
                </g>
              );
            })}
            <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--color-edge)" strokeWidth={1} />
          </svg>
          {hover !== null && days[hover] ? (
            <div
              className="pointer-events-none absolute top-1 rounded-lg border border-edge bg-panel px-2.5 py-2 text-xs shadow-lg"
              style={{ left: `${((PAD.left + slot * hover + slot / 2) / W) * 100}%`, transform: `translateX(${hover >= days.length - 2 ? "-100%" : "-50%"})` }}
              role="status"
            >
              <div className="mb-1 font-semibold text-ink">{dayLabel(days[hover].day, true)}</div>
              {SERIES.map((s) => (
                <div key={s.key} className="flex items-center gap-2">
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                  <b className="w-6 text-right tabular-nums text-ink">{days[hover]![s.key]}</b>
                  <span className="text-mut">{s.label}</span>
                </div>
              ))}
              {onDay ? <div className="mt-1 text-[10px] text-mut">Click to open this day</div> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
