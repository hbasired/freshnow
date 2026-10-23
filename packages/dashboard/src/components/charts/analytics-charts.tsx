import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { TIER_COLOR, TIER_WORDS, dayLabel, n1, type CategoryPerf, type MachinePerf } from "../../lib/analytics-api";

/**
 * The Analytics portal's charts (TASK-070), drawn with Recharts like the Operations chart (TASK-058), in its own code
 * chunk. Per the data-viz rules:
 *   - Above / about / below the fleet average is a DIVERGING encoding — blue, gray, orange, validated in both themes
 *     (index.css) — and every bar's tier is also said in words (the table, the tooltip), never by colour alone.
 *   - A category's bars are one series, so they take one hue (the accent) and no legend; the title names them.
 *   - Day-by-day lines use the EMPHASIS pair: the period is the accent, the same weekday before is gray; a day the
 *     mirror did not read is a gap, never a zero.
 *   - Thin marks with 4 px rounded ends, a hairline grid, a tooltip on every mark, value first.
 * Every number was counted by Postgres; nothing here adds anything up.
 */

const axisTick = { fill: "var(--color-mut)", fontSize: 11 };
const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pctText = (n: number | null): string => (n === null ? "—" : `${n > 0 ? "+" : ""}${n1(n)} %`);

/** A short stroke of a series' colour — lines are keyed with lines, not boxes. */
export function LegendKey({ color, label, box = false }: { color: string; label: string; box?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={box ? "inline-block size-2.5 rounded-sm" : "inline-block h-0.5 w-4 rounded-full"} style={{ background: color }} />
      <span className="text-ink">{label}</span>
    </span>
  );
}

