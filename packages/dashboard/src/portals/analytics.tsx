import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { TextArea } from "../components/form";
import { Icon } from "../components/icons";
import { Card, Empty, Pill, Spinner } from "../components/ui";
import { CategoryBars, DailyComparison, RankedMachines } from "../components/charts/analytics-charts";
import {
  NOT_COUNTED,
  TIER_COLOR,
  TIER_WORDS,
  addDays,
  aedRound,
  analytics,
  dayLabel,
  dubaiDay,
  n1,
  type Insight,
  type MachineDaily,
  type MachinePerf,
  type Performance,
  type Tier,
} from "../lib/analytics-api";
import { ANALYTICS_VIEWS, type AnalyticsView } from "../portals";
import { BigButton, Problem, Sheet, errorText } from "./inv-ui";

/**
 * The Analytics portal (TASK-070): which machines and which places sell — the user's request of 19 Oct (R8.2–8.4).
 *
 *   Machines     every live machine against the fleet average of cups per machine per day — top (≥ 125 %), about
 *                average, below (< 75 %), or nothing sold — the few that make 80 % of the cups, and each machine's
 *                days beside the same weekday a week before
 *   Categories   Hospital / Clinics, Metro, malls, Events (the Expo machines) … added up per machine per day, so a
 *                category of 19 machines and one of 2 compare fairly
 *
 * Whole days only (up to yesterday); the period is compared with the same days of the week, whole weeks earlier. A
 * day Televend was not read is said, never counted as zero. Income is an estimate from the price in each machine's
 * name and says so. Every figure comes from the server (core/analytics.ts); this page only draws it.
 */

const VIEW_LABEL: Record<AnalyticsView, string> = { machines: "Machines", categories: "Categories" };
const PRESETS: { label: string; days: number }[] = [
  { label: "Yesterday", days: 1 },
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "28 days", days: 28 },
];
const TIERS: Tier[] = ["top", "average", "below", "no_sales"];

interface Filter {
  tier: Tier | null;
  category: string | null;
  assetNos: number[] | null;
  q: string;
}
const NO_FILTER: Filter = { tier: null, category: null, assetNos: null, q: "" };

