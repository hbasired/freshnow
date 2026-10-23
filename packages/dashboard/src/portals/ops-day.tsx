import { useCallback, useEffect, useState } from "react";
import { aed, api, ApiError, companyToday, type DayReport, type DayReportMachine } from "../lib/api";
import { Card, DataTable, Spinner, type Column } from "../components/ui";
import { shortLabel } from "./ops-now";

/**
 * Operations — Day report (TASK-059): what every machine did on one Dubai day — cups by how they were
 * paid, each cash collection with the cash Televend's own sales say it should have found, refills and
 * alarms. It replaces the yesterday-report that was assembled by hand from the WhatsApp groups, with
 * one difference that matters: the cash is what should be there, not what anyone typed.
 */

function shiftDay(day: string, n: number): string {
  const d = new Date(new Date(`${day}T12:00:00+04:00`).getTime() + n * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const dayName = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Dubai" }).format(new Date(`${iso}T12:00:00+04:00`));
const hm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export function DayReportView({ viewer }: { viewer: string }) {
  const today = companyToday();
  const [date, setDate] = useState(() => shiftDay(companyToday(), -1));
  const [r, setR] = useState<DayReport | null>(null);
  const [inFull, setInFull] = useState<boolean | null>(null);
  const [err, setErr] = useState<{ refused: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [report, sales] = await Promise.all([api.opsDayReport(viewer, date), api.salesByHour(viewer, date)]);
      setR(report);
      // A day the mirror did not read in full is short, not quiet — said before any number.
      setInFull(sales.covered.date);
      setErr(null);
    } catch (e) {
      setErr({ refused: e instanceof ApiError && e.status === 403, message: e instanceof Error ? e.message : "Could not reach the API" });
    } finally {
      setLoading(false);
    }
  }, [viewer, date]);
  useEffect(() => {
    void load();
  }, [load]);

  if (err?.refused) {
    return (
      <Card>
        <p className="font-semibold">This portal is for the people who run the machines.</p>
        <p className="mt-1 text-sm text-mut">{err.message}</p>
      </Card>
    );
  }

  const cols: Column<DayReportMachine>[] = [
    {
      head: "Machine",
      cell: (m) => (
        <span>
          <span className="font-semibold">{shortLabel(m.label, m.assetNo)}</span>
          {m.assetNo !== null ? <span className="text-mut"> · {m.assetNo}</span> : null}
        </span>
      ),
    },
    { head: "Cups", cell: (m) => <span className="tabular-nums">{m.cups}</span>, tight: true },
    { head: "Cash · card · other", cell: (m) => <span className="tabular-nums text-mut">{m.cashCups} · {m.cardCups} · {m.otherCups}</span>, tight: true },
    {
      head: r?.seesExpectedCash !== false ? "Collections — should have found" : "Collections",
      cell: (m) =>
        m.collections.length === 0 ? (
          <span className="text-mut">—</span>
        ) : (
          <span className="tabular-nums">
            {m.collections.map((c) => (c.expectedFils === null ? hm(c.at) : `${hm(c.at)} ${aed(c.expectedFils)}`)).join(" · ")}
          </span>
        ),
    },
    { head: "Refills", cell: (m) => <span className="tabular-nums">{m.refills || "—"}</span>, tight: true },
    {
      head: "Alarms",
      cell: (m) =>
        m.alarmsNeedingSomeone + m.alarmsClearedThemselves === 0 ? (
          <span className="text-mut">—</span>
        ) : (
          <span className="tabular-nums">
            {m.alarmsNeedingSomeone}
            {m.alarmsClearedThemselves > 0 ? <span className="text-mut"> + {m.alarmsClearedThemselves} cleared on their own</span> : null}
          </span>
        ),
      tight: true,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-mut">{dayName(date)} — every machine, from Televend.</p>
        <div className="flex items-center gap-2" role="group" aria-label="Day shown">
          <button onClick={() => setDate(shiftDay(date, -1))} className="h-9 rounded-xl border border-edge bg-sunken px-3 text-sm text-mut hover:text-ink" aria-label="The day before">
            ‹
          </button>
          <input
            type="date"
            max={today}
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            aria-label="Day"
            className="rounded-xl border border-edge bg-sunken px-2 py-1.5 text-sm"
          />
          <button
            onClick={() => setDate(shiftDay(date, 1))}
            disabled={date >= today}
            className="h-9 rounded-xl border border-edge bg-sunken px-3 text-sm text-mut hover:text-ink disabled:opacity-40"
            aria-label="The day after"
          >
            ›
          </button>
        </div>
      </div>

      {err ? <Card><p className="text-sm text-crit">● {err.message}</p></Card> : null}
      {!r && loading ? <Spinner label="Counting the day…" /> : null}

      {r ? (
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          {inFull === false ? (
            <Card>
              <p className="text-sm text-warn">
                ● {dayName(date)} was not read from Televend in full — these numbers are short. Loading the day again fills the gap (COMMANDS.md §7h).
              </p>
            </Card>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Cups sold" value={r.totals.cups.toLocaleString("en-GB")} sub={`${r.totals.cashCups} cash · ${r.totals.cardCups} card`} />
            <Tile
              label="Cash collections"
              value={String(r.totals.collections)}
              sub={r.totals.expectedCashFils === null ? "logged in Televend" : `should have found ${aed(r.totals.expectedCashFils)}`}
            />
            <Tile label="Refills" value={String(r.totals.refills)} sub="fills logged in Televend" />
            <Tile label="Alarms that needed someone" value={String(r.totals.alarmsNeedingSomeone)} sub={`stayed open past their wait · ${r.totals.alarmsClearedThemselves} cleared on their own`} />
            <Tile label="Machines with no sale" value={String(r.totals.silentMachines)} sub="enabled, silent all day" tone={r.totals.silentMachines > 0 ? "text-warn" : "text-ink"} />
          </div>
          <Card>
            <DataTable rows={r.machines} columns={cols} empty="No machine did anything this day." rowKey={(m) => `${m.assetNo ?? m.label}`} />
            <p className="mt-3 text-xs text-mut">
              "Should have found" is Televend's own cash sales between the machine's previous collection and this one × its cash
              price (AED 10 unless set). Compare it with what the driver reported — a difference is a fact to look into, never an
              accusation.
            </p>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Tile({ label, value, sub, tone = "text-ink" }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <Card>
      <div className="text-xs text-mut">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-mut">{sub}</div>
    </Card>
  );
}
