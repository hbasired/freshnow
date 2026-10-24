import { useEffect, useMemo, useState } from "react";
import { TextArea } from "../components/form";
import { DataTable, Empty, Pill, Spinner, type Column } from "../components/ui";
import { DailyComparison, PairBars, RankedMachines, ValueBars } from "../components/charts/analytics-charts";
import {
  KEY_MACHINE,
  NOT_COUNTED,
  TIER_COLOR,
  TIER_WORDS,
  addDays,
  aedPrice,
  aedRound,
  analytics,
  beforeWords,
  dayLabel,
  dubaiDay,
  earlierWords,
  n1,
  vsAverageText,
  type Insight,
  type MachinePerf,
  type Performance,
  type SalesProfile,
  type Tier,
} from "../lib/analytics-api";
import { ANALYTICS_VIEWS, type AnalyticsView } from "../portals";
import { BigButton, Problem, Sheet, errorText } from "./inv-ui";
import { CategoryChips, Change, Coverage, Fig, HowToRead, InsightList, RangePicker, Section, TierBadge, Tile, scrollTo, useSettled } from "./analytics-ui";
import { CategoryPage, DayChanges, MachinePage, TrendsView } from "./analytics-pages";
import { ComparePage, type CompareStart } from "./analytics-compare";

/**
 * The Analytics portal (TASK-070, reworked in TASK-075): which machines and which places sell — the user's requests of
 * 19 Oct (R8.2–8.4) and 23 Oct.
 *
 *   One row of filters above everything it scopes: the days, then a button per category — unpress Expo and every figure,
 *   chart and sentence below is counted again without it ("the full analysis is shown instantly … without including expo").
 *
 *   Overview     key figures that open their page, the short sentences beside them, each day against the same weekday a
 *                week before, and the machines: the tier buttons with their answer right under them (the list and the
 *                chart follow the button — "when a button is clicked then the answer is below the charts")
 *   Categories   per machine a day against the days before, the share of cups, a card per category that opens its page
 *   Trends       the categories chosen: days, income, hours, weekdays, payments
 *   Compare      two days, two periods, two machines or two categories, side by side
 *   A machine or a category opens as its own page (#analytics/machine/…, #analytics/category/…).
 *
 * Whole days only (up to yesterday); the period is compared with the same days of the week, whole weeks earlier. A day
 * Televend was not read is said, never counted as zero. Every figure comes from the server; this page only draws it.
 */

const VIEW_LABEL: Record<AnalyticsView, string> = { machines: "Overview", categories: "Categories", trends: "Trends", compare: "Compare" };
const TIERS: Tier[] = ["top", "average", "below", "no_sales"];
const ACCENT = "var(--color-mark-accent)";
const BASE = "var(--color-mark-base)";
/** How many machines the list and the chart show before "All". UNVERIFIED: enough for a first look (A-T75.3). */
const FIRST = 15;

export type AnalyticsPage = { kind: "machine"; key: string } | { kind: "category"; name: string } | null;

interface Filter {
  tier: Tier | null;
  assetNos: number[] | null;
  q: string;
}
const NO_FILTER: Filter = { tier: null, assetNos: null, q: "" };

