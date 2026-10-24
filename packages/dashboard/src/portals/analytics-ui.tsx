import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../components/icons";
import { Card } from "../components/ui";
import { TIER_COLOR, TIER_WORDS, addDays, dayLabel, n1, type Insight, type Tier } from "../lib/analytics-api";

/**
 * The Analytics portal's shared pieces (TASK-075): the filter row (days, then the category buttons), tiles that open
 * their page, the short sentences, and the small marks every page uses. Nothing here adds anything up — every figure
 * arrives from the server.
 */

export const PRESETS: { label: string; days: number }[] = [
  { label: "Yesterday", days: 1 },
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "28 days", days: 28 },
];

/** A value that settles: the category buttons can be tapped quickly, and only the last choice is counted. */
export function useSettled<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Change({ pct, suffix = "%" }: { pct: number | null; suffix?: string }) {
  if (pct === null) return <span className="text-mut">no comparison</span>;
  const up = pct > 0;
  return (
    <span className={pct === 0 ? "text-mut" : up ? "text-ok" : "text-crit"}>
      {up ? "▲" : pct < 0 ? "▼" : "•"} {n1(Math.abs(pct))} {suffix}
    </span>
  );
}

export function Fig({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-mut">{label}</dt>
      <dd className="font-semibold tabular-nums" title={hint}>
        {value}
      </dd>
    </div>
  );
}

export function TierBadge({ tier }: { tier: Tier | null }) {
  if (!tier) return <span className="text-mut">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className="inline-block size-2.5 rounded-sm" style={{ background: TIER_COLOR[tier] }} />
      {TIER_WORDS[tier]}
    </span>
  );
}

/**
 * A key figure. With `onOpen` it is a button that opens its page (the user: "the buttons are static you need to make them
 * working"); the arrow says it opens.
 */
export function Tile({ label, value, line, onOpen, opens }: { label: string; value: string; line: ReactNode; onOpen?: () => void; opens?: string }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2 text-xs text-mut">
        <span>{label}</span>
        {onOpen ? <Icon.chevronRight size={14} className="shrink-0 opacity-60 group-hover:opacity-100" /> : null}
      </div>
      <div className="text-2xl font-bold tracking-tight">{value}</div>
      <div className="text-xs">{line}</div>
    </>
  );
  if (!onOpen) return <Card className="space-y-0.5 p-3">{body}</Card>;
  return (
    <button
      onClick={onOpen}
      title={opens}
      aria-label={`${label}: ${value}${opens ? ` — ${opens}` : ""}`}
      className="group space-y-0.5 rounded-xl border border-edge bg-panel p-3 text-left hover:border-link focus-visible:border-link"
    >
      {body}
    </button>
  );
}

