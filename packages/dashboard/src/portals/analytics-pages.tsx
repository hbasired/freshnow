import { useEffect, useState } from "react";
import { Icon } from "../components/icons";
import { Empty, Pill, Spinner } from "../components/ui";
import { ColumnBars, DailyComparison, PairBars, RankedMachines, TwoLines } from "../components/charts/analytics-charts";
import {
  PAYMENT_WORDS,
  aedPrice,
  aedRound,
  analytics,
  dayLabel,
  hourLabel,
  n1,
  type MachinePerf,
  type SalesProfile,
} from "../lib/analytics-api";
import { Problem, errorText } from "./inv-ui";
import { BackBar, Change, Coverage, Fig, InsightList, Section, TierBadge, Tile, scrollTo } from "./analytics-ui";

/**
 * The pages behind the Analytics buttons (TASK-075) — the user: "the machines and charts in the analytics page are small and
 * not complete can you make them buttons and then it opens new page and the graphs and other analysis are shown visually and
 * with charts. And also last week same day percentage difference should also be mentioned."
 *
 *   Trends     the categories chosen: every day beside the same weekday a week before, income, hours, weekdays, payments
 *   Machine    one machine: the same, with where it stands against the fleet average
 *   Category   one category: the same, with its machines against the fleet average
 *
 * Emphasis pair throughout (accent = these days, gray = before), so blue always means "now" on these pages.
 */

const ACCENT = "var(--color-mark-accent)";
const BASE = "var(--color-mark-base)";
const short = (d: string) => dayLabel(d).replace(/^(\w+) (\d+) \w+$/, "$1 $2");

