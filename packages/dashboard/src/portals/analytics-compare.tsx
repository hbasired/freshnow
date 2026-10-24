import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/icons";
import { Empty, Spinner } from "../components/ui";
import { MoverBars, PairBars, TwoLines } from "../components/charts/analytics-charts";
import {
  PAYMENT_WORDS,
  addDays,
  aedPrice,
  aedRound,
  analytics,
  dayLabel,
  n1,
  signedPct,
  type CompareMode,
  type CompareQuery,
  type CompareRow,
  type Performance,
  type SalesComparison,
  type SalesProfile,
} from "../lib/analytics-api";
import { Problem, errorText } from "./inv-ui";
import { InsightList, Section, useSettled } from "./analytics-ui";

/**
 * Compare (TASK-075) — the user: "there should be a comparison page where I can select two dates, or two machines, or two
 * categories and there complete analysis with visualizations and charts", and "clear comparision buttons with choosable
 * options". Four buttons choose what is compared; each has its own pickers and quick choices; the answer appears under
 * them as soon as both sides are chosen. Every difference is worked out by the server (core/analytics-explore.ts).
 *
 * A and B are peers, so they wear two hues (--color-series-a blue, --color-series-b orange), never the tier scale.
 */

const A = "var(--color-series-a)";
const B = "var(--color-series-b)";

export interface CompareStart {
  mode: CompareMode;
  /** A machine's key (machines) or a category's name (categories) for side A. */
  a?: string;
}

const MODES: { mode: CompareMode; label: string; blurb: string }[] = [
  { mode: "days", label: "Two days", blurb: "yesterday against the same day last week, or any two days" },
  { mode: "periods", label: "Two periods", blurb: "this week against last week, or any two ranges" },
  { mode: "machines", label: "Two machines", blurb: "over the days chosen above" },
  { mode: "categories", label: "Two categories", blurb: "over the days chosen above" },
];

const spanOk = (r: { from: string; to: string }, yesterday: string) =>
  !!r.from && !!r.to && r.from <= r.to && r.to <= yesterday && Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) < 92;
const sideName = (c: SalesComparison, p: SalesProfile) =>
  c.mode === "days" ? dayLabel(p.period.from) : c.mode === "periods" ? `${dayLabel(p.period.from)} – ${dayLabel(p.period.to)}` : p.scope.label;
/** A machine's value in the pickers: FreshNow's id, or the Televend record for one FreshNow has no machine for. */
const machineValue = (key: string) => (key.startsWith("tv:") ? key.slice(3) : key);

function DateBox({ label, value, onChange, max }: { label: string; value: string; onChange: (v: string) => void; max: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-semibold text-mut">{label}</span>
      <input type="date" value={value} max={max} onChange={(e) => onChange(e.target.value)} className="h-11 rounded-xl border border-edge bg-sunken px-2" />
    </label>
  );
}

function Quick({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="min-h-10 rounded-xl border border-edge px-3 text-sm hover:border-link">
      {label}
    </button>
  );
}

function SideKey({ color, label, side }: { color: string; label: string; side: "A" | "B" }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-sm" style={{ background: color }} />
      <span className="text-xs font-bold text-mut">{side}</span>
      <span className="min-w-0 truncate font-semibold">{label}</span>
    </span>
  );
}