export default function AnalyticsPortal({
  viewer,
  view,
  page,
  onView,
  onMachine,
  onCategory,
  canCorrect,
}: {
  viewer: string;
  view: AnalyticsView;
  /** A machine or a category as its own page; null for the views. */
  page: AnalyticsPage;
  onView: (v: AnalyticsView) => void;
  onMachine: (key: string) => void;
  onCategory: (name: string) => void;
  liveTick: number;
  /** machines.manage — the Ops Head, the CEO, an Admin. The server checks it again. */
  canCorrect: boolean;
}) {
  const yesterday = addDays(dubaiDay(0), -1);
  const [range, setRange] = useState({ from: addDays(yesterday, -6), to: yesterday });
  const [chosen, setChosen] = useState<string[] | null>(null);
  const settled = useSettled(chosen, 250);
  const settledKey = JSON.stringify(settled);
  const [perf, setPerf] = useState<Performance | null>(null);
  const [profile, setProfile] = useState<SalesProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(0);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [correcting, setCorrecting] = useState<MachinePerf | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [compareStart, setCompareStart] = useState<CompareStart | null>(null);

  const onPage = page !== null;
  const needsProfile = view === "machines" || view === "trends";
  const none = settled !== null && settled.length === 0;
  // Whole days do not change minute by minute, so nothing reloads on a live update — only when the days or the categories
  // change, after a correction, or on Refresh. A machine's or a category's page loads its own.
  useEffect(() => {
    if (onPage || none) return;
    let live = true;
    setBusy(true);
    const cats: string[] | null = JSON.parse(settledKey) as string[] | null;
    Promise.all([
      analytics.performance(viewer, range.from, range.to, view === "compare" ? null : cats),
      needsProfile ? analytics.profile(viewer, range.from, range.to, { scope: "selection", categories: cats }) : Promise.resolve(null),
    ])
      .then(
        ([p, q]) => {
          if (!live) return;
          setPerf(p);
          if (q) setProfile(q);
          setErr(null);
        },
        (e) => live && setErr(errorText(e)),
      )
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [viewer, range.from, range.to, settledKey, onPage, none, needsProfile, view, again]);

  const showMachines = (assetNos: number[]) => {
    const one = assetNos.length === 1 ? perf?.machines.find((m) => m.assetNo === assetNos[0]) : undefined;
    if (one) return onMachine(one.key);
    setFilter({ ...NO_FILTER, assetNos });
    onView("machines");
    scrollTo("analytics-machines");
  };
  const toTrends = (id: string) => {
    onView("trends");
    scrollTo(id);
  };
  const compareWith = (start: CompareStart) => {
    setCompareStart(start);
    onView("compare");
  };
  // The chips show every category there is; while a page of one machine or one category is open they step aside.
  const available = perf?.selection.available ?? [];
  // A page's answer to "is this the data for what is on screen?": hold the last render, dimmed, while counting again.
  const stale = busy || JSON.stringify(chosen) !== settledKey;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Analytics</h2>
          <p className="text-sm text-mut">Which machines and which places sell — against the average, day by day.</p>
        </div>
        <div className="flex flex-wrap rounded-xl border border-edge bg-sunken p-0.5" role="tablist" aria-label="Analytics views">
          {ANALYTICS_VIEWS.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={!onPage && view === v}
              onClick={() => onView(v)}
              className={`min-h-10 rounded-lg px-3 py-1.5 text-sm ${!onPage && view === v ? "bg-panel font-semibold text-ink shadow-sm" : "text-mut hover:text-ink"}`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>

      <HowToRead />

      <section aria-label="Filters" className="space-y-3 rounded-xl border border-edge bg-panel p-3">
        <RangePicker
          range={range}
          yesterday={yesterday}
          first={perf?.coverage.mirroredFrom ?? null}
          shiftDays={perf && perf.period.from === range.from && perf.period.to === range.to ? perf.before.shiftDays : null}
          onRange={setRange}
          onRefresh={() => setAgain((n) => n + 1)}
          busy={busy}
        />
        {!onPage ? <CategoryChips available={available} chosen={chosen} onChange={setChosen} /> : null}
      </section>

      {flash ? (
        <p role="status" className="rounded-xl border border-ok/40 bg-ok/10 p-3 font-semibold text-ok">
          {flash}
        </p>
      ) : null}

      {page?.kind === "machine" ? (
        <MachinePage
          viewer={viewer}
          machineKey={page.key}
          range={range}
          onBack={() => history.back()}
          onCategory={onCategory}
          onCompare={(key) => compareWith({ mode: "machines", a: key })}
        />
      ) : page?.kind === "category" ? (
        <CategoryPage
          viewer={viewer}
          category={page.name}
          range={range}
          onBack={() => history.back()}
          onMachine={onMachine}
          onCompare={(name) => compareWith({ mode: "categories", a: name })}
        />
      ) : view === "compare" ? (
        <ComparePage viewer={viewer} range={range} yesterday={yesterday} chosen={settled} start={compareStart} onMachine={onMachine} onCategory={onCategory} />
      ) : (
        <>
          {err ? <Problem text={err} /> : null}
          {none ? <Empty>No category is chosen. Press a category above — or All.</Empty> : null}
          {!perf && !err && !none ? <Spinner label="Counting every sale…" /> : null}
          {perf && !none ? (
            <div className={`space-y-4 transition-opacity ${stale ? "opacity-60" : ""}`} aria-busy={stale}>
              <Coverage {...perf.coverage} before={perf.before} />
              {perf.coverage.read.length === 0 ? (
                <Empty>No day of this period was read from Televend. Choose days from {perf.coverage.mirroredFrom ? dayLabel(perf.coverage.mirroredFrom) : "the first day read"} on.</Empty>
              ) : view === "categories" ? (
                <CategoriesView perf={perf} onCategory={onCategory} />
              ) : view === "trends" ? (
                profile ? <TrendsView profile={profile} /> : <Spinner label="Counting every day…" />
              ) : (
                <Overview
                  perf={perf}
                  profile={profile}
                  filter={filter}
                  onFilter={setFilter}
                  onMachine={onMachine}
                  onShow={showMachines}
                  onTrends={toTrends}
                  onCategories={() => onView("categories")}
                  canCorrect={canCorrect}
                  onCorrect={setCorrecting}
                />
              )}
            </div>
          ) : null}
        </>
      )}

      {correcting ? (
        <CorrectSheet
          viewer={viewer}
          machine={correcting}
          onClose={() => setCorrecting(null)}
          onDone={(msg) => {
            setCorrecting(null);
            setFlash(msg);
            setTimeout(() => setFlash(null), 6_000);
            setAgain((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

// ── the overview ────────────────────────────────────────────────────────────
/** The sentences of the machines (most urgent first), then the days' — the same trend said once. */
function mergeInsights(perf: Performance, profile: SalesProfile | null): Insight[] {
  const said = new Set(["trend", "cash_share"]);
  const urgent = perf.insights.filter((i) => i.tone === "bad");
  const rest = perf.insights.filter((i) => i.tone !== "bad");
  const days = (profile?.insights ?? []).filter((i) => !said.has(i.id));
  return [...urgent, ...days.filter((i) => i.id === "last_day"), ...rest, ...days.filter((i) => i.id !== "last_day")];
}

function Overview({
  perf,
  profile,
  filter,
  onFilter,
  onMachine,
  onShow,
  onTrends,
  onCategories,
  canCorrect,
  onCorrect,
}: {
  perf: Performance;
  profile: SalesProfile | null;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onMachine: (key: string) => void;
  onShow: (assetNos: number[]) => void;
  onTrends: (sectionId: string) => void;
  onCategories: () => void;
  canCorrect: boolean;
  onCorrect: (m: MachinePerf) => void;
}) {
  const f = perf.fleet;
  const t = profile?.totals ?? null;
  const cash = f.cashCompare;
  const before = beforeWords(perf.before.shiftDays);
  return (
    <>
      <section aria-label="Key figures" className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Cups sold"
          value={f.cups.toLocaleString("en-GB")}
          line={
            f.compare ? (
              <>
                <Change pct={f.compare.changePct} /> <span className="text-mut">a day, vs {before}</span>
              </>
            ) : (
              <span className="text-mut">no comparison</span>
            )
          }
          onOpen={() => onTrends("trends-days")}
          opens="each day"
        />
        <Tile
          label={t?.lastDay ? `Last day · ${dayLabel(t.lastDay.date)}` : "Last day"}
          value={t?.lastDay ? t.lastDay.cups.toLocaleString("en-GB") : "—"}
          line={
            t?.lastDay ? (
              <>
                <Change pct={t.lastDay.changePct} /> <span className="text-mut">vs {dayLabel(t.lastDay.lastWeek.date)}</span>
              </>
            ) : (
              <span className="text-mut">—</span>
            )
          }
          onOpen={() => onTrends("trends-days")}
          opens="each day against the same weekday a week before"
        />
        <Tile
          label="Income (estimate)"
          value={aedRound(f.incomeFils)}
          line={
            <span className="text-mut">
              {t?.incomePerDayFils !== null && t?.incomePerDayFils !== undefined ? `${aedRound(t.incomePerDayFils)} a day` : ""}
              {t?.avgPriceFils ? ` · ${aedPrice(t.avgPriceFils)} per paid cup` : ""}
            </span>
          }
          onOpen={() => onTrends("trends-income")}
          opens="income each day"
        />
        <Tile
          label="Paid in cash"
          value={f.cashShare === null ? "—" : `${n1(f.cashShare)} %`}
          line={
            cash ? (
              <span className="text-mut">
                was {n1(cash.before)} % {before}
              </span>
            ) : (
              <span className="text-mut">no comparison</span>
            )
          }
          onOpen={() => onTrends("trends-payments")}
          opens="how people paid"
        />
        <Tile
          label="Machines that sold"
          value={`${f.selling} of ${f.machines}`}
          line={<span className="text-mut">{f.top80} of them sell 80 % of the cups</span>}
          onOpen={() => scrollTo("analytics-machines")}
          opens="the machines"
        />
        <Tile
          label="Average machine, cups a day"
          value={f.cupsPerMachineDay === null ? "—" : n1(f.cupsPerMachineDay)}
          line={<span className="text-mut">was {f.before.cupsPerMachineDay === null ? "—" : n1(f.before.cupsPerMachineDay)} {before}</span>}
          onOpen={onCategories}
          opens="the categories"
        />
      </section>

      <InsightList insights={mergeInsights(perf, profile)} onShow={onShow} />

      {profile ? (
        <Section
          title="Cups each day — against the same weekday a week before"
          hint="Blue: each day. Gray: the same weekday a week earlier. The boxes under the chart give each day's change."
          right={
            <button onClick={() => onTrends("trends-days")} className="min-h-9 rounded-lg border border-edge px-2 text-xs font-semibold hover:border-link">
              All the trends →
            </button>
          }
        >
          <DailyComparison tall points={profile.days.map((d) => ({ date: d.date, now: d.cups, before: d.lastWeek.cups, pct: d.changePct }))} names={{ now: "That day", before: "Same weekday a week before" }} unit="cups" />
          <DayChanges days={profile.days} />
        </Section>
      ) : null}

      <MachinesSection perf={perf} filter={filter} onFilter={onFilter} onMachine={onMachine} canCorrect={canCorrect} onCorrect={onCorrect} />
    </>
  );
}

function MachinesSection({
  perf,
  filter,
  onFilter,
  onMachine,
  canCorrect,
  onCorrect,
}: {
  perf: Performance;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onMachine: (key: string) => void;
  canCorrect: boolean;
  onCorrect: (m: MachinePerf) => void;
}) {
  const [all, setAll] = useState(false);
  const f = perf.fleet;
  // The server's ranking; machines that sold nothing after them, by number.
  const counted = useMemo(
    () => perf.machines.filter((m) => m.counted).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.assetNo ?? 1e9) - (b.assetNo ?? 1e9) || a.key.localeCompare(b.key)),
    [perf],
  );
  const q = filter.q.trim().toLowerCase();
  const shown = counted.filter(
    (m) =>
      (!filter.tier || m.tier === filter.tier) &&
      (!filter.assetNos || (m.assetNo !== null && filter.assetNos.includes(m.assetNo))) &&
      (!q || m.label.toLowerCase().includes(q) || String(m.assetNo ?? "").includes(q) || m.category.toLowerCase().includes(q)),
  );
  const notCounted = perf.machines.filter((m) => !m.counted);
  const filtered = filter.tier !== null || filter.assetNos !== null || q !== "";
  const listed = all ? shown : shown.slice(0, FIRST);
  const charted = shown.filter((m) => m.cups > 0);
  const drawn = all ? charted : charted.slice(0, Math.max(FIRST, listed.length));
  const before = beforeWords(perf.before.shiftDays);

  return (
    <section id="analytics-machines" aria-label="Machines" className="scroll-mt-20 space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4" role="group" aria-label="Tiers">
        {TIERS.map((t) => {
          const s = f.tiers[t];
          const on = filter.tier === t;
          return (
            <button
              key={t}
              onClick={() => onFilter({ ...filter, tier: on ? null : t, assetNos: null })}
              aria-pressed={on}
              className={`min-h-20 rounded-xl border p-3 text-left ${on ? "border-link bg-sunken" : "border-edge bg-panel hover:border-link"}`}
            >
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <span aria-hidden="true" className="inline-block size-2.5 rounded-sm" style={{ background: TIER_COLOR[t] }} />
                {TIER_WORDS[t]}
              </div>
              <div className="text-2xl font-bold">{s.machines}</div>
              <div className="text-xs text-mut">{t === "no_sales" ? "machines sold nothing" : `machines · ${n1(s.cupsShare)} % of the cups`}</div>
              {s.machines > 0 || on ? (
                <div className={`mt-1 text-xs font-semibold ${on ? "text-ink" : "text-link"}`}>{on ? "Listed below · tap again for all" : "List them →"}</div>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-mut">
        How the groups are made: the average machine{perf.selection.categories ? " of the chosen categories" : ""} sells{" "}
        {f.cupsPerMachineDay === null ? "—" : n1(f.cupsPerMachineDay)} cups a day (machines that sold nothing are not in the average).
        {f.thresholds
          ? ` Top sells 25 % or more above it (${n1(f.thresholds.top)} or more); Below average sells 25 % or more below it (under ${n1(f.thresholds.below)}); About average is in between.`
          : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filter.q}
          onChange={(e) => onFilter({ ...filter, q: e.target.value, assetNos: null })}
          placeholder="Find a machine — name, number or category"
          aria-label="Find a machine"
          className="h-11 min-w-0 flex-1 rounded-xl border border-edge bg-sunken px-3 text-sm"
        />
        {filtered ? (
          <button onClick={() => onFilter(NO_FILTER)} className="min-h-11 rounded-xl border border-edge px-3 text-sm">
            Show all {counted.length}
          </button>
        ) : null}
      </div>
      <p className="text-sm text-mut" role="status">
        {shown.length} of {counted.length} machines
        {filter.tier ? ` — ${TIER_WORDS[filter.tier].toLowerCase()}` : ""}
        {filter.assetNos ? " — the ones named above" : ""}
      </p>

      {/* The answer to a tier button is the table right under it; the chart of the same machines follows. */}
      <div className="space-y-4">
        <div className="min-w-0 space-y-2">
          <DataTable rows={listed} rowKey={(m) => m.key} columns={machineColumns(onMachine, canCorrect, onCorrect, before, f.top80)} empty="No machine matches." />
          {shown.length > FIRST ? (
            <button onClick={() => setAll(!all)} className="min-h-10 w-full rounded-xl border border-edge text-sm font-semibold hover:border-link">
              {all ? `The first ${FIRST}` : `All ${shown.length} machines`}
            </button>
          ) : null}
        </div>
        {f.cupsPerMachineDay !== null && charted.length > 0 ? (
          <Section
            title={
              drawn.length === charted.length
                ? `Cups a day — ${filtered ? `the ${drawn.length} machines listed` : `all ${drawn.length} machines that sold`}`
                : `Cups a day — the first ${drawn.length} of ${charted.length} machines that sold`
            }
            hint={drawn.length === charted.length ? "One bar per machine, coloured by its group. Tap a bar to open the machine." : `One bar per machine, coloured by its group. Press "All ${shown.length} machines" above to draw every one. Tap a bar to open the machine.`}
          >
            <RankedMachines machines={drawn} average={f.cupsPerMachineDay} thresholds={f.thresholds} onPick={(m) => onMachine(m.key)} beforeLabel={`vs ${before}`} />
          </Section>
        ) : null}
      </div>

      {notCounted.length > 0 ? (
        <details className="rounded-xl border border-edge bg-panel p-3">
          <summary className="min-h-10 cursor-pointer text-sm font-semibold">
            Left out of every figure · {notCounted.length} machine{notCounted.length === 1 ? "" : "s"}
          </summary>
          <p className="mt-1 text-xs text-mut">
            Marked "{NOT_COUNTED}" — a test machine, or one not open to the public. Its cups are in no number on this page.
          </p>
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
    </section>
  );
}

/**
 * The machines as a table — one line each on a wide screen, a card each on a phone (DataTable). The name opens the
 * machine's own page.
 */
function machineColumns(
  onMachine: (key: string) => void,
  canCorrect: boolean,
  onCorrect: (m: MachinePerf) => void,
  before: string,
  keyMachines: number,
): Column<MachinePerf>[] {
  return [
    {
      head: "Machine",
      cell: (m) => (
        <div className="min-w-0">
          <button onClick={() => onMachine(m.key)} className="min-h-8 text-left font-semibold text-link hover:underline">
            {m.rank ? <span className="mr-1 text-mut">#{m.rank}</span> : null}
            {m.label}
          </button>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-mut">
            {m.assetNo ? <span>{m.assetNo}</span> : null}
            <span>
              · {m.category}
              {m.corrected ? <span title={`Televend: ${m.televendRegion ?? "no region"}`}> (corrected)</span> : null}
            </span>
            {m.cardOnly ? <Pill tone="mut">Card only</Pill> : null}
            {m.inTop80 ? (
              <span title={`One of the ${keyMachines} machines that together sell 80 % of the cups`}>
                <Pill tone="ok">{KEY_MACHINE}</Pill>
              </span>
            ) : null}
            {m.disabledNow ? <Pill tone="warn">Off in Televend now</Pill> : null}
          </div>
        </div>
      ),
    },
    { head: "Group", cell: (m) => <TierBadge tier={m.tier} />, tight: true },
    { head: "Cups a day", cell: (m) => <span className="whitespace-nowrap tabular-nums">{m.cupsPerDay === null ? "—" : n1(m.cupsPerDay)}</span>, tight: true },
    { head: "vs average", cell: (m) => <span className="whitespace-nowrap tabular-nums">{vsAverageText(m.vsAverage)}</span>, tight: true },
    { head: `vs ${before}`, cell: (m) => <span className="whitespace-nowrap"><Change pct={m.changePct} /></span>, tight: true },
    { head: "Income (estimate)", cell: (m) => <span className="whitespace-nowrap tabular-nums">{aedRound(m.incomeFils)}</span>, tight: true },
    { head: "Paid in cash", cell: (m) => <span className="whitespace-nowrap tabular-nums">{m.cashShare === null ? "—" : `${n1(m.cashShare)} %`}</span>, tight: true },
    ...(canCorrect
      ? [
          {
            head: "",
            cell: (m: MachinePerf) => (
              <button
                onClick={() => onCorrect(m)}
                aria-label={`Change the category of ${m.label}`}
                title="Change the category it is counted under"
                className="min-h-8 whitespace-nowrap rounded-md px-2 text-xs text-mut hover:bg-sunken hover:text-ink"
              >
                ✎ Category
              </button>
            ),
          },
        ]
      : []),
  ];
}

// ── categories ──────────────────────────────────────────────────────────────
function CategoriesView({ perf, onCategory }: { perf: Performance; onCategory: (name: string) => void }) {
  const f = perf.fleet;
  const rows = perf.categories.filter((c) => c.cupsPerMachineDay !== null || c.before.cupsPerMachineDay !== null);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          title={`Cups per machine a day — these days against ${beforeWords(perf.before.shiftDays)}`}
          hint="Per machine, so a category with many machines and one with a few compare fairly. The solid line is the average machine. Tap a bar to open the category."
        >
          <PairBars
            rows={rows.map((c) => ({ key: c.category, name: c.selling === 1 ? `${c.category} (1 machine)` : c.category, a: c.cupsPerMachineDay, b: c.before.cupsPerMachineDay }))}
            names={{ a: "These days", b: beforeWords(perf.before.shiftDays).replace(/^the /, "The ") }}
            colors={{ a: ACCENT, b: BASE }}
            unit="cups per machine a day"
            reference={f.cupsPerMachineDay !== null ? { value: f.cupsPerMachineDay, label: `average machine ${n1(f.cupsPerMachineDay)}` } : null}
            onPick={onCategory}
          />
        </Section>
        <Section title="Share of all the cups" hint="Where the cups come from: each category's part of all cups sold. Tap a bar to open the category.">
          <ValueBars rows={perf.categories.map((c) => ({ key: c.category, name: c.category, value: c.share }))} unit="% of the cups" format={(n) => `${n1(n)} %`} onPick={onCategory} />
        </Section>
      </div>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {perf.categories.map((c) => (
          <li key={c.category}>
            <button onClick={() => onCategory(c.category)} className="group h-full w-full space-y-2 rounded-xl border border-edge bg-panel p-4 text-left hover:border-link">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-bold">{c.category}</h3>
                <span className="shrink-0 text-xs font-semibold text-link group-hover:underline">Open →</span>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-2xl font-bold">{c.cupsPerMachineDay === null ? "—" : n1(c.cupsPerMachineDay)}</span>
                <span className="text-xs text-mut">cups per machine a day</span>
              </div>
              <div className="text-xs">
                <Change pct={c.changePct} />{" "}
                <span className="text-mut">
                  cups a day vs {beforeWords(perf.before.shiftDays)}
                  {c.compare ? ` (${n1(c.compare.now)}, was ${n1(c.compare.before)})` : ""}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <Fig label="Machines" value={`${c.selling} of ${c.machines} sold`} />
                <Fig label="Share of cups" value={`${n1(c.share)} %`} />
                <Fig label="Income (estimate)" value={aedRound(c.incomeFils)} />
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
                </p>
              ) : null}
              {c.noSales > 0 ? <p className="text-xs text-crit">{c.noSales} sold nothing</p> : null}
              {perf.period.days >= 3 ? (
                <div>
                  <p className="text-[11px] text-mut">Cups per machine each day — blue these days, gray the same weekday {earlierWords(perf.before.shiftDays)}</p>
                  <DailyComparison
                    compact
                    points={c.daily.map((x) => ({ date: x.date, now: x.cupsPerMachine, before: x.before }))}
                    names={{ now: "These days", before: beforeWords(perf.before.shiftDays).replace(/^the /, "The ") }}
                    unit="cups per machine"
                  />
                </div>
              ) : null}
            </button>
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