/** Each day's % against the same weekday a week before, readable without hovering — the last 31 days of the range. */
function DayChanges({ days }: { days: SalesProfile["days"] }) {
  const shown = days.slice(-31);
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs text-mut">
        Each day against the same weekday a week before{days.length > shown.length ? ` — the last ${shown.length} days` : ""}:
      </p>
      <ul className="flex gap-1.5 overflow-x-auto pb-1">
        {shown.map((d) => (
          <li key={d.date} className="min-w-[4.75rem] shrink-0 rounded-lg border border-edge px-2 py-1 text-xs">
            <div className="text-mut">{short(d.date)}</div>
            <div className="font-semibold tabular-nums">{d.cups === null ? "not read" : d.cups.toLocaleString("en-GB")}</div>
            <div>{d.cups === null ? <span className="text-mut">—</span> : <Change pct={d.changePct} />}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A profile's key figures; each opens (scrolls to) the chart that explains it. */
function ProfileTiles({ p, idPrefix }: { p: SalesProfile; idPrefix: string }) {
  const t = p.totals;
  const cash = p.payments.find((x) => x.kind === "cash")!;
  return (
    <section aria-label="Key figures" className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      <Tile
        label="Cups a day"
        value={t.cupsPerDay === null ? "—" : n1(t.cupsPerDay)}
        line={
          <>
            <Change pct={t.compare?.changePct ?? null} /> <span className="text-mut">on the same days before</span>
          </>
        }
        onOpen={() => scrollTo(`${idPrefix}-days`)}
        opens="each day"
      />
      <Tile
        label={t.lastDay ? `Last day · ${dayLabel(t.lastDay.date)}` : "Last day"}
        value={t.lastDay ? t.lastDay.cups.toLocaleString("en-GB") : "—"}
        line={
          t.lastDay ? (
            <>
              <Change pct={t.lastDay.changePct} /> <span className="text-mut">on {dayLabel(t.lastDay.lastWeek.date)}</span>
            </>
          ) : (
            <span className="text-mut">no day read</span>
          )
        }
        onOpen={() => scrollTo(`${idPrefix}-days`)}
        opens="each day against the same weekday a week before"
      />
      <Tile
        label="Income a day (est.)"
        value={t.incomePerDayFils === null ? "—" : aedRound(t.incomePerDayFils)}
        line={
          <>
            <Change pct={t.incomeCompare?.changePct ?? null} /> <span className="text-mut">· {aedRound(t.incomeFils)} in all</span>
          </>
        }
        onOpen={() => scrollTo(`${idPrefix}-income`)}
        opens="income each day"
      />
      <Tile
        label="Per paid cup (est.)"
        value={t.avgPriceFils === null ? "—" : aedPrice(t.avgPriceFils)}
        line={<span className="text-mut">income ÷ {t.paidCups.toLocaleString("en-GB")} paid cups</span>}
        onOpen={() => scrollTo(`${idPrefix}-income`)}
        opens="income each day"
      />
      <Tile
        label="Paid in cash"
        value={t.cashShare === null ? "—" : `${n1(t.cashShare)} %`}
        line={<span className="text-mut">before {cash.beforeShare === null ? "—" : `${n1(cash.beforeShare)} %`}</span>}
        onOpen={() => scrollTo(`${idPrefix}-payments`)}
        opens="how people paid"
      />
      <Tile
        label="Busiest hour"
        value={t.peak ? hourLabel(t.peak.hour) : "—"}
        line={<span className="text-mut">{t.peak ? `${n1(t.peak.share)} % of the cups` : "no sales"}</span>}
        onOpen={() => scrollTo(`${idPrefix}-hours`)}
        opens="the hours of the day"
      />
    </section>
  );
}

/** The charts every profile has. */
export function ProfileSections({ p, idPrefix }: { p: SalesProfile; idPrefix: string }) {
  const paid = p.payments.filter((x) => x.now > 0 || x.before > 0);
  return (
    <>
      <Section
        id={`${idPrefix}-days`}
        title="Cups each day — against the same weekday a week before"
        hint="Blue: that day. Gray: the same weekday 7 days earlier. Hover a day for its % difference; a day not read is a gap, never a zero."
      >
        <DailyComparison tall points={p.days.map((d) => ({ date: d.date, now: d.cups, before: d.lastWeek.cups, pct: d.changePct }))} names={{ now: "That day", before: "Same weekday a week before" }} unit="cups" />
        <DayChanges days={p.days} />
      </Section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section id={`${idPrefix}-income`} title="Income each day, AED (estimated)" hint="Cash cups at the cash price, other paid cups at the price in the machine's name; token cups are not paid.">
          <ColumnBars
            points={p.days.map((d) => ({ key: d.date, label: short(d.date), value: d.incomeFils === null ? null : Math.round(d.incomeFils / 100) }))}
            unit="AED (est.)"
            format={(n) => `AED ${Math.round(n).toLocaleString("en-GB")}`}
            axisFormat={(n) => (n >= 1000 ? `${n1(n / 1000)}k` : String(Math.round(n)))}
          />
        </Section>
        <Section id={`${idPrefix}-hours`} title="Hours of the day" hint={`Cups at each hour, per day read — these days against the same days ${p.before.shiftDays} days earlier.`}>
          <TwoLines axis="hour" emphasis points={p.hours.map((h) => ({ x: h.hour, a: h.now, b: h.before }))} names={{ a: "These days", b: `${p.before.shiftDays} days earlier` }} colors={{ a: ACCENT, b: BASE }} unit="cups a day" />
        </Section>
        {p.period.days >= 7 ? (
          <Section id={`${idPrefix}-weekdays`} title="Days of the week" hint="Cups on an average day of each weekday in the period (only the days read).">
            <ColumnBars points={p.weekdays.map((w) => ({ key: String(w.dow), label: w.label, value: w.cupsPerDay }))} unit="cups a day" tableHead="Weekday" />
          </Section>
        ) : null}
        <Section id={`${idPrefix}-payments`} title="How people paid" hint="Share of the cups — these days against the days before.">
          {paid.length > 0 ? (
            <PairBars
              rows={paid.map((x) => ({ key: x.kind, name: PAYMENT_WORDS[x.kind], a: x.nowShare, b: x.beforeShare }))}
              names={{ a: "These days", b: "Before" }}
              colors={{ a: ACCENT, b: BASE }}
              unit="% of cups"
              format={(n) => `${n1(n)} %`}
            />
          ) : (
            <Empty>No sales to split.</Empty>
          )}
        </Section>
      </div>
    </>
  );
}

/** The categories chosen, over the days: the trends behind the Overview's tiles. */
export function TrendsView({ profile }: { profile: SalesProfile }) {
  return (
    <div className="space-y-4">
      <ProfileTiles p={profile} idPrefix="trends" />
      <InsightList insights={profile.insights} title="In short" />
      <ProfileSections p={profile} idPrefix="trends" />
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; err: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setErr(null);
    load().then(
      (d) => live && setData(d),
      (e) => live && setErr(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, deps);
  return { data, err };
}

/** One machine as a page: its days, hours, weekdays, payments and where it stands against the fleet. */
export function MachinePage({
  viewer,
  machineKey,
  range,
  onBack,
  onCategory,
  onCompare,
}: {
  viewer: string;
  /** MachinePerf.key: FreshNow's machine id, or "tv:<record>". */
  machineKey: string;
  range: { from: string; to: string };
  onBack: () => void;
  onCategory: (name: string) => void;
  onCompare: (key: string) => void;
}) {
  const machine = machineKey.startsWith("tv:") ? machineKey.slice(3) : machineKey;
  const { data, err } = useLoad(
    () => Promise.all([analytics.performance(viewer, range.from, range.to), analytics.profile(viewer, range.from, range.to, { scope: "machine", machine })]),
    [viewer, machine, range.from, range.to],
  );
  const back = <BackBar label="Analytics" onBack={onBack} />;
  if (err) return <div className="space-y-3">{back}<Problem text={err} /></div>;
  if (!data) return <div className="space-y-3">{back}<Spinner label="Counting its sales…" /></div>;
  const [perf, p] = data;
  const m: MachinePerf | undefined = perf.machines.find((x) => x.key === machineKey);
  return (
    <div className="space-y-4">
      <BackBar
        label="Analytics"
        onBack={onBack}
        right={
          <div className="flex flex-wrap gap-2">
            {p.scope.assetNo !== null ? (
              <a href={`#operations/machine/${p.scope.assetNo}`} className="inline-flex min-h-10 items-center rounded-xl border border-edge px-3 text-sm hover:border-link">
                Open in Operations
              </a>
            ) : null}
            <button onClick={() => onCompare(machineKey)} className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-link px-3 text-sm font-semibold">
              Compare with another machine <Icon.arrowRight size={16} />
            </button>
          </div>
        }
      />
      <header className="space-y-1">
        <h2 className="text-xl font-bold tracking-tight">
          {m?.label ?? p.scope.label}
          {p.scope.assetNo !== null ? <span className="font-normal text-mut"> · {p.scope.assetNo}</span> : null}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {m ? (
            <button onClick={() => onCategory(m.category)} className="min-h-9 rounded-lg border border-edge px-2 hover:border-link">
              {m.category}
            </button>
          ) : null}
          {m ? <TierBadge tier={m.tier} /> : null}
          {m && m.counted && m.vsAverage !== null ? (
            <span className="font-semibold">
              {Math.round(m.vsAverage * 100)} % of the fleet average
              <span className="font-normal text-mut"> ({perf.fleet.cupsPerMachineDay === null ? "—" : n1(perf.fleet.cupsPerMachineDay)} cups a day)</span>
            </span>
          ) : null}
          {m?.rank ? <span className="text-mut">#{m.rank} of {perf.fleet.selling} that sold</span> : null}
          {m?.cardOnly ? <Pill tone="mut">Card only</Pill> : null}
          {m?.disabledNow ? <Pill tone="warn">Off in Televend now</Pill> : null}
          {m && !m.counted ? <Pill tone="warn">Not counted in the fleet's figures</Pill> : null}
        </div>
      </header>
      <Coverage {...p.coverage} before={p.before} />
      <ProfileTiles p={p} idPrefix="machine" />
      <InsightList insights={p.insights} title="In short" />
      <ProfileSections p={p} idPrefix="machine" />
      {m ? (
        <p className="text-xs text-mut">
          Prices used: cash AED {m.prices.cashFils / 100} ({m.prices.cashSource === "set" ? "set on the machine" : "the default"}), card AED {m.prices.cardFils / 100} (
          {m.prices.cardSource === "name" ? "from its name" : "the cash price"}). The income is an estimate until Televend's amounts arrive.
        </p>
      ) : null}
    </div>
  );
}

/** One category as a page: its days, hours, payments and its machines against the fleet average. */
export function CategoryPage({
  viewer,
  category,
  range,
  onBack,
  onMachine,
  onCompare,
}: {
  viewer: string;
  category: string;
  range: { from: string; to: string };
  onBack: () => void;
  onMachine: (key: string) => void;
  onCompare: (name: string) => void;
}) {
  const { data, err } = useLoad(
    () => Promise.all([analytics.performance(viewer, range.from, range.to), analytics.profile(viewer, range.from, range.to, { scope: "category", category })]),
    [viewer, category, range.from, range.to],
  );
  const back = <BackBar label="Analytics" onBack={onBack} />;
  if (err) return <div className="space-y-3">{back}<Problem text={err} /></div>;
  if (!data) return <div className="space-y-3">{back}<Spinner label="Counting its machines…" /></div>;
  const [perf, p] = data;
  const c = perf.categories.find((x) => x.category === category);
  const ms = perf.machines
    .filter((m) => m.counted && m.category === category && (!m.disabledNow || m.cups > 0))
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.assetNo ?? 1e9) - (b.assetNo ?? 1e9));
  return (
    <div className="space-y-4">
      <BackBar
        label="Analytics"
        onBack={onBack}
        right={
          <button onClick={() => onCompare(category)} className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-link px-3 text-sm font-semibold">
            Compare with another category <Icon.arrowRight size={16} />
          </button>
        }
      />
      <header>
        <h2 className="text-xl font-bold tracking-tight">{category}</h2>
        <p className="text-sm text-mut">
          {c ? (
            <>
              {c.selling} of {c.machines} machines sold · {n1(c.share)} % of all cups ·{" "}
              <span className="font-semibold text-ink">{c.cupsPerMachineDay === null ? "—" : n1(c.cupsPerMachineDay)} cups per machine a day</span> (the fleet:{" "}
              {perf.fleet.cupsPerMachineDay === null ? "—" : n1(perf.fleet.cupsPerMachineDay)})
            </>
          ) : (
            `${p.scope.machines} machines`
          )}
        </p>
      </header>
      <Coverage {...p.coverage} before={p.before} />
      <ProfileTiles p={p} idPrefix="category" />
      <InsightList insights={p.insights} title="In short" />
      <ProfileSections p={p} idPrefix="category" />
      {perf.fleet.cupsPerMachineDay !== null && ms.some((m) => m.cups > 0) ? (
        <Section title="Its machines against the fleet average" hint="Cups a day, one bar each. The line is the fleet average; dashed: 75 % and 125 % of it. Tap a bar to open the machine.">
          <RankedMachines machines={ms} average={perf.fleet.cupsPerMachineDay} thresholds={perf.fleet.thresholds} onPick={(m) => onMachine(m.key)} />
        </Section>
      ) : null}
      <Section title={`Machines · ${ms.length}`}>
        {ms.length === 0 ? <Empty>No machine of this category in these days.</Empty> : null}
        <ul className="divide-y divide-edge">
          {ms.map((m) => (
            <li key={m.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <button onClick={() => onMachine(m.key)} className="min-h-10 min-w-0 text-left font-semibold text-link hover:underline">
                {m.rank ? <span className="mr-1 text-mut">#{m.rank}</span> : null}
                {m.label}
                {m.assetNo ? <span className="font-normal text-mut"> · {m.assetNo}</span> : null}
              </button>
              <dl className="grid grid-cols-4 gap-x-4 text-sm">
                <Fig label="Cups a day" value={m.cupsPerDay === null ? "—" : n1(m.cupsPerDay)} />
                <Fig label="Tier" value={<TierBadge tier={m.tier} />} />
                <Fig label="Before" value={<Change pct={m.changePct} />} />
                <Fig label="Income" value={aedRound(m.incomeFils)} />
              </dl>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

