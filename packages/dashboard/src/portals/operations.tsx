import { useCallback, useEffect, useState } from "react";
import { api, ApiError, companyToday, hhmm, type HourlySales } from "../lib/api";
import { Card, Empty, Spinner } from "../components/ui";
import { Icon } from "../components/icons";
import { HourlyComparisonChart } from "../components/charts/hourly-comparison";
import { OPERATIONS_VIEWS, type OperationsView } from "../portals";
import { CommandCentre } from "./ops-now";
import { DayReportView } from "./ops-day";
import { MachinePageView } from "./ops-machine-page";
import { RecentSales } from "./ops-vends";

/**
 * The Operations portal: Now — the command centre (TASK-059: the fleet, the alarms that need someone,
 * one machine at a tap); Sales by hour (TASK-058); Day report (TASK-059: what every machine did on a
 * day, with the cash each collection should have found).
 *
 * Its own code chunk: loaded only when someone opens it, together with the chart library, so nobody
 * else downloads either. Shown only to people whose role includes `televend.read` (portals.ts); the
 * API refuses everyone else regardless, and row-level security returns them nothing.
 *
 * Every number on this page was counted by Postgres from the Televend mirror (/dashboard/ops/…), and
 * only fair comparisons are drawn (TASK-058 review): a day still being read is compared with the
 * earlier day up to the same moment, the hour in progress is marked "so far", and a day the mirror
 * never read says so instead of showing zero.
 */

/** Televend is read every 10 minutes; looking again every 5 shows each read soon after it lands. */
const REFRESH_MS = 5 * 60_000;
/** A read older than this while the day is running means the sync is behind — said in words. */
const STALE_MS = 25 * 60_000;

const dayName = (iso: string, weekday: "short" | "long" = "short"): string =>
  new Intl.DateTimeFormat("en-GB", { weekday, day: "numeric", month: "short", timeZone: "Asia/Dubai" }).format(
    new Date(`${iso}T12:00:00+04:00`),
  );
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
/** The Dubai day an instant falls on, YYYY-MM-DD. */
const dubaiDay = (iso: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(iso));