export default function AnalyticsPortal({
  viewer,
  view,
  onView,
  canCorrect,
}: {
  viewer: string;
  view: AnalyticsView;
  onView: (v: AnalyticsView) => void;
  liveTick: number;
  /** machines.manage — the Ops Head, the CEO, an Admin. The server checks it again. */
  canCorrect: boolean;
}) {
  const yesterday = addDays(dubaiDay(0), -1);
  const [range, setRange] = useState({ from: addDays(yesterday, -6), to: yesterday });
  const [data, setData] = useState<Performance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [correcting, setCorrecting] = useState<MachinePerf | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await analytics.performance(viewer, range.from, range.to));
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [viewer, range.from, range.to]);
  // Whole days do not change minute by minute, so the page does not reload on every live update — only when the
  // range changes, after a correction, or on Refresh.
  useEffect(() => {
    void load();
  }, [load]);

  const showMachines = (assetNos: number[]) => {
    setFilter({ ...NO_FILTER, assetNos });
    onView("machines");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Analytics</h2>
          <p className="text-sm text-mut">Which machines and which places sell — against the average, day by day.</p>
        </div>
        <div className="flex rounded-xl border border-edge bg-sunken p-0.5" role="tablist" aria-label="Analytics views">
          {ANALYTICS_VIEWS.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => onView(v)}
              className={`min-h-10 rounded-lg px-3 py-1.5 text-sm ${view === v ? "bg-panel font-semibold text-ink shadow-sm" : "text-mut hover:text-ink"}`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>

      <RangePicker
        range={range}
        yesterday={yesterday}
        first={data?.coverage.mirroredFrom ?? null}
        shiftDays={data && data.period.from === range.from && data.period.to === range.to ? data.before.shiftDays : null}
        onRange={setRange}
        onRefresh={() => void load()}
        busy={busy}
      />

      {flash ? (
        <p role="status" className="rounded-xl border border-ok/40 bg-ok/10 p-3 font-semibold text-ok">
          {flash}
        </p>
      ) : null}
      {err ? <Problem text={err} /> : null}
      {!data && !err ? <Spinner label="Counting every sale…" /> : null}

      {data ? (
        <>
          <Coverage data={data} />
          {data.coverage.read.length === 0 ? (
            <Empty>No day of this period was read from Televend. Choose days from {data.coverage.mirroredFrom ? dayLabel(data.coverage.mirroredFrom) : "the first day read"} on.</Empty>
          ) : (
            <>
              <Kpis data={data} />
              <Insights insights={data.insights} onShow={showMachines} />
              {view === "machines" ? (
                <MachinesView
                  viewer={viewer}
                  data={data}
                  filter={filter}
                  onFilter={setFilter}
                  open={open}
                  onOpen={setOpen}
                  canCorrect={canCorrect}
                  onCorrect={setCorrecting}
                />
              ) : (
                <CategoriesView data={data} onShow={(category) => { setFilter({ ...NO_FILTER, category }); onView("machines"); }} />
              )}
            </>
          )}
        </>
      ) : null}

      {correcting ? (
        <CorrectSheet
          viewer={viewer}
          machine={correcting}
          onClose={() => setCorrecting(null)}
          onDone={(msg) => {
            setCorrecting(null);
            setFlash(msg);
            setTimeout(() => setFlash(null), 6_000);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

// ── the days ────────────────────────────────────────────────────────────────
function RangePicker({
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
  /** How far back the comparison is, from the server once it has answered. */
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
    <Card className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Days">
        {PRESETS.map((p) => {
          const r = { from: addDays(yesterday, -(p.days - 1)), to: yesterday };
          const on = range.from === r.from && range.to === r.to;
          return (
            <button key={p.label} onClick={() => onRange(r)} aria-pressed={on} className={`min-h-11 rounded-xl border px-3 text-sm ${on ? "border-link font-semibold" : "border-edge"}`}>
              {p.label}
            </button>
          );
        })}
        <span className="mx-1 text-sm text-mut">or</span>
        <label className="flex items-center gap-1 text-sm">
          From
          <input type="date" value={from} min={first ?? undefined} max={yesterday} onChange={(e) => setFrom(e.target.value)} aria-label="First day" className="h-11 rounded-xl border border-edge bg-sunken px-2" />
        </label>
        <label className="flex items-center gap-1 text-sm">
          to
          <input type="date" value={to} min={first ?? undefined} max={yesterday} onChange={(e) => setTo(e.target.value)} aria-label="Last day" className="h-11 rounded-xl border border-edge bg-sunken px-2" />
        </label>
        <button
          onClick={() => onRange({ from, to })}
          disabled={problem !== null || (from === range.from && to === range.to)}
          className="min-h-11 rounded-xl border border-ok bg-ok/10 px-3 text-sm font-semibold text-ok disabled:opacity-40"
        >
          Show
        </button>
        <button onClick={onRefresh} disabled={busy} aria-label="Count again" className="ml-auto flex size-11 items-center justify-center rounded-xl border border-edge text-mut hover:text-ink disabled:opacity-40">
          <Icon.refresh size={18} />
        </button>
      </div>
      <p className={`text-sm ${problem ? "text-crit" : "text-mut"}`}>
        {problem ??
          `${dayLabel(range.from)}${range.from !== range.to ? ` – ${dayLabel(range.to)}` : ""}${
            shiftDays ? ` · compared with the same days of the week, ${shiftDays} days earlier` : ""
          }`}
      </p>
    </Card>
  );
}

function Coverage({ data }: { data: Performance }) {
  const { notRead, beforeRead, beforeNotRead, read, compared } = data.coverage;
  if (notRead.length === 0 && beforeNotRead.length === 0) return null;
  return (
    <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
      {notRead.length > 0 ? (
        <p>
          Not in the store yet, or not read in full from Televend: {notRead.map(dayLabel).join(", ")} — those days are left out, and per-day figures use the{" "}
          {read.length} day{read.length === 1 ? "" : "s"} read. (Yesterday arrives once Televend's count for it is checked, early each morning.)
        </p>
      ) : null}
      {beforeRead.length === 0 ? (
        <p>
          No comparison: the same days before ({dayLabel(data.before.from)} – {dayLabel(data.before.to)}) are not in the store
          {data.coverage.mirroredFrom ? `, which starts on ${dayLabel(data.coverage.mirroredFrom)}` : ""}.
        </p>
      ) : compared.length < read.length ? (
        <p>
          The changes compare only the {compared.length} day{compared.length === 1 ? "" : "s"} read in both periods, each with the same weekday {data.before.shiftDays} days
          earlier{beforeNotRead.length > 0 ? ` (not read before: ${beforeNotRead.map(dayLabel).join(", ")})` : ""}.
        </p>
      ) : null}
    </div>
  );
}

// ── the key figures ─────────────────────────────────────────────────────────
function Change({ pct, suffix = "%" }: { pct: number | null; suffix?: string }) {
  if (pct === null) return <span className="text-mut">no comparison</span>;
  const up = pct > 0;
  return (
    <span className={pct === 0 ? "text-mut" : up ? "text-ok" : "text-crit"}>
      {up ? "▲" : pct < 0 ? "▼" : "•"} {n1(Math.abs(pct))} {suffix}
    </span>
  );
}

function Kpis({ data }: { data: Performance }) {
  const f = data.fleet;
  const cash = f.cashCompare;
  const c = f.compare;
  const tiles: { label: string; value: string; line: ReactNode }[] = [
    {
      label: "Cups sold",
      value: f.cups.toLocaleString("en-GB"),
      line: c ? (
        <>
          <Change pct={c.changePct} />{" "}
          <span className="text-mut">
            a day · {n1(c.now)} against {n1(c.before)}
            {c.days < data.coverage.read.length ? ` (${c.days} days read in both)` : ""}
          </span>
        </>
      ) : (
        <span className="text-mut">no comparison</span>
      ),
    },
    {
      // A level, not a change: no arrow — its denominator (the machines that sold) can move between the periods.
      label: "Per machine that sold, a day",
      value: f.cupsPerMachineDay === null ? "—" : n1(f.cupsPerMachineDay),
      line: <span className="text-mut">the average the tiers use · before {f.before.cupsPerMachineDay === null ? "—" : n1(f.before.cupsPerMachineDay)}</span>,
    },
    {
      label: "Income (estimated)",
      value: aedRound(f.incomeFils),
      line: (
        <span className="text-mut">cash cups × the cash price (set, or AED 10) + the other paid cups × the price in the name (else the cash price); tokens not paid</span>
      ),
    },
    {
      label: "Paid in cash",
      value: f.cashShare === null ? "—" : `${n1(f.cashShare)} %`,
      line:
        cash === null ? (
          <span className="text-mut">no comparison</span>
        ) : (
          <span className="text-mut">
            {n1(cash.now)} % against {n1(cash.before)} % before ({cash.move > 0 ? "+" : ""}
            {n1(cash.move)} points)
          </span>
        ),
    },
    { label: "Machines that sold", value: `${f.selling} of ${f.machines}`, line: <span className="text-mut">{f.top80} made 80 % of the cups</span> },
  ];
  return (
    <section aria-label="Key figures" className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((t) => (
        <Card key={t.label} className="space-y-0.5">
          <div className="text-xs text-mut">{t.label}</div>
          <div className="text-2xl font-bold tracking-tight">{t.value}</div>
          <div className="text-xs">{t.line}</div>
        </Card>
      ))}
    </section>
  );
}

function Insights({ insights, onShow }: { insights: Insight[]; onShow: (assetNos: number[]) => void }) {
  if (insights.length === 0) return null;
  return (
    <section aria-label="What it says" className="rounded-2xl border border-edge bg-panel p-3">
      <h3 className="mb-2 text-sm font-bold">What it says — and what to do</h3>
      <ul className="space-y-2">
        {insights.map((i) => {
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
                    <span className="font-semibold">→ {i.action.label}.</span>
                    {i.action.assetNos.length > 0 ? (
                      <button onClick={() => onShow(i.action!.assetNos)} className="min-h-9 rounded-lg border border-edge px-2 text-xs font-semibold hover:border-link">
                        Show {i.action.assetNos.length === 1 ? "the machine" : `the ${i.action.assetNos.length} machines`}
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── machines ────────────────────────────────────────────────────────────────
function TierBadge({ tier }: { tier: Tier | null }) {
  if (!tier) return <span className="text-mut">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className="inline-block size-2.5 rounded-sm" style={{ background: TIER_COLOR[tier] }} />
      {TIER_WORDS[tier]}
    </span>
  );
}

function MachinesView({
  viewer,
  data,
  filter,
  onFilter,
  open,
  onOpen,
  canCorrect,
  onCorrect,
}: {
  viewer: string;
  data: Performance;
  filter: Filter;
  onFilter: (f: Filter) => void;
  open: string | null;
  onOpen: (key: string | null) => void;
  canCorrect: boolean;
  onCorrect: (m: MachinePerf) => void;
}) {
  const f = data.fleet;
  // The server's ranking; machines that sold nothing after them, by number.
  const counted = useMemo(
    () => data.machines.filter((m) => m.counted).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.assetNo ?? 1e9) - (b.assetNo ?? 1e9) || a.key.localeCompare(b.key)),
    [data],
  );
  const q = filter.q.trim().toLowerCase();
  const shown = counted.filter(
    (m) =>
      (!filter.tier || m.tier === filter.tier) &&
      (!filter.category || m.category === filter.category) &&
      (!filter.assetNos || (m.assetNo !== null && filter.assetNos.includes(m.assetNo))) &&
      (!q || m.label.toLowerCase().includes(q) || String(m.assetNo ?? "").includes(q)),
  );
  const notCounted = data.machines.filter((m) => !m.counted);
  const categories = [...new Set(counted.map((m) => m.category))].sort((a, b) => a.localeCompare(b));
  const filtered = filter.tier !== null || filter.category !== null || filter.assetNos !== null || q !== "";
  const pickFromChart = (m: MachinePerf) => {
    onOpen(m.key);
    setTimeout(() => document.getElementById(`machine-${m.key}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  return (
    <div className="space-y-4">
      <section aria-label="Tiers" className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {TIERS.map((t) => {
          const s = f.tiers[t];
          const on = filter.tier === t;
          return (
            <button
              key={t}
              onClick={() => onFilter({ ...filter, tier: on ? null : t, assetNos: null })}
              aria-pressed={on}
              className={`min-h-20 rounded-2xl border p-3 text-left ${on ? "border-link bg-sunken" : "border-edge bg-panel hover:border-link"}`}
            >
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <span aria-hidden="true" className="inline-block size-2.5 rounded-sm" style={{ background: TIER_COLOR[t] }} />
                {TIER_WORDS[t]}
              </div>
              <div className="text-2xl font-bold">{s.machines}</div>
              <div className="text-xs text-mut">
                {t === "no_sales" ? "machines sold nothing" : `machines · ${n1(s.cupsShare)} % of the cups`}
              </div>
            </button>
          );
        })}
      </section>
      <p className="text-xs text-mut">
        Top is at least 125 % of the fleet average of {f.cupsPerMachineDay === null ? "—" : n1(f.cupsPerMachineDay)} cups per machine a day; below is under 75 %. The
        average counts the machines that sold.
      </p>

      {f.cupsPerMachineDay !== null ? (
        <Card>
          <h3 className="mb-2 text-sm font-bold">Cups a day, every machine that sold</h3>
          <RankedMachines machines={counted} average={f.cupsPerMachineDay} thresholds={f.thresholds} onPick={pickFromChart} />
        </Card>
      ) : null}

      <section aria-label="Machines" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filter.q}
            onChange={(e) => onFilter({ ...filter, q: e.target.value, assetNos: null })}
            placeholder="Find a machine — name or number"
            aria-label="Find a machine"
            className="h-11 min-w-0 flex-1 rounded-xl border border-edge bg-sunken px-3 text-sm"
          />
          <select
            value={filter.category ?? ""}
            onChange={(e) => onFilter({ ...filter, category: e.target.value || null, assetNos: null })}
            aria-label="Category"
            className="h-11 rounded-xl border border-edge bg-sunken px-2 text-sm"
          >
            <option value="">Every category</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {filtered ? (
            <button onClick={() => onFilter(NO_FILTER)} className="min-h-11 rounded-xl border border-edge px-3 text-sm">
              Show all {counted.length}
            </button>
          ) : null}
        </div>
        <p className="text-sm text-mut">
          {shown.length} of {counted.length} machines{filter.assetNos ? " — the ones named above" : ""}
        </p>
        {shown.length === 0 ? <Empty>No machine matches.</Empty> : null}
        <ul className="space-y-2">
          {shown.map((m) => (
            <MachineRow
              key={m.key}
              viewer={viewer}
              m={m}
              rank={m.rank}
              period={data.period}
              open={open === m.key}
              onToggle={() => onOpen(open === m.key ? null : m.key)}
              canCorrect={canCorrect}
              onCorrect={() => onCorrect(m)}
            />
          ))}
        </ul>
      </section>

      {notCounted.length > 0 ? (
        <details className="rounded-2xl border border-edge bg-panel p-3">
          <summary className="min-h-10 cursor-pointer text-sm font-semibold">Not counted · {notCounted.length}</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {notCounted.map((m) => (
              <li key={m.key} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {m.label}
                  {m.assetNo ? ` · ${m.assetNo}` : ""} <span className="text-mut">— {m.cups.toLocaleString("en-GB")} cups, left out of every figure</span>
                </span>
                {canCorrect ? (
                  <button onClick={() => onCorrect(m)} className="min-h-10 rounded-lg border border-edge px-3 text-xs">
                    Change
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function MachineRow({
  viewer,
  m,
  rank,
  period,
  open,
  onToggle,
  canCorrect,
  onCorrect,
}: {
  viewer: string;
  m: MachinePerf;
  rank: number | null;
  period: { from: string; to: string };
  open: boolean;
  onToggle: () => void;
  canCorrect: boolean;
  onCorrect: () => void;
}) {
  return (
    <li id={`machine-${m.key}`} className="rounded-xl border border-edge bg-panel p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">
            {rank ? <span className="mr-1.5 text-mut">#{rank}</span> : null}
            {m.label}
            {m.assetNo ? <span className="font-normal text-mut"> · {m.assetNo}</span> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mut">
            <span>
              {m.category}
              {m.corrected ? <span title={`Televend: ${m.televendRegion ?? "no region"}`}> (corrected)</span> : null}
            </span>
            {m.emirate ? <span>· {m.emirate}</span> : null}
            {m.cardOnly ? <Pill tone="mut">Card only</Pill> : null}
            {m.inTop80 ? <Pill tone="ok">In the 80 %</Pill> : null}
            {m.disabledNow ? <Pill tone="warn">Off in Televend now</Pill> : null}
            {canCorrect ? (
              <button onClick={onCorrect} className="min-h-8 rounded-md border border-edge px-2 text-xs hover:border-link">
                Change category
              </button>
            ) : null}
          </div>
        </div>
        <div className="text-sm">
          <TierBadge tier={m.tier} />
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-5">
        <Fig label="Cups a day" value={m.cupsPerDay === null ? "—" : n1(m.cupsPerDay)} />
        <Fig label="Of the average" value={m.vsAverage === null ? "—" : `${Math.round(m.vsAverage * 100)} %`} />
        <Fig label="Against before" value={<Change pct={m.changePct} />} />
        <Fig
          label="Income (est.)"
          value={`${aedRound(m.incomeFils)}`}
          hint={`cash at AED ${m.prices.cashFils / 100} (${m.prices.cashSource === "set" ? "set on the machine" : "the default"}), card at AED ${m.prices.cardFils / 100} (${
            m.prices.cardSource === "name" ? "from its name" : "the cash price"
          })`}
        />
        <Fig label="Paid in cash" value={m.cashShare === null ? "—" : `${n1(m.cashShare)} %`} />
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={onToggle} aria-expanded={open} className="min-h-10 rounded-lg border border-edge px-3 text-xs font-semibold hover:border-link">
          {open ? "Hide the days" : "Day by day"}
        </button>
        {m.assetNo !== null ? (
          <a href={`#operations/machine/${m.assetNo}`} className="flex min-h-10 items-center rounded-lg border border-edge px-3 text-xs font-semibold hover:border-link">
            Open the machine
          </a>
        ) : null}
      </div>
      {open ? <MachineDays viewer={viewer} machine={m.machineId ?? m.machineTvId} period={period} /> : null}
    </li>
  );
}

function Fig({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-mut">{label}</dt>
      <dd className="font-semibold tabular-nums" title={hint}>
        {value}
      </dd>
    </div>
  );
}

function MachineDays({ viewer, machine, period }: { viewer: string; machine: string | number; period: { from: string; to: string } }) {
  const [d, setD] = useState<MachineDaily | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    analytics.daily(viewer, machine, period.from, period.to).then(setD, (e) => setErr(errorText(e)));
  }, [viewer, machine, period.from, period.to]);
  if (err) return <Problem text={err} />;
  if (!d) return <Spinner label="Counting its days…" />;
  return (
    <div className="mt-2">
      <DailyComparison
        points={d.days.map((x) => ({ date: x.date, now: x.cups, before: x.weekBefore }))}
        names={{ now: "Cups that day", before: "Same weekday a week before" }}
        unit="cups"
      />
    </div>
  );
}

// ── categories ──────────────────────────────────────────────────────────────
function CategoriesView({ data, onShow }: { data: Performance; onShow: (category: string) => void }) {
  const f = data.fleet;
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="mb-1 text-sm font-bold">Cups per machine a day, by category</h3>
        <p className="mb-2 text-xs text-mut">Per machine, so a category of many machines and one of a few compare fairly. The line is the fleet.</p>
        <CategoryBars categories={data.categories} average={f.cupsPerMachineDay} />
      </Card>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.categories.map((c) => (
          <li key={c.category}>
            <Card className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-bold">{c.category}</h3>
                <button onClick={() => onShow(c.category)} className="min-h-9 shrink-0 rounded-lg border border-edge px-2 text-xs font-semibold hover:border-link">
                  Its machines
                </button>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-2xl font-bold">{c.cupsPerMachineDay === null ? "—" : n1(c.cupsPerMachineDay)}</span>
                <span className="text-xs text-mut">cups per machine a day</span>
              </div>
              <div className="text-xs">
                <Change pct={c.changePct} />{" "}
                <span className="text-mut">
                  {c.compare ? `cups a day against the same days before (${n1(c.compare.now)} against ${n1(c.compare.before)})` : "cups a day against the same days before"}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <Fig label="Machines" value={`${c.selling} sold of ${c.machines}`} />
                <Fig label="Share of cups" value={`${n1(c.share)} %`} />
                <Fig label="Income (est.)" value={aedRound(c.incomeFils)} />
                <Fig label="Paid in cash" value={c.cashShare === null ? "—" : `${n1(c.cashShare)} %`} />
              </dl>
              {c.best ? (
                <p className="text-xs">
                  <span className="text-mut">Best:</span> {c.best.label}
                  {c.best.assetNo ? ` (${c.best.assetNo})` : ""} — {n1(c.best.cupsPerDay)} a day
                  {c.weakest ? (
                    <>
                      <br />
                      <span className="text-mut">Weakest that sold:</span> {c.weakest.label}
                      {c.weakest.assetNo ? ` (${c.weakest.assetNo})` : ""} — {n1(c.weakest.cupsPerDay)} a day
                    </>
                  ) : null}
                  {c.noSales > 0 ? (
                    <>
                      <br />
                      <span className="text-crit">{c.noSales} sold nothing</span>
                    </>
                  ) : null}
                </p>
              ) : c.noSales > 0 ? (
                <p className="text-xs text-crit">{c.noSales} machine{c.noSales === 1 ? "" : "s"} sold nothing</p>
              ) : null}
              {data.period.days >= 3 ? (
                <div>
                  <DailyComparison
                    compact
                    points={c.daily.map((x) => ({ date: x.date, now: x.cupsPerMachine, before: x.before }))}
                    names={{ now: "These days", before: `${data.before.shiftDays} days earlier` }}
                    unit="cups per machine"
                  />
                  <p className="text-[11px] text-mut">
                    Each day's cups ÷ the {c.selling} machine{c.selling === 1 ? "" : "s"} that sold in the period — blue these days, gray the same weekday{" "}
                    {data.before.shiftDays} days earlier
                  </p>
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── correcting a category ────────────────────────────────────────────────────
function CorrectSheet({ viewer, machine, onClose, onDone }: { viewer: string; machine: MachinePerf; onClose: () => void; onDone: (msg: string) => void }) {
  const [choices, setChoices] = useState<string[] | null>(null);
  const [value, setValue] = useState(machine.category);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    analytics.categories(viewer).then(setChoices, (e) => setErr(errorText(e)));
  }, [viewer]);
  const televend = machine.televendRegion;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await analytics.setCategory(viewer, machine.machineId ?? machine.machineTvId, value === televend ? null : value, note.trim() || undefined);
      onDone(r.corrected ? `${machine.label} is now counted under ${r.category}.` : `${machine.label} is back under Televend's ${r.category}.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Change category"
      onClose={onClose}
      footer={
        <BigButton onClick={save} busy={busy} disabled={!choices || value === machine.category}>
          Save
        </BigButton>
      }
    >
      <p className="font-semibold">
        {machine.label}
        {machine.assetNo ? ` · ${machine.assetNo}` : ""}
      </p>
      <p className="text-sm text-mut">
        Televend files it under <b>{televend ?? "no region"}</b>. A correction here changes only FreshNow's figures — Televend is never changed. "{NOT_COUNTED}" leaves it
        out of every figure (a test machine, one not in public).
      </p>
      {!choices ? (
        <Spinner label="Loading the categories…" />
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Category">
          {choices.map((c) => (
            <label key={c} className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border px-3 ${value === c ? "border-ok bg-ok/10" : "border-edge"}`}>
              <input type="radio" name="category" checked={value === c} onChange={() => setValue(c)} />
              <span>
                {c}
                {c === televend ? <span className="text-mut"> — Televend's</span> : null}
              </span>
            </label>
          ))}
        </div>
      )}
      <TextArea label="Why (optional)" value={note} onChange={setNote} rows={2} maxLength={300} placeholder="It stands inside the clinic, not at the Expo" />
      <Problem text={err} />
    </Sheet>
  );
}