export function ComparePage({
  viewer,
  range,
  yesterday,
  chosen,
  start,
  onMachine,
  onCategory,
}: {
  viewer: string;
  /** The days chosen above — what two machines or two categories are compared over. */
  range: { from: string; to: string };
  yesterday: string;
  /** The categories chosen above — what two days or two periods count. */
  chosen: string[] | null;
  start: CompareStart | null;
  onMachine: (key: string) => void;
  onCategory: (name: string) => void;
}) {
  const [mode, setMode] = useState<CompareMode>(start?.mode ?? "days");
  const [dayA, setDayA] = useState(addDays(yesterday, -7));
  const [dayB, setDayB] = useState(yesterday);
  const [perA, setPerA] = useState({ from: addDays(yesterday, -13), to: addDays(yesterday, -7) });
  const [perB, setPerB] = useState({ from: addDays(yesterday, -6), to: yesterday });
  const [mA, setMA] = useState(start?.mode === "machines" && start.a ? machineValue(start.a) : "");
  const [mB, setMB] = useState("");
  const [cA, setCA] = useState(start?.mode === "categories" && start.a ? start.a : "");
  const [cB, setCB] = useState("");
  const [opts, setOpts] = useState<Performance | null>(null);
  useEffect(() => {
    let live = true;
    analytics.performance(viewer, range.from, range.to).then(
      (p) => live && setOpts(p),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [viewer, range.from, range.to]);
  // A fresh start (from a machine's or a category's page) replaces what was there.
  useEffect(() => {
    if (!start) return;
    setMode(start.mode);
    if (start.mode === "machines" && start.a) setMA(machineValue(start.a));
    if (start.mode === "categories" && start.a) setCA(start.a);
  }, [start]);

  const machines = useMemo(
    () =>
      (opts?.machines ?? [])
        .filter((m) => m.counted && (m.cups > 0 || !m.disabledNow))
        .sort((x, y) => x.label.localeCompare(y.label))
        .map((m) => ({ value: machineValue(m.key), key: m.key, label: `${m.label}${m.assetNo ? ` · ${m.assetNo}` : ""}` })),
    [opts],
  );
  const categories = useMemo(() => (opts?.selection.available ?? []).map((c) => c.category), [opts]);

  const { q, problem } = useMemo((): { q: CompareQuery | null; problem: string | null } => {
    if (mode === "days") {
      if (!dayA || !dayB) return { q: null, problem: "Choose both days." };
      if (dayA > yesterday || dayB > yesterday) return { q: null, problem: "Whole days only — up to yesterday." };
      return { q: { mode, a: dayA, b: dayB, categories: chosen }, problem: chosen?.length === 0 ? "Choose at least one category above." : null };
    }
    if (mode === "periods") {
      if (!spanOk(perA, yesterday) || !spanOk(perB, yesterday)) return { q: null, problem: "Each period: the first day before the last, up to yesterday, at most 92 days." };
      return { q: { mode, a: perA, b: perB, categories: chosen }, problem: chosen?.length === 0 ? "Choose at least one category above." : null };
    }
    if (mode === "machines") {
      if (!mA || !mB) return { q: null, problem: "Choose two machines." };
      if (mA === mB) return { q: null, problem: "Choose two different machines." };
      return { q: { mode, from: range.from, to: range.to, a: mA, b: mB }, problem: null };
    }
    if (!cA || !cB) return { q: null, problem: "Choose two categories." };
    if (cA === cB) return { q: null, problem: "Choose two different categories." };
    return { q: { mode, from: range.from, to: range.to, a: cA, b: cB }, problem: null };
  }, [mode, dayA, dayB, perA, perB, mA, mB, cA, cB, chosen, range.from, range.to, yesterday]);

  const ask = useSettled(q && !problem ? JSON.stringify(q) : null, 300);
  const [res, setRes] = useState<SalesComparison | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    setBusy(true);
    analytics
      .compare(viewer, JSON.parse(ask) as CompareQuery)
      .then(
        (r) => {
          if (!live) return;
          setRes(r);
          setErr(null);
        },
        (e) => live && setErr(errorText(e)),
      )
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [viewer, ask]);

  const swap = () => {
    if (mode === "days") {
      setDayA(dayB);
      setDayB(dayA);
    } else if (mode === "periods") {
      setPerA(perB);
      setPerB(perA);
    } else if (mode === "machines") {
      setMA(mB);
      setMB(mA);
    } else {
      setCA(cB);
      setCB(cA);
    }
  };
  const pickDays = (a: string, b: string) => {
    setDayA(a);
    setDayB(b);
  };
  const lastN = (n: number) => {
    setPerB({ from: addDays(yesterday, -(n - 1)), to: yesterday });
    setPerA({ from: addDays(yesterday, -(2 * n - 1)), to: addDays(yesterday, -n) });
  };
  const select = "h-11 w-full min-w-0 rounded-xl border border-edge bg-sunken px-2 text-sm";
  const shown = res && res.mode === mode ? res : null;

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="What to compare" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {MODES.map((m) => (
          <button
            key={m.mode}
            role="radio"
            aria-checked={mode === m.mode}
            onClick={() => setMode(m.mode)}
            className={`min-h-16 rounded-xl border p-3 text-left ${mode === m.mode ? "border-link bg-sunken" : "border-edge bg-panel hover:border-link"}`}
          >
            <div className="flex items-center gap-1.5 font-semibold">
              {mode === m.mode ? <Icon.check size={16} /> : null}
              {m.label}
            </div>
            <div className="text-xs text-mut">{m.blurb}</div>
          </button>
        ))}
      </div>

      <section aria-label="Choose A and B" className="space-y-3 rounded-xl border border-edge bg-panel p-4">
        {mode === "days" ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:max-w-md">
              <DateBox label="A — the first day" value={dayA} onChange={setDayA} max={yesterday} />
              <DateBox label="B — the second day" value={dayB} onChange={setDayB} max={yesterday} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Quick label="Yesterday vs the same day last week" onClick={() => pickDays(addDays(yesterday, -7), yesterday)} />
              <Quick label="Yesterday vs the day before" onClick={() => pickDays(addDays(yesterday, -1), yesterday)} />
            </div>
          </>
        ) : mode === "periods" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid grid-cols-2 gap-2">
                <DateBox label="A — from" value={perA.from} onChange={(v) => setPerA({ ...perA, from: v })} max={yesterday} />
                <DateBox label="A — to" value={perA.to} onChange={(v) => setPerA({ ...perA, to: v })} max={yesterday} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <DateBox label="B — from" value={perB.from} onChange={(v) => setPerB({ ...perB, from: v })} max={yesterday} />
                <DateBox label="B — to" value={perB.to} onChange={(v) => setPerB({ ...perB, to: v })} max={yesterday} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Quick label="Last 7 days vs the 7 before" onClick={() => lastN(7)} />
              <Quick label="Last 14 vs the 14 before" onClick={() => lastN(14)} />
              <Quick label="Last 28 vs the 28 before" onClick={() => lastN(28)} />
            </div>
          </>
        ) : mode === "machines" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="text-xs font-semibold text-mut">A — the first machine</span>
              <select value={mA} onChange={(e) => setMA(e.target.value)} className={select} aria-label="Machine A">
                <option value="">Choose…</option>
                {machines.map((m) => (
                  <option key={m.key} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="text-xs font-semibold text-mut">B — the second machine</span>
              <select value={mB} onChange={(e) => setMB(e.target.value)} className={select} aria-label="Machine B">
                <option value="">Choose…</option>
                {machines.map((m) => (
                  <option key={m.key} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="text-xs font-semibold text-mut">A — the first category</span>
              <select value={cA} onChange={(e) => setCA(e.target.value)} className={select} aria-label="Category A">
                <option value="">Choose…</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="text-xs font-semibold text-mut">B — the second category</span>
              <select value={cB} onChange={(e) => setCB(e.target.value)} className={select} aria-label="Category B">
                <option value="">Choose…</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`text-xs ${problem ? "text-crit" : "text-mut"}`}>
            {problem ??
              (mode === "days" || mode === "periods"
                ? `Counting ${chosen === null ? "every category" : chosen.length === 1 ? chosen[0] : `the ${chosen.length} categories chosen above`}.`
                : `Over ${dayLabel(range.from)}${range.from !== range.to ? ` – ${dayLabel(range.to)}` : ""} — change the days above.`)}
          </p>
          <button onClick={swap} className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-edge px-3 text-sm hover:border-link">
            Swap A and B
          </button>
        </div>
      </section>

      {err ? <Problem text={err} /> : null}
      {!shown && busy ? <Spinner label="Comparing…" /> : null}
      {!shown && !busy && !err && problem ? <Empty>{problem}</Empty> : null}
      {shown ? (
        <div className={`space-y-4 transition-opacity ${busy ? "opacity-60" : ""}`} aria-busy={busy}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-edge bg-panel p-3">
            <SideKey side="A" color={A} label={sideName(shown, shown.a)} />
            <span className="text-mut">against</span>
            <SideKey side="B" color={B} label={sideName(shown, shown.b)} />
          </div>
          <InsightList insights={shown.insights} title="In short" />
          <Section title="Side by side" hint="B against A. A % compares the totals, never rounded rates.">
            <CompareTable rows={shown.rows} a={sideName(shown, shown.a)} b={sideName(shown, shown.b)} />
          </Section>
          <div className="grid gap-4 xl:grid-cols-2">
            <Section title="Hours of the day" hint="Cups at each hour, per day read.">
              <TwoLines axis="hour" points={shown.hours.map((h) => ({ x: h.hour, a: h.a, b: h.b }))} names={{ a: `A · ${sideName(shown, shown.a)}`, b: `B · ${sideName(shown, shown.b)}` }} colors={{ a: A, b: B }} unit="cups a day" />
            </Section>
            {shown.days ? (
              <Section title="Each day" hint="Cups each day over the same days; a day not read is a gap.">
                <TwoLines axis="day" points={shown.days.map((d) => ({ x: d.date, a: d.a, b: d.b }))} names={{ a: `A · ${sideName(shown, shown.a)}`, b: `B · ${sideName(shown, shown.b)}` }} colors={{ a: A, b: B }} unit="cups" />
              </Section>
            ) : null}
            <Section title="How people paid" hint="Share of the cups.">
              <PairBars
                rows={shown.payments.filter((x) => (x.a ?? 0) > 0 || (x.b ?? 0) > 0).map((x) => ({ key: x.kind, name: PAYMENT_WORDS[x.kind], a: x.a, b: x.b }))}
                names={{ a: "A", b: "B" }}
                colors={{ a: A, b: B }}
                unit="% of cups"
                format={(n) => `${n1(n)} %`}
              />
            </Section>
            {shown.categories && shown.categories.length > 0 ? (
              <Section title="Categories" hint="Cups a day in each category. Tap a bar to open the category.">
                <PairBars rows={shown.categories.map((c) => ({ key: c.category, name: c.category, a: c.a, b: c.b }))} names={{ a: "A", b: "B" }} colors={{ a: A, b: B }} unit="cups a day" onPick={onCategory} />
              </Section>
            ) : null}
          </div>
          {shown.movers && shown.movers.length > 0 ? (
            <Section title="The machines that moved most" hint="Cups a day, B against A: up to five each way. Tap a bar to open the machine.">
              <MoverBars rows={shown.movers} names={{ a: "A", b: "B" }} onPick={onMachine} />
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const cell = (r: CompareRow, v: number | null): string =>
  v === null ? "—" : r.unit === "pct" ? `${n1(v)} %` : r.unit === "fils" ? (r.id === "avg_price" ? aedPrice(v) : aedRound(v)) : r.unit === "count" ? String(v) : n1(v);

function CompareTable({ rows, a, b }: { rows: CompareRow[]; a: string; b: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-left text-sm">
        <thead className="text-xs text-mut">
          <tr>
            <th scope="col" className="py-1.5 pr-2 font-semibold">
              Figure
            </th>
            <th scope="col" className="px-2 py-1.5 font-semibold">
              <span aria-hidden="true" className="mr-1 inline-block size-2.5 rounded-sm" style={{ background: A }} />A · {a}
            </th>
            <th scope="col" className="px-2 py-1.5 font-semibold">
              <span aria-hidden="true" className="mr-1 inline-block size-2.5 rounded-sm" style={{ background: B }} />B · {b}
            </th>
            <th scope="col" className="px-2 py-1.5 font-semibold">
              B against A
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => {
            const d = r.diff;
            const tone = d === null || d === 0 ? "text-mut" : d > 0 ? "text-ok" : "text-crit";
            return (
              <tr key={r.id} className="border-t border-edge">
                <th scope="row" className="py-1.5 pr-2 font-normal text-mut">
                  {r.label}
                </th>
                <td className="px-2 py-1.5 font-semibold">{cell(r, r.a)}</td>
                <td className="px-2 py-1.5 font-semibold">{cell(r, r.b)}</td>
                <td className={`px-2 py-1.5 ${tone}`}>
                  {d === null
                    ? "—"
                    : r.unit === "pct"
                      ? `${d > 0 ? "+" : d < 0 ? "−" : "±"}${n1(Math.abs(d))} points`
                      : `${d > 0 ? "+" : d < 0 ? "−" : "±"}${r.unit === "fils" ? (r.id === "avg_price" ? aedPrice(Math.abs(d)) : aedRound(Math.abs(d))) : n1(Math.abs(d))}${r.diffPct !== null ? ` (${signedPct(r.diffPct)})` : ""}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