/** A titled block of a page, with an anchor a tile can scroll to. */
export function Section({ id, title, hint, right, children }: { id?: string; title: string; hint?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-label={title} className="scroll-mt-20 rounded-xl border border-edge bg-panel p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-bold">{title}</h3>
          {hint ? <p className="text-xs text-mut">{hint}</p> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export const scrollTo = (id: string) => setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);

/**
 * The short sentences, most urgent first, two to a row on a wide screen — kept short on purpose ("Dont give long text").
 * A sentence that names machines offers to show them.
 */
export function InsightList({ insights, onShow, title = "What it says — and what to do", max = 6 }: { insights: Insight[]; onShow?: (assetNos: number[]) => void; title?: string; max?: number }) {
  const [all, setAll] = useState(false);
  if (insights.length === 0) return null;
  const shown = all ? insights : insights.slice(0, max);
  return (
    <section aria-label={title} className="rounded-xl border border-edge bg-panel p-3">
      <h3 className="mb-2 text-sm font-bold">{title}</h3>
      <ul className="grid gap-x-4 gap-y-2 md:grid-cols-2">
        {shown.map((i) => {
          const I = i.tone === "good" ? Icon.checkCircle : i.tone === "bad" ? Icon.alertCircle : Icon.barChart;
          return (
            <li key={i.id} className="flex items-start gap-2 text-sm">
              <span className={`mt-0.5 shrink-0 ${i.tone === "good" ? "text-ok" : i.tone === "bad" ? "text-crit" : "text-mut"}`}>
                <I size={16} />
              </span>
              <span className="min-w-0 flex-1">
                {i.text}
                {i.action ? (
                  <span className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">→ {i.action.label}.</span>
                    {onShow && i.action.assetNos.length > 0 ? (
                      <button onClick={() => onShow(i.action!.assetNos)} className="min-h-9 rounded-lg border border-edge px-2 text-xs font-semibold hover:border-link">
                        {i.action.assetNos.length === 1 ? "Open the machine" : `Show the ${i.action.assetNos.length} machines`}
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {insights.length > max ? (
        <button onClick={() => setAll(!all)} className="mt-2 min-h-9 rounded-lg px-2 text-xs font-semibold text-link hover:underline">
          {all ? "Fewer" : `All ${insights.length}`}
        </button>
      ) : null}
    </section>
  );
}

/**
 * One button per category (the user: "add buttons … for all the categories … I can unselect the button and the full
 * analysis is shown instantly … without including expo"). Pressed = counted; "All" and "None" reset. The machines each
 * category has stand beside its name, so a category of 2 is not mistaken for one of 20.
 */
export function CategoryChips({
  available,
  chosen,
  onChange,
}: {
  available: { category: string; machines: number; selling: number }[];
  /** Null = every category. */
  chosen: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  if (available.length === 0) return null;
  const names = available.map((a) => a.category);
  const on = (c: string) => chosen === null || chosen.includes(c);
  const toggle = (c: string) => {
    const now = chosen ?? names;
    const next = now.includes(c) ? now.filter((x) => x !== c) : [...now, c];
    onChange(names.every((x) => next.includes(x)) ? null : next.sort((a, b) => a.localeCompare(b)));
  };
  const chip = "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm";
  return (
    <div role="group" aria-label="Categories counted" className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-semibold text-mut">Categories</span>
      <button onClick={() => onChange(null)} aria-pressed={chosen === null} className={`${chip} ${chosen === null ? "border-link font-semibold" : "border-edge text-mut hover:text-ink"}`}>
        All
      </button>
      <button onClick={() => onChange([])} aria-pressed={chosen !== null && chosen.length === 0} className={`${chip} border-edge text-mut hover:text-ink`}>
        None
      </button>
      <span aria-hidden="true" className="mx-0.5 h-6 w-px bg-edge" />
      {available.map((a) => (
        <button
          key={a.category}
          onClick={() => toggle(a.category)}
          aria-pressed={on(a.category)}
          title={`${a.machines} machine${a.machines === 1 ? "" : "s"}, ${a.selling} sold`}
          className={`${chip} ${on(a.category) ? "border-link bg-sunken font-semibold text-ink" : "border-dashed border-edge text-mut hover:text-ink"}`}
        >
          {on(a.category) ? <Icon.check size={14} /> : null}
          {a.category}
          <span className="font-normal text-mut">{a.machines}</span>
        </button>
      ))}
    </div>
  );
}

/** The days: presets first, then a range of whole days up to yesterday (at most 92). */
export function RangePicker({
  range,
  yesterday,
  first,
  shiftDays,
  onRange,
  onRefresh,
  busy,
}: {
  range: { from: string; to: string };
  yesterday: string;
  first: string | null;
  shiftDays: number | null;
  onRange: (r: { from: string; to: string }) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  useEffect(() => {
    setFrom(range.from);
    setTo(range.to);
  }, [range.from, range.to]);
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const problem = !from || !to ? "Choose both days." : from > to ? "The first day comes before the last." : to > yesterday ? "Up to yesterday — today is in Operations → Now." : span > 92 ? "At most 92 days at a time." : null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Days">
        {PRESETS.map((p) => {
          const r = { from: addDays(yesterday, -(p.days - 1)), to: yesterday };
          const on = range.from === r.from && range.to === r.to;
          return (
            <button key={p.label} onClick={() => onRange(r)} aria-pressed={on} className={`min-h-10 rounded-xl border px-3 text-sm ${on ? "border-link font-semibold" : "border-edge"}`}>
              {p.label}
            </button>
          );
        })}
        <span className="mx-1 text-sm text-mut">or</span>
        <label className="flex items-center gap-1 text-sm">
          From
          <input type="date" value={from} min={first ?? undefined} max={yesterday} onChange={(e) => setFrom(e.target.value)} aria-label="First day" className="h-10 rounded-xl border border-edge bg-sunken px-2" />
        </label>
        <label className="flex items-center gap-1 text-sm">
          to
          <input type="date" value={to} min={first ?? undefined} max={yesterday} onChange={(e) => setTo(e.target.value)} aria-label="Last day" className="h-10 rounded-xl border border-edge bg-sunken px-2" />
        </label>
        <button
          onClick={() => onRange({ from, to })}
          disabled={problem !== null || (from === range.from && to === range.to)}
          className="min-h-10 rounded-xl border border-ok bg-ok/10 px-3 text-sm font-semibold text-ok disabled:opacity-40"
        >
          Show
        </button>
        <button onClick={onRefresh} disabled={busy} aria-label="Count again" className="ml-auto flex size-10 items-center justify-center rounded-xl border border-edge text-mut hover:text-ink disabled:opacity-40">
          <Icon.refresh size={18} />
        </button>
      </div>
      <p className={`text-xs ${problem ? "text-crit" : "text-mut"}`}>
        {problem ??
          `${dayLabel(range.from)}${range.from !== range.to ? ` – ${dayLabel(range.to)}` : ""}${shiftDays ? ` · compared with the same days of the week, ${shiftDays} days earlier` : ""}`}
      </p>
    </div>
  );
}

/** Days the store does not hold, said — never counted as days without sales. */
export function Coverage({ notRead, read, beforeRead, compared, before }: { notRead: string[]; read: string[]; beforeRead: string[]; compared: string[]; before: { from: string; to: string; shiftDays: number } }) {
  const noBefore = beforeRead.length === 0;
  if (notRead.length === 0 && !noBefore && compared.length === read.length) return null;
  return (
    <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
      {notRead.length > 0 ? (
        <p>
          Not read in full from Televend yet: {notRead.map(dayLabel).join(", ")} — left out; per-day figures use the {read.length} day{read.length === 1 ? "" : "s"} read. (Yesterday
          arrives once Televend's count for it is checked, early each morning.)
        </p>
      ) : null}
      {noBefore ? (
        <p>
          No comparison: the same days before ({dayLabel(before.from)} – {dayLabel(before.to)}) are not in the store.
        </p>
      ) : compared.length < read.length ? (
        <p>
          The changes compare only the {compared.length} day{compared.length === 1 ? "" : "s"} read in both periods, each with the same weekday {before.shiftDays} days earlier.
        </p>
      ) : null}
    </div>
  );
}

export function BackBar({ label, onBack, right }: { label: string; onBack: () => void; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button onClick={onBack} className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-edge px-3 text-sm hover:border-link">
        <Icon.chevronLeft size={16} /> {label}
      </button>
      {right}
    </div>
  );
}
