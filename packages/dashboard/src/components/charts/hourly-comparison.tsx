import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { HourlySales } from "../../lib/api";

/**
 * Cups sold by hour: one day against the same weekday a week earlier (TASK-058).
 *
 * The first chart drawn with Recharts. It is imported only by the Operations portal, which is its own
 * code chunk, so the library is downloaded only by people who open that portal.
 *
 * Per the data-viz rules (as the week chart before it): the EMPHASIS form — one series is the point
 * (the day, in the accent), the other is context (a week earlier, gray), both validated in both themes
 * (index.css); 2px straight lines between hours (a smoothed curve would invent values between them);
 * a solid hairline grid; a crosshair tooltip listing both series, value first; a legend AND a label at
 * each line's end, so which line is which never rests on colour; the table view is in the card around
 * it. Every number was counted by Postgres — nothing here adds anything up.
 *
 * The hour still being read is not drawn as if it were whole (TASK-058 review): whole hours are the
 * solid line, the hour in progress is a dashed step to a hollow dot, and the tooltip says "so far" and
 * gives the same minutes a week earlier — the fair comparison. An earlier day the mirror did not read
 * is not drawn at all — a line along zero would say nothing was sold.
 */

const hh = (h: number): string => `${String(h).padStart(2, "0")}:00`;
const compact = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));

interface Row {
  hour: number;
  /** Whole hours of the day shown; null for the hour in progress and later. */
  day: number | null;
  /** Only the last whole hour and the hour in progress: the dashed step between them. */
  soFar: number | null;
  /** Null throughout when the earlier day is not in the mirror. */
  earlier: number | null;
}

export interface SeriesNames {
  /** "Today" or "Wed 15 Oct". */
  day: string;
  /** "Wed 8 Oct". */
  earlier: string;
}