function TipBox({ title, lines }: { title: string; lines: { value: string; name: string; color?: string }[] }) {
  return (
    <div className="rounded-lg border border-edge bg-panel px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-semibold text-ink">{title}</div>
      {lines.map((l) => (
        <div key={l.name} className="flex items-center gap-2">
          {l.color ? <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded-full" style={{ background: l.color }} /> : null}
          <span className="font-semibold tabular-nums text-ink">{l.value}</span>
          <span className="text-mut">{l.name}</span>
        </div>
      ))}
    </div>
  );
}

/** A machine's name on one line, cut with an ellipsis — Recharts' own tick wraps long names onto two cramped lines. */
function NameTick(props: { x?: number | string; y?: number | string; payload?: { value?: string } }) {
  return (
    <text x={Number(props.x ?? 0) - 6} y={Number(props.y ?? 0) + 4} textAnchor="end" fontSize={11} fill="var(--color-mut)">
      {short(String(props.payload?.value ?? ""), 26)}
    </text>
  );
}

// ── every machine, against the fleet average ─────────────────────────────────
/**
 * Machines that sold, most cups a day first, one bar each, coloured by their side of the average, with the average
 * and the two tier lines (75 % and 125 %) drawn across. Tall by design: one row per machine, so none is hidden.
 */
export function RankedMachines({
  machines,
  average,
  thresholds,
  onPick,
}: {
  machines: MachinePerf[];
  average: number;
  /** Where the tiers begin, from the server (125 % and 75 % of the unrounded average). */
  thresholds: { top: number; below: number } | null;
  onPick?: (m: MachinePerf) => void;
}) {
  // In the server's order (its ranks), drawn at their cups a day.
  const rows = machines
    .filter((m) => m.counted && m.cupsPerDay !== null && m.cups > 0)
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
    // Drawn at the exact rate, so a bar never crosses a tier line its colour disagrees with; the words show it rounded.
    .map((m) => ({ key: m.key, name: `${m.assetNo ?? "—"} ${m.label.replace(/-\s*\d{3,5}\s*-.*$/, "")}`, value: m.cupsPerDayExact ?? m.cupsPerDay ?? 0, m }));
  if (rows.length === 0) return null;
  const height = Math.max(160, rows.length * 22 + 40);
  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mut">
        <LegendKey box color={TIER_COLOR.top} label={TIER_WORDS.top} />
        <LegendKey box color={TIER_COLOR.average} label={TIER_WORDS.average} />
        <LegendKey box color={TIER_COLOR.below} label={TIER_WORDS.below} />
        <span>— the fleet average {n1(average)} cups a day; dashed: 75 % and 125 % of it</span>
      </figcaption>
      <div style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 48, bottom: 0, left: 0 }} barCategoryGap={2}>
            <CartesianGrid horizontal={false} stroke="var(--color-grid)" />
            <XAxis type="number" tick={axisTick} axisLine={{ stroke: "var(--color-grid)" }} tickLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={168} tick={NameTick} axisLine={false} tickLine={false} interval={0} />
            <Tooltip
              cursor={{ fill: "var(--color-sunken)" }}
              isAnimationActive={false}
              content={(t: TooltipContentProps) => {
                const m = (t.payload?.[0]?.payload as { m?: MachinePerf } | undefined)?.m;
                if (!t.active || !m) return null;
                return (
                  <TipBox
                    title={`${m.label}${m.assetNo ? ` · ${m.assetNo}` : ""}`}
                    lines={[
                      { value: n1(m.cupsPerDay ?? 0), name: "cups a day" },
                      { value: m.vsAverage === null ? "—" : `${Math.round(m.vsAverage * 100)} %`, name: "of the fleet average" },
                      { value: m.tier ? TIER_WORDS[m.tier] : "—", name: m.category },
                      { value: pctText(m.changePct), name: "against the same days before" },
                    ]}
                  />
                );
              }}
            />
            <ReferenceLine x={average} stroke="var(--color-ink)" strokeWidth={1.5} />
            {thresholds ? <ReferenceLine x={thresholds.below} stroke="var(--color-mut)" strokeDasharray="4 4" /> : null}
            {thresholds ? <ReferenceLine x={thresholds.top} stroke="var(--color-mut)" strokeDasharray="4 4" /> : null}
            <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false} onClick={(d: { payload?: { m?: MachinePerf } }) => d.payload?.m && onPick?.(d.payload.m)}>
              {rows.map((r) => (
                <Cell key={r.key} fill={TIER_COLOR[r.m.tier ?? "average"]} cursor={onPick ? "pointer" : "default"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

// ── categories, side by side ─────────────────────────────────────────────────
/** Cups per machine per day for each category — one series, one hue — with the fleet average across. */
export function CategoryBars({ categories, average }: { categories: CategoryPerf[]; average: number | null }) {
  // A category where one machine sold is that machine: said in its label, as the sentences leave it out (review, 20 Oct).
  const rows = categories
    .filter((c) => c.cupsPerMachineDay !== null)
    .map((c) => ({ name: c.selling === 1 ? `${c.category} (1 machine)` : c.category, value: c.cupsPerMachineDay ?? 0, c }));
  if (rows.length === 0) return null;
  return (
    <figure className="m-0">
      <div style={{ height: Math.max(150, rows.length * 34 + 46) }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 24, right: 56, bottom: 0, left: 0 }} barCategoryGap={6}>
            <CartesianGrid horizontal={false} stroke="var(--color-grid)" />
            <XAxis type="number" tick={axisTick} axisLine={{ stroke: "var(--color-grid)" }} tickLine={false} />
            <YAxis type="category" dataKey="name" width={160} tick={axisTick} axisLine={false} tickLine={false} interval={0} />
            <Tooltip
              cursor={{ fill: "var(--color-sunken)" }}
              isAnimationActive={false}
              content={(t: TooltipContentProps) => {
                const c = (t.payload?.[0]?.payload as { c?: CategoryPerf } | undefined)?.c;
                if (!t.active || !c) return null;
                return (
                  <TipBox
                    title={c.category}
                    lines={[
                      { value: n1(c.cupsPerMachineDay ?? 0), name: "cups per machine a day" },
                      { value: `${c.selling} of ${c.machines}`, name: "machines sold" },
                      { value: `${n1(c.share)} %`, name: "of all cups" },
                      { value: pctText(c.changePct), name: "cups a day (volume), against the same days before" },
                    ]}
                  />
                );
              }}
            />
            {average !== null ? <ReferenceLine x={average} stroke="var(--color-ink)" strokeWidth={1.5} label={{ value: `fleet ${n1(average)}`, position: "top", fill: "var(--color-mut)", fontSize: 11 }} /> : null}
            <Bar dataKey="value" fill="var(--color-mark-accent)" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              <LabelList dataKey="value" position="right" formatter={(v: unknown) => n1(Number(v))} style={{ fill: "var(--color-ink)", fontSize: 11 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

// ── day by day against the same weekday before ───────────────────────────────
export interface DayPoint {
  date: string;
  now: number | null;
  before: number | null;
}

/**
 * Days of the period (accent) against the same weekday before (gray). `compact` drops the axes for a category card's
 * small multiple; the full version keeps them, with a legend and a crosshair tooltip.
 */
export function DailyComparison({ points, names, unit, compact = false }: { points: DayPoint[]; names: { now: string; before: string }; unit: string; compact?: boolean }) {
  const anyBefore = points.some((p) => p.before !== null);
  return (
    <figure className="m-0">
      {!compact ? (
        <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mut">
          <LegendKey color="var(--color-mark-accent)" label={names.now} />
          {anyBefore ? <LegendKey color="var(--color-mark-base)" label={names.before} /> : null}
        </figcaption>
      ) : null}
      <div className={compact ? "h-16 w-full" : "h-56 w-full"}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={compact ? { top: 4, right: 4, bottom: 4, left: 4 } : { top: 8, right: 16, bottom: 0, left: 0 }}>
            {!compact ? <CartesianGrid vertical={false} stroke="var(--color-grid)" /> : null}
            <XAxis dataKey="date" hide={compact} tickFormatter={(d: string) => dayLabel(d).replace(/^(\w+) (\d+) \w+$/, "$1 $2")} tick={axisTick} axisLine={{ stroke: "var(--color-grid)" }} tickLine={false} minTickGap={12} />
            <YAxis hide={compact} width={36} tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip
              cursor={{ stroke: "var(--color-mut)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(t: TooltipContentProps) => {
                const p = t.payload?.[0]?.payload as DayPoint | undefined;
                if (!t.active || !p) return null;
                return (
                  <TipBox
                    title={dayLabel(p.date)}
                    lines={[
                      { value: p.now === null ? "not read" : n1(p.now), name: `${unit} — ${names.now}`, color: "var(--color-mark-accent)" },
                      ...(anyBefore ? [{ value: p.before === null ? "not read" : n1(p.before), name: `${unit} — ${names.before}`, color: "var(--color-mark-base)" }] : []),
                    ]}
                  />
                );
              }}
            />
            {anyBefore ? (
              <Line dataKey="before" name={names.before} type="linear" stroke="var(--color-mark-base)" strokeWidth={2} dot={compact ? false : { r: 2.5, fill: "var(--color-mark-base)", strokeWidth: 0 }} connectNulls={false} isAnimationActive={false} />
            ) : null}
            <Line dataKey="now" name={names.now} type="linear" stroke="var(--color-mark-accent)" strokeWidth={2} dot={compact ? false : { r: 3, fill: "var(--color-mark-accent)", strokeWidth: 0 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

// ── hour by hour against the same weekday before ─────────────────────────────
export interface HourPoint {
  hour: number;
  /** Null for hours not reached yet today — never drawn as zero. */
  now: number | null;
  before: number | null;
}

/** Cups by hour: the day (accent) against the same weekday a week before (gray) — the emphasis pair. */
export function HourlyLines({ points, names }: { points: HourPoint[]; names: { now: string; before: string } }) {
  const anyBefore = points.some((p) => p.before !== null);
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mut">
        <LegendKey color="var(--color-mark-accent)" label={names.now} />
        {anyBefore ? <LegendKey color="var(--color-mark-base)" label={names.before} /> : null}
      </figcaption>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-grid)" />
            <XAxis dataKey="hour" type="number" domain={[0, 23]} ticks={[0, 3, 6, 9, 12, 15, 18, 21]} tickFormatter={hh} tick={axisTick} axisLine={{ stroke: "var(--color-grid)" }} tickLine={false} />
            <YAxis width={32} tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip
              cursor={{ stroke: "var(--color-mut)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(t: TooltipContentProps) => {
                const p = t.payload?.[0]?.payload as HourPoint | undefined;
                if (!t.active || !p) return null;
                return (
                  <TipBox
                    title={hh(p.hour)}
                    lines={[
                      { value: p.now === null ? "not yet" : n1(p.now), name: `cups — ${names.now}`, color: "var(--color-mark-accent)" },
                      ...(anyBefore ? [{ value: p.before === null ? "not read" : n1(p.before), name: `cups — ${names.before}`, color: "var(--color-mark-base)" }] : []),
                    ]}
                  />
                );
              }}
            />
            {anyBefore ? <Line dataKey="before" type="linear" stroke="var(--color-mark-base)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} /> : null}
            <Line dataKey="now" type="linear" stroke="var(--color-mark-accent)" strokeWidth={2} dot={{ r: 2.5, fill: "var(--color-mark-accent)", strokeWidth: 0 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** One series of bars with each value at its end — a small "which machines, how much" chart (one hue, no legend). */
export function ValueBars({ rows, unit, format = n1, onPick }: { rows: { key: string; name: string; value: number }[]; unit: string; format?: (n: number) => string; onPick?: (key: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <figure className="m-0">
      <div style={{ height: Math.max(120, rows.length * 24 + 30) }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 72, bottom: 0, left: 0 }} barCategoryGap={3}>
            <CartesianGrid horizontal={false} stroke="var(--color-grid)" />
            <XAxis type="number" tick={axisTick} axisLine={{ stroke: "var(--color-grid)" }} tickLine={false} tickFormatter={(v: number) => format(v)} />
            <YAxis type="category" dataKey="name" width={168} tick={NameTick} axisLine={false} tickLine={false} interval={0} />
            <Tooltip
              cursor={{ fill: "var(--color-sunken)" }}
              isAnimationActive={false}
              content={(t: TooltipContentProps) => {
                const r = t.payload?.[0]?.payload as { name: string; value: number } | undefined;
                if (!t.active || !r) return null;
                return <TipBox title={r.name} lines={[{ value: format(r.value), name: unit }]} />;
              }}
            />
            <Bar dataKey="value" fill="var(--color-mark-accent)" radius={[0, 4, 4, 0]} isAnimationActive={false} onClick={(d: { payload?: { key?: string } }) => d.payload?.key && onPick?.(d.payload.key)}>
              <LabelList dataKey="value" position="right" formatter={(v: unknown) => format(Number(v))} style={{ fill: "var(--color-ink)", fontSize: 11 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
