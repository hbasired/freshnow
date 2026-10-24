import { useEffect, useState } from "react";
import { Icon } from "../components/icons";
import { DataTable, Empty, Pill, Spinner } from "../components/ui";
import { ColumnBars, DailyComparison, PairBars, RankedMachines, TwoLines } from "../components/charts/analytics-charts";
import {
  KEY_MACHINE,
  PAYMENT_HELP,
  PAYMENT_WORDS,
  aedPrice,
  aedRound,
  analytics,
  beforeWords,
  dayLabel,
  hourLabel,
  n1,
  vsAverageText,
  type MachinePerf,
  type SalesProfile,
} from "../lib/analytics-api";
import { Problem, errorText } from "./inv-ui";
import { BackBar, Change, Coverage, InsightList, Section, TierBadge, Tile, scrollTo } from "./analytics-ui";

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
const ordinal = (n: number): string => {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
};

/** Each day's % against the same weekday a week before, readable without hovering — the last 31 days of the range. */
export function DayChanges({ days }: { days: SalesProfile["days"] }) {
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
            <div className="font-semibold tabular-nums">{d.cups === null ? "no data" : d.cups.toLocaleString("en-GB")}</div>
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
  const vs = `vs ${beforeWords(p.before.shiftDays)}`;
  return (
    <section aria-label="Key figures" className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      <Tile
        label="Cups a day"
        value={t.cupsPerDay === null ? "—" : n1(t.cupsPerDay)}
        line={
          <>
            <Change pct={t.compare?.changePct ?? null} /> <span className="text-mut">{vs}</span>
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
              <Change pct={t.lastDay.changePct} /> <span className="text-mut">vs {dayLabel(t.lastDay.lastWeek.date)}</span>
            </>
          ) : (
            <span className="text-mut">no day with data</span>
          )
        }
        onOpen={() => scrollTo(`${idPrefix}-days`)}
        opens="each day against the same weekday a week before"
      />
      <Tile
        label="Income a day (estimate)"
        value={t.incomePerDayFils === null ? "—" : aedRound(t.incomePerDayFils)}
        line={
          <>
            <Change pct={t.incomeCompare?.changePct ?? null} /> <span className="text-mut">{vs} · {aedRound(t.incomeFils)} in all</span>
          </>
        }
        onOpen={() => scrollTo(`${idPrefix}-income`)}
        opens="income each day"
      />
      <Tile
        label="Per paid cup (estimate)"
        value={t.avgPriceFils === null ? "—" : aedPrice(t.avgPriceFils)}
        line={<span className="text-mut">income ÷ {t.paidCups.toLocaleString("en-GB")} paid cups</span>}
        onOpen={() => scrollTo(`${idPrefix}-income`)}
        opens="income each day"
      />
      <Tile
        label="Paid in cash"
        value={t.cashShare === null ? "—" : `${n1(t.cashShare)} %`}
        line={<span className="text-mut">{cash.beforeShare === null ? "nothing to compare with" : `was ${n1(cash.beforeShare)} % ${beforeWords(p.before.shiftDays)}`}</span>}
        onOpen={() => scrollTo(`${idPrefix}-payments`)}
        opens="how people paid"
      />
      <Tile
        label="Busiest hour"
        value={t.peak ? `${hourLabel(t.peak.hour)}–${hourLabel((t.peak.hour + 1) % 24)}` : "—"}
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
        hint="Blue: each day. Gray: the same weekday a week earlier. The boxes under the chart give each day's change; a day without sales data is left blank, never drawn as zero."
      >
        <DailyComparison tall points={p.days.map((d) => ({ date: d.date, now: d.cups, before: d.lastWeek.cups, pct: d.changePct }))} names={{ now: "That day", before: "Same weekday a week before" }} unit="cups" />
        <DayChanges days={p.days} />
      </Section>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          id={`${idPrefix}-income`}
          title="Income each day, AED (estimated)"
          hint="Worked out from the cups sold: cash cups at the cash price, card cups at the price in the machine's name; token cups count as unpaid. Televend's own amounts will replace it."
        >
          <ColumnBars
            points={p.days.map((d) => ({ key: d.date, label: short(d.date), value: d.incomeFils === null ? null : Math.round(d.incomeFils / 100) }))}
            unit="AED (estimate)"
            format={(n) => `AED ${Math.round(n).toLocaleString("en-GB")}`}
            axisFormat={(n) => (n >= 1000 ? `${n1(n / 1000)}k` : String(Math.round(n)))}
          />
        </Section>
        <Section id={`${idPrefix}-hours`} title="Hours of the day — when people buy" hint={`Average cups sold in each hour of a day. Blue: these days; gray: ${beforeWords(p.before.shiftDays)}.`}>
          <TwoLines
            axis="hour"
            emphasis
            points={p.hours.map((h) => ({ x: h.hour, a: h.now, b: h.before }))}
            names={{ a: "These days", b: beforeWords(p.before.shiftDays).replace(/^the /, "The ") }}
            colors={{ a: ACCENT, b: BASE }}
            unit="cups in that hour, a day"
          />
        </Section>
        {p.period.days >= 7 ? (
          <Section id={`${idPrefix}-weekdays`} title="Days of the week — which days sell most" hint="Cups on an average Monday, Tuesday … of these days (days without sales data are left out).">
            <ColumnBars points={p.weekdays.map((w) => ({ key: String(w.dow), label: w.label, value: w.cupsPerDay }))} unit="cups a day" tableHead="Weekday" />
          </Section>
        ) : null}
        <Section id={`${idPrefix}-payments`} title="How people paid" hint={`Share of the cups paid each way. Blue: these days; gray: ${beforeWords(p.before.shiftDays)}. ${PAYMENT_HELP}`}>
          {paid.length > 0 ? (
            <PairBars
              rows={paid.map((x) => ({ key: x.kind, name: PAYMENT_WORDS[x.kind], a: x.nowShare, b: x.beforeShare }))}
              names={{ a: "These days", b: beforeWords(p.before.shiftDays).replace(/^the /, "The ") }}
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
              {vsAverageText(m.vsAverage)} vs the average machine
              <span className="font-normal text-mut"> ({perf.fleet.cupsPerMachineDay === null ? "—" : n1(perf.fleet.cupsPerMachineDay)} cups a day)</span>
            </span>
          ) : null}
          {m?.rank ? (
            <span className="text-mut">
              sells the {m.rank === 1 ? "" : `${ordinal(m.rank)} `}most of the {perf.fleet.selling} machines that sold
            </span>
          ) : null}
          {m?.inTop80 ? <Pill tone="ok">{KEY_MACHINE}</Pill> : null}
          {m?.cardOnly ? <Pill tone="mut">Card only</Pill> : null}
          {m?.disabledNow ? <Pill tone="warn">Off in Televend now</Pill> : null}
          {m && !m.counted ? <Pill tone="warn">Left out of every figure (Not counted)</Pill> : null}
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
              <span className="font-semibold text-ink">{c.cupsPerMachineDay === null ? "—" : n1(c.cupsPerMachineDay)} cups per machine a day</span> (the average machine:{" "}
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
        <Section title="Its machines against the average machine" hint="Cups a day, one bar each, coloured by group. Tap a bar to open the machine.">
          <RankedMachines
            machines={ms}
            average={perf.fleet.cupsPerMachineDay}
            thresholds={perf.fleet.thresholds}
            onPick={(m) => onMachine(m.key)}
            beforeLabel={`vs ${beforeWords(perf.before.shiftDays)}`}
          />
        </Section>
      ) : null}
      <Section title={`Its machines · ${ms.length}`} hint="Tap a name to open the machine.">
        <DataTable
          rows={ms}
          rowKey={(m) => m.key}
          empty="No machine of this category in these days."
          columns={[
            {
              head: "Machine",
              cell: (m) => (
                <button onClick={() => onMachine(m.key)} className="min-h-9 text-left font-semibold text-link hover:underline">
                  {m.label}
                  {m.assetNo ? <span className="font-normal text-mut"> · {m.assetNo}</span> : null}
                </button>
              ),
            },
            { head: "Group", cell: (m) => <TierBadge tier={m.tier} />, tight: true },
            { head: "Cups a day", cell: (m) => <span className="tabular-nums">{m.cupsPerDay === null ? "—" : n1(m.cupsPerDay)}</span>, tight: true },
            { head: "vs average", cell: (m) => <span className="tabular-nums">{vsAverageText(m.vsAverage)}</span>, tight: true },
            { head: `vs ${beforeWords(perf.before.shiftDays)}`, cell: (m) => <Change pct={m.changePct} />, tight: true },
            { head: "Income (estimate)", cell: (m) => <span className="tabular-nums">{aedRound(m.incomeFils)}</span>, tight: true },
          ]}
        />
      </Section>
    </div>
  );
}