export function HourlyComparisonChart({ data, names }: { data: HourlySales; names: SeriesNames }) {
  const p = data.partial;
  const compare = data.covered.comparedWith;
  const rows: Row[] = data.hours.map((h) => ({
    hour: h.hour,
    day: h.cups,
    soFar: p && h.hour === p.hour ? p.cups : p && h.hour === p.hour - 1 ? h.cups : null,
    earlier: h.cupsLastWeek,
  }));
  // Where each line ends, in hours and cups — for its label.
  const lastWhole = p ? p.hour - 1 : 23;
  const dayEnd = p ? { hour: p.hour, cups: p.cups } : { hour: 23, cups: rows[23]?.day ?? 0 };
  const earlierEnd = { hour: 23, cups: rows[23]?.earlier ?? 0 };
  const top = Math.max(1, ...rows.map((r) => Math.max(r.day ?? 0, r.soFar ?? 0, r.earlier ?? 0)));
  // Two end labels close in both directions would print on each other: then the context line's label
  // gives way and the legend carries it. Close = within three hours across and an eighth of the height.
  const labelsCollide = compare && earlierEnd.hour - dayEnd.hour <= 3 && Math.abs(dayEnd.cups - earlierEnd.cups) / top < 0.125;

  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mut">
        <LegendKey color="var(--color-mark-accent)" label={names.day} />
        {p ? <LegendKey color="var(--color-mark-accent)" label={`${hh(p.hour)} so far`} dashed /> : null}
        {compare ? <LegendKey color="var(--color-mark-base)" label={names.earlier} /> : null}
      </figcaption>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 12, right: 64, bottom: 0, left: 0 }}
            title={`Cups sold by hour, ${names.day} against ${names.earlier}`}
            desc="Each line is cups sold per hour; the table view under this chart lists every hour."
          >
            <CartesianGrid vertical={false} stroke="var(--color-grid)" />
            <XAxis
              dataKey="hour"
              type="number"
              domain={[0, 23]}
              ticks={[0, 3, 6, 9, 12, 15, 18, 21]}
              tickFormatter={hh}
              tick={{ fill: "var(--color-mut)", fontSize: 11 }}
              axisLine={{ stroke: "var(--color-grid)" }}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              width={40}
              tickFormatter={compact}
              tick={{ fill: "var(--color-mut)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ stroke: "var(--color-mut)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(t: TooltipContentProps) => <HourTip {...t} data={data} names={names} />}
            />
            {/* Context first, so the line that matters is drawn on top of it. */}
            {compare ? (
              <Line
                dataKey="earlier"
                name={names.earlier}
                type="linear"
                stroke="var(--color-mark-base)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, fill: "var(--color-mark-base)", stroke: "var(--color-panel)", strokeWidth: 2 }}
                isAnimationActive={false}
                label={labelsCollide ? false : endLabel(23, names.earlier)}
              />
            ) : null}
            <Line
              dataKey="day"
              name={names.day}
              type="linear"
              stroke="var(--color-mark-accent)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              connectNulls={false}
              activeDot={{ r: 4, fill: "var(--color-mark-accent)", stroke: "var(--color-panel)", strokeWidth: 2 }}
              isAnimationActive={false}
              label={p ? false : endLabel(lastWhole, names.day)}
            />
            {p ? (
              <Line
                dataKey="soFar"
                name={`${names.day}, so far`}
                type="linear"
                stroke="var(--color-mark-accent)"
                strokeWidth={2}
                strokeDasharray="4 4"
                connectNulls={false}
                dot={(d: { cx?: number | undefined; cy?: number | undefined; index?: number | undefined }) =>
                  d.index === p.hour && d.cx !== undefined && d.cy !== undefined ? (
                    <circle key="so-far" cx={d.cx} cy={d.cy} r={4} fill="var(--color-panel)" stroke="var(--color-mark-accent)" strokeWidth={2} />
                  ) : (
                    <g key={`n${d.index}`} />
                  )
                }
                activeDot={false}
                isAnimationActive={false}
                label={endLabel(p.hour, names.day)}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** A short stroke of the series colour — legends and tooltips key lines with lines, not boxes. */
function LegendKey({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-0.5 w-4 rounded-full"
        style={dashed ? { background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` } : { background: color }}
      />
      <span className="text-ink">{label}</span>
    </span>
  );
}

/** The series name at the end of its line, in a text colour — the mark beside it carries the colour. */
function endLabel(index: number, text: string) {
  return function EndLabel(props: { x?: number | string | undefined; y?: number | string | undefined; index?: number | undefined }) {
    if (props.index !== index || props.x === undefined || props.y === undefined) return <g />;
    return (
      <text x={Number(props.x) + 6} y={Number(props.y) + 4} fontSize={11} fill="var(--color-mut)">
        {text}
      </text>
    );
  };
}

/** Value first, series name second; both series at the hour under the pointer — "so far" for the hour in progress. */
function HourTip({ active, label, data, names }: TooltipContentProps & { data: HourlySales; names: SeriesNames }) {
  if (!active) return null;
  const h = Number(label);
  const row = data.hours[h];
  if (!row) return null;
  const inProgress = data.partial && data.partial.hour === h ? data.partial : null;
  const later = data.throughHour !== null && h > data.throughHour;
  const items: { key: string; value: number | string; name: string; color: string }[] = [];
  if (inProgress) {
    items.push({ key: "day", value: inProgress.cups, name: `${names.day}, so far`, color: "var(--color-mark-accent)" });
    if (inProgress.cupsLastWeekSameMinutes !== null) {
      items.push({ key: "same", value: inProgress.cupsLastWeekSameMinutes, name: `${names.earlier}, same minutes`, color: "var(--color-mark-base)" });
    }
  } else if (!later && row.cups !== null) {
    items.push({ key: "day", value: row.cups, name: names.day, color: "var(--color-mark-accent)" });
  }
  if (row.cupsLastWeek !== null) {
    items.push({ key: "earlier", value: row.cupsLastWeek, name: inProgress ? `${names.earlier}, whole hour` : names.earlier, color: "var(--color-mark-base)" });
  }
  return (
    <div className="rounded-lg border border-edge bg-panel px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-mut">
        {hh(h)}–{hh((h + 1) % 24)}
        {later ? " · not read yet" : ""}
      </div>
      {items.map((i) => (
        <div key={i.key} className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded-full" style={{ background: i.color }} />
          <span className="font-semibold tabular-nums text-ink">{i.value}</span>
          <span className="text-mut">{i.name}</span>
        </div>
      ))}
    </div>
  );
}