/** Company day `n` days from `day` (both YYYY-MM-DD). Dubai has no daylight saving. */
function shiftDay(day: string, n: number): string {
  const d = new Date(new Date(`${day}T12:00:00+04:00`).getTime() + n * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Milliseconds until the next Dubai midnight (+5 s, so the new day has begun). */
function untilMidnight(now = Date.now()): number {
  const tomorrow = shiftDay(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(now)), 1);
  return Date.parse(`${tomorrow}T00:00:05+04:00`) - now;
}

const VIEW_LABEL: Record<OperationsView, string> = { now: "Now", vends: "Recent sales", sales: "Sales by hour", day: "Day report" };

export default function OperationsPortal({
  viewer,
  view,
  machine,
  onView,
  onMachine,
}: {
  viewer: string;
  view: OperationsView;
  /** A machine open as its own page (#operations/machine/<n>), or null. */
  machine: number | null;
  onView: (v: OperationsView) => void;
  onMachine: (asset: number) => void;
}) {
  // Back goes to Now; the browser's own Back returns to wherever the machine was opened from (each page is a history step).
  if (machine !== null) return <MachinePageView viewer={viewer} asset={machine} onBack={() => onView("now")} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Operations</h2>
          <p className="text-sm text-mut">The machines — straight from Televend, read every 10 minutes.</p>
        </div>
        <div className="flex rounded-xl border border-edge bg-sunken p-0.5" role="tablist" aria-label="Operations views">
          {OPERATIONS_VIEWS.map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => onView(v)}
              className={`rounded-lg px-3 py-1.5 text-sm ${view === v ? "bg-panel font-semibold text-ink shadow-sm" : "text-mut hover:text-ink"}`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>
      {view === "now" ? (
        <CommandCentre viewer={viewer} onMachine={onMachine} onSales={() => onView("vends")} />
      ) : view === "vends" ? (
        <RecentSales viewer={viewer} onMachine={onMachine} />
      ) : view === "day" ? (
        <DayReportView viewer={viewer} />
      ) : (
        <SalesByHour viewer={viewer} />
      )}
    </div>
  );
}

function SalesByHour({ viewer }: { viewer: string }) {
  // "today" follows the clock across midnight; a picked day stays that day.
  const [choice, setChoice] = useState<"today" | string>("today");
  const [clock, setClock] = useState(() => Date.now());
  const today = companyToday();
  const date = choice === "today" ? today : choice;
  const [data, setData] = useState<HourlySales | null>(null);
  const [problem, setProblem] = useState<{ refused: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [table, setTable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.salesByHour(viewer, date));
      setProblem(null);
    } catch (e) {
      const refused = e instanceof ApiError && e.status === 403;
      setProblem({ refused, message: e instanceof Error ? e.message : "Could not reach the API" });
      if (refused) setData(null);
    } finally {
      setLoading(false);
    }
  }, [viewer, date]);

  useEffect(() => {
    void load();
  }, [load, clock]);
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), REFRESH_MS);
    const m = setTimeout(() => setClock(Date.now()), untilMidnight());
    return () => {
      clearInterval(t);
      clearTimeout(m);
    };
  }, [clock]);

  const yesterday = shiftDay(today, -1);
  const running = data ? data.throughHour !== null : date === today;
  const names = data ? { day: data.date === today ? "Today" : dayName(data.date), earlier: dayName(data.comparedWith) } : null;
  const horizon = data?.horizon ? new Date(data.horizon) : null;
  const byWhen = running && horizon ? `by ${hhmm(horizon.toISOString())}` : null;
  const stale = running && data?.date === today && horizon !== null && Date.now() - horizon.getTime() > STALE_MS;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-mut">Cups sold hour by hour, against the same day a week earlier.</p>
        {/* One filter row, above everything it scopes. */}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Day shown">
          <DayChip on={choice === "today"} onClick={() => setChoice("today")}>Today</DayChip>
          <DayChip on={choice === yesterday} onClick={() => setChoice(yesterday)}>Yesterday</DayChip>
          <input
            type="date"
            max={today}
            {...(data?.mirroredFrom ? { min: data.mirroredFrom } : {})}
            value={date}
            onChange={(e) => e.target.value && setChoice(e.target.value === today ? "today" : e.target.value)}
            aria-label="Another day"
            className="rounded-xl border border-edge bg-sunken px-2 py-1.5 text-sm"
          />
          <button
            onClick={() => setClock(Date.now())}
            aria-label="Read again"
            title="Read again"
            className={`grid h-9 w-9 place-items-center rounded-xl border border-edge bg-sunken text-mut hover:border-ok hover:text-ok ${loading ? "animate-pulse" : ""}`}
          >
            <Icon.refresh size={18} />
          </button>
        </div>
      </div>

      {problem?.refused ? (
        <Card>
          <p className="font-semibold">This portal is for the people who run the machines.</p>
          <p className="mt-1 text-sm text-mut">{problem.message} If you need it, ask the CEO or an Admin to change your role.</p>
        </Card>
      ) : problem ? (
        <Card>
          <p className="text-sm text-crit">● {problem.message}</p>
        </Card>
      ) : null}

      {!data && loading && !problem ? <Spinner label="Reading the machines…" /> : null}

      {data && names && !data.covered.date ? (
        <Card>
          <NotRead data={data} today={today} />
        </Card>
      ) : null}

      {data && names && data.covered.date ? (
        // While a refresh runs the last picture stays, dimmed — no flash, no jump.
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          {stale ? (
            <Card>
              <p className="text-sm text-warn">
                ● Televend has not been read since {hhmm(data.horizon)} — today's numbers stop there, and so does the comparison.
              </p>
            </Card>
          ) : null}
          <div className={`grid gap-3 ${running ? "grid-cols-2 sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            <StatTile
              wide={running}
              label={running ? `Cups sold so far ${data.date === today ? "today" : `on ${dayName(data.date)}`}${byWhen ? ` (${byWhen})` : ""}` : `Cups sold on ${dayName(data.date, "long")}`}
              value={data.totals.cups}
              {...(data.totals.cups !== null && data.totals.cupsLastWeekSameTime !== null
                ? { delta: { now: data.totals.cups, before: data.totals.cupsLastWeekSameTime, against: running ? `${byWhen ?? "by this time"} on ${names.earlier}` : `on ${names.earlier}` } }
                : {})}
            />
            <StatTile
              label={running ? `${byWhen ? byWhen.charAt(0).toUpperCase() + byWhen.slice(1) : "By this time"} on ${names.earlier}` : `On ${dayName(data.comparedWith, "long")}`}
              value={data.totals.cupsLastWeekSameTime}
            />
            {running ? <StatTile label={`All of ${names.earlier}`} value={data.totals.cupsLastWeekWholeDay} /> : null}
          </div>

          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold">Cups sold by hour</h3>
              <button
                onClick={() => setTable((t) => !t)}
                aria-pressed={table}
                className="flex items-center gap-1.5 rounded-lg border border-edge bg-sunken px-2.5 py-1 text-xs hover:border-link"
              >
                {table ? <Icon.barChart size={14} /> : <Icon.table size={14} />} {table ? "Show the chart" : "Show as a table"}
              </button>
            </div>
            {!running && data.totals.cups === 0 && (data.totals.cupsLastWeekWholeDay ?? 0) === 0 ? (
              <Empty>
                {data.covered.comparedWith ? "No sales on either day in the Televend mirror." : `No sales on ${names.day} in the Televend mirror.`}
              </Empty>
            ) : table ? (
              <HourTable data={data} names={names} />
            ) : (
              <HourlyComparisonChart data={data} names={names} />
            )}
            <p className="mt-3 text-xs text-mut">
              {horizon
                ? `Read from Televend up to ${hhmm(horizon.toISOString())}${dubaiDay(horizon.toISOString()) === today ? "" : ` on ${dayName(dubaiDay(horizon.toISOString()))}`}, every 10 minutes.`
                : "Not read from Televend yet."}{" "}
              {running
                ? `The hour in progress is shown so far, against the same minutes on ${names.earlier}.`
                : data.complete.date
                  ? `${names.day} matches Televend's own count.`
                  : `${names.day} is not yet confirmed against Televend's own count.`}{" "}
              {!data.covered.comparedWith
                ? `${names.earlier} was not read from Televend in full, so there is no comparison.`
                : data.complete.comparedWith
                  ? `${names.earlier} matches Televend's own count.`
                  : `${names.earlier} is not yet confirmed against Televend's own count.`}
            </p>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

/** Why a day has no numbers — said exactly, because each case is put right differently. */
function NotRead({ data, today }: { data: HourlySales; today: string }) {
  const day = dayName(data.date, "long");
  const lastRead = data.horizon
    ? `Televend was last read at ${hhmm(data.horizon)}${dubaiDay(data.horizon) === today ? "" : ` on ${dayName(dubaiDay(data.horizon))}`}.`
    : "";
  const [title, detail] = !data.mirroredFrom
    ? ["Televend has not been read yet.", "The worker reads it every 10 minutes once it is running with the Televend settings (COMMANDS.md §7h)."]
    : data.date < data.mirroredFrom
      ? [`${day} is before the Televend mirror.`, `The mirror holds sales from ${dayName(data.mirroredFrom, "long")} on. Earlier days can be loaded from Televend (COMMANDS.md §7h).`]
      : data.date === today && (!data.horizon || dubaiDay(data.horizon) < today)
        ? ["Nothing has been read from Televend for today yet.", `${lastRead} It is read every 10 minutes.`.trim()]
        : [`${day} was not read from Televend in full.`, "Part of the day was never read — the sync was stopped, or a read did not finish — so it has no total. Loading the day again fills the gap (COMMANDS.md §7h)."];
  return (
    <>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm text-mut">{detail}</p>
    </>
  );
}

function DayChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-xl border px-3 py-1.5 text-sm ${on ? "border-link bg-link/10 font-semibold text-ink" : "border-edge bg-sunken text-mut hover:text-ink"}`}
    >
      {children}
    </button>
  );
}

/**
 * Label, value and — optionally — the change against an earlier figure. The change says its
 * direction three ways (sign, arrow, colour), so it never rests on colour. No value: "—", never 0.
 */
function StatTile({
  label,
  value,
  delta,
  wide = false,
}: {
  label: string;
  value: number | null;
  delta?: { now: number; before: number; against: string };
  /** Takes the whole row on a phone. */
  wide?: boolean;
}) {
  const diff = delta ? delta.now - delta.before : 0;
  const pct = delta && delta.before > 0 ? Math.round((Math.abs(diff) / delta.before) * 100) : null;
  return (
    <Card className={wide ? "col-span-2 sm:col-span-1" : ""}>
      <div className="text-xs text-mut">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value === null ? "—" : value.toLocaleString("en-GB")}</div>
      {delta ? (
        <div className={`mt-1 text-xs ${diff > 0 ? "text-ok" : diff < 0 ? "text-crit" : "text-mut"}`}>
          <span aria-hidden="true">{diff > 0 ? "↑ " : diff < 0 ? "↓ " : "= "}</span>
          {diff === 0 ? "the same" : `${diff > 0 ? "+" : "−"}${Math.abs(diff).toLocaleString("en-GB")}${pct !== null ? ` (${pct}%)` : ""}`}{" "}
          <span className="text-mut">{delta.against}</span>
        </div>
      ) : value === null ? (
        <div className="mt-1 text-xs text-mut">not in the mirror</div>
      ) : null}
    </Card>
  );
}

/** The chart's twin: every value, readable without the chart — the hour in progress marked as such. */
function HourTable({ data, names }: { data: HourlySales; names: { day: string; earlier: string } }) {
  return (
    <div className="max-h-80 overflow-y-auto rounded-lg border border-edge">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-sunken text-left text-xs text-mut">
          <tr>
            <th scope="col" className="px-3 py-1.5 font-medium">Hour</th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">{names.day}</th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">{names.earlier}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {data.hours.map((h) => {
            const inProgress = data.partial?.hour === h.hour ? data.partial : null;
            const later = data.throughHour !== null && h.hour > data.throughHour;
            return (
              <tr key={h.hour}>
                <th scope="row" className="px-3 py-1 text-left font-normal text-mut">
                  {hh(h.hour)}–{hh((h.hour + 1) % 24)}
                  {inProgress ? " (so far)" : ""}
                </th>
                <td className="px-3 py-1 text-right tabular-nums">{later ? "—" : inProgress ? inProgress.cups : (h.cups ?? "—")}</td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {h.cupsLastWeek === null
                    ? "—"
                    : inProgress && inProgress.cupsLastWeekSameMinutes !== null
                      ? `${inProgress.cupsLastWeekSameMinutes} (same minutes) · ${h.cupsLastWeek} whole hour`
                      : h.cupsLastWeek}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
