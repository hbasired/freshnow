import { useEffect, useState, type ReactNode } from "react";
import { aed, api, ApiError, hhmm, type MachinePage } from "../lib/api";
import { Card, Empty, Pill, Spinner } from "../components/ui";
import { Icon } from "../components/icons";
import { DailyComparison, HourlyLines } from "../components/charts/analytics-charts";
import { ago } from "./ops-now";

/**
 * One machine as a full page (TASK-072, R11, R7.3–7.5): glance — its state, stock, last sale, refill and collection; understand —
 * today by hour against the same weekday a week before, 28 days against the week before each, payments, alarms; then everything it
 * did — refills (who, how much), collections (what each should have found), sales, visits — and every Televend record it has had,
 * so a machine that moved keeps its history.
 *
 * Every figure comes from /dashboard/ops/machines/:asset/page, counted by Postgres; this page computes nothing. Stock is Televend's
 * own figure and the cups left an estimate from it, said as "about".
 */

const STATE_WORDS: Record<MachinePage["status"]["state"], { label: string; tone: "ok" | "warn" | "crit" | "mut"; icon: keyof typeof Icon }> = {
  ok: { label: "OK", tone: "ok", icon: "checkCircle" },
  warning: { label: "Televend warning", tone: "warn", icon: "alert" },
  needs_action: { label: "Needs someone", tone: "crit", icon: "alertCircle" },
  offline: { label: "Offline", tone: "warn", icon: "ban" },
};
const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const dubaiHour = (iso: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", hour12: false }).format(new Date(iso)));

export function MachinePageView({ viewer, asset, onBack }: { viewer: string; asset: number; onBack: () => void }) {
  const [d, setD] = useState<MachinePage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    api.opsMachinePage(viewer, asset).then(
      (x) => live && (setD(x), setErr(null)),
      (e: unknown) => live && setErr(e instanceof ApiError && e.status === 404 ? `No machine numbered ${asset}.` : e instanceof Error ? e.message : "Could not read the machine"),
    );
    return () => {
      live = false;
    };
  }, [viewer, asset, clock]);
  // Televend is read every 10 minutes; looking again every 5 keeps today's hours current.
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex min-h-10 items-center gap-1 rounded-lg px-1 text-sm text-link hover:underline">
        <Icon.chevronLeft size={16} /> All machines
      </button>
      {err ? <Card><p className="text-sm text-crit">● {err}</p></Card> : !d ? <Spinner label="Reading the machine…" /> : <Body d={d} />}
    </div>
  );
}

function Body({ d }: { d: MachinePage }) {
  const st = STATE_WORDS[d.status.state];
  const I = Icon[st.icon];
  const reached = d.today.readUntil ? dubaiHour(d.today.readUntil) : 23;
  const lastRefill = d.refills.find((r) => r.action === "filled");
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold tracking-tight">{d.label}</h2>
          <span className="rounded bg-sunken px-2 py-0.5 text-sm tabular-nums text-mut">No. {d.assetNo}</span>
          <Pill tone={st.tone}>
            <span className="inline-flex items-center gap-1">
              <I size={13} /> {st.label}
            </span>
          </Pill>
          {d.cardOnly ? <Pill tone="mut">Card only</Pill> : null}
        </div>
        <p className="text-sm text-mut">
          {d.category ?? "No category"}
          {d.corrected ? ` (corrected — Televend: ${d.televendRegion ?? "none"})` : ""}
          {d.emirate ? ` · ${d.emirate}` : ""} · {d.status.connection === "offline" ? "no contact with Televend" : d.status.connection === "online" ? "online" : "connection unknown"}
          {d.status.signal !== null ? ` · signal ${d.status.signal} %` : ""} · cash {aed(d.prices.cashFils)}
          {d.prices.cashSource === "default" ? " (the default)" : ""} · card {aed(d.prices.cardFils)}
          {d.prices.cardSource === "name" ? " (from its name)" : ""}
        </p>
      </header>

      <section aria-label="At a glance" className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
        <Fact label="Cups today" value={d.today.cups.toLocaleString("en-GB")} line={d.today.cupsWeekBeforeSameTime === null ? "the week before was not read" : `same time a week before: ${d.today.cupsWeekBeforeSameTime}`} />
        <Fact
          label="Stock (Televend)"
          value={d.stock.cupsLeft !== null ? `≈ ${d.stock.cupsLeft} cups` : d.stock.percent !== null ? `${Math.round(d.stock.percent * 100)} %` : "—"}
          line={
            d.stock.negative
              ? "below empty in Televend — fills were not logged"
              : d.stock.percent !== null && d.stock.capacityPerColumn !== null
                ? `${Math.round(d.stock.percent * 100)} % of ${d.stock.capacityPerColumn}${d.stock.columns && d.stock.columns > 1 ? ` × ${d.stock.columns} columns` : ""}`
                : "capacity not known yet"
          }
          tone={d.stock.negative || (d.stock.percent !== null && d.stock.percent < 0.25) ? "crit" : undefined}
        />
        <Fact label="Last sale" value={d.status.lastSaleAt ? `${ago(d.status.lastSaleAt)} ago` : "—"} line={d.status.lastSaleAt ? when(d.status.lastSaleAt) : "none seen"} />
        <Fact label="Last refill" value={d.status.lastRefillAt ? `${ago(d.status.lastRefillAt)} ago` : "—"} line={lastRefill ? `+${lastRefill.change} by ${lastRefill.by ?? "—"}` : "none in the log"} />
        <Fact label="Last collection" value={d.status.lastCollectionAt ? `${ago(d.status.lastCollectionAt)} ago` : "—"} line={d.status.lastCollectionAt ? when(d.status.lastCollectionAt) : "none seen"} />
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <h3 className="mb-2 text-sm font-bold">Today by hour</h3>
          <HourlyLines
            points={d.today.hours.map((h) => ({ hour: h.hour, now: h.hour <= reached ? h.cups : null, before: h.cupsWeekBefore }))}
            names={{ now: "Today", before: "Same weekday a week before" }}
          />
          {d.today.readUntil ? <p className="text-xs text-mut">Read from Televend until {hhmm(d.today.readUntil)}.</p> : null}
        </Card>
        <Card>
          <h3 className="mb-2 text-sm font-bold">The last 28 days</h3>
          <DailyComparison points={d.days.map((x) => ({ date: x.date, now: x.cups, before: x.weekBefore }))} names={{ now: "Cups that day", before: "Same weekday a week before" }} unit="cups" />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <h3 className="mb-2 text-sm font-bold">How it was paid — the last 7 days</h3>
          {d.payments.length === 0 ? (
            <Empty>No sales in the last 7 days.</Empty>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {d.payments.map((p) => (
                <li key={p.caption} className="flex items-center gap-2">
                  <span className="w-28 shrink-0">{p.caption}</span>
                  <span className="h-2.5 rounded-full bg-mark-accent" style={{ width: `${Math.max(2, (p.cups / Math.max(...d.payments.map((x) => x.cups))) * 60)}%` }} aria-hidden />
                  <span className="tabular-nums text-mut">{p.cups}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h3 className="mb-2 text-sm font-bold">Alarms</h3>
          {d.alarms.open.length === 0 ? <p className="text-sm text-mut">None open.</p> : null}
          <ul className="space-y-1.5 text-sm">
            {d.alarms.open.map((a) => (
              <li key={a.alarm}>
                <span className={a.decision === "raise" ? "font-semibold text-crit" : "font-semibold"}>{a.alarm}</span>{" "}
                <span className="text-mut">
                  — open {ago(a.since)}
                  {a.decision === "wait" ? " (may still clear itself)" : ""}. {a.advice}
                </span>
              </li>
            ))}
          </ul>
          {d.alarms.last7Days.length > 0 ? (
            <p className="mt-2 text-xs text-mut">Last 7 days: {d.alarms.last7Days.map((a) => `${a.alarm} × ${a.count}`).join(" · ")}</p>
          ) : null}
        </Card>
      </div>

      <Card>
        <h3 className="mb-2 text-sm font-bold">Refills (Televend's log)</h3>
        <Table
          empty="No refills logged."
          head={["When", "What", "How much", "Full after", "By"]}
          rows={d.refills.map((r) => [
            when(r.at),
            r.action,
            `${r.change > 0 ? "+" : ""}${r.change}`,
            r.after === null ? "—" : `${r.after}${r.capacity ? ` of ${r.capacity}` : ""}`,
            r.by ?? "—",
          ])}
        />
      </Card>

      <Card>
        <h3 className="mb-2 text-sm font-bold">Cash collections</h3>
        {d.seesExpectedCash ? (
          <>
            <Table
              empty="No collection seen."
              head={["When", "Cash sales since the one before", "Should have found"]}
              rows={d.collections.map((c) => [when(c.at), String(c.cashVends ?? "—"), c.expectedFils === null ? "—" : aed(c.expectedFils)])}
            />
            <p className="mt-1 text-xs text-mut">Should have found = Televend's cash sales since the collection before × the cash price ({aed(d.prices.cashFils)}).</p>
          </>
        ) : (
          <Table empty="No collection seen." head={["When"]} rows={d.collections.map((c) => [when(c.at)])} />
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <h3 className="mb-2 text-sm font-bold">Recent sales</h3>
          <Table empty="No sales." head={["When", "Paid", "Product"]} rows={d.recentSales.map((s) => [when(s.at), s.payment ?? "—", s.product ?? "—"])} />
        </Card>
        <Card>
          <h3 className="mb-2 text-sm font-bold">Visits</h3>
          <Table
            empty="No visits recorded in FreshNow yet."
            head={["When", "Who", "Started by", "Proof", "Ended"]}
            rows={d.visits.map((v) => [when(v.at), v.by, v.how === "qr" ? "sticker" : "number typed", String(v.proof), v.endedAt ? hhmm(v.endedAt) : "still there"])}
          />
        </Card>
      </div>

      <Card>
        <h3 className="mb-2 text-sm font-bold">Where it has stood (its Televend records)</h3>
        <Table
          empty="—"
          head={["Name in Televend", "Region", "Seen", ""]}
          rows={d.places.map((p) => [
            p.caption,
            p.region ?? "—",
            `${p.firstSeen ? when(p.firstSeen) : "?"} – ${p.lastSeen ? when(p.lastSeen) : "?"}`,
            p.current ? "now" : p.enabled ? "" : "moved away",
          ])}
        />
      </Card>

      {d.notes.machine || d.notes.serviceShift || d.notes.categoryNote ? (
        <Card>
          <h3 className="mb-1 text-sm font-bold">Notes</h3>
          <ul className="space-y-1 text-sm">
            {d.notes.serviceShift ? (
              <li>
                Served by {d.notes.serviceShift} only{d.notes.serviceNote ? ` — ${d.notes.serviceNote}` : ""}
              </li>
            ) : null}
            {d.notes.categoryNote ? <li>Category corrected: {d.notes.categoryNote}</li> : null}
            {d.notes.machine ? <li>{d.notes.machine}</li> : null}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Fact({ label, value, line, tone }: { label: string; value: string; line: string; tone?: "crit" | undefined }) {
  return (
    <Card className="space-y-0.5">
      <div className="text-xs text-mut">{label}</div>
      <div className={`text-xl font-bold tracking-tight ${tone === "crit" ? "text-crit" : ""}`}>{value}</div>
      <div className="text-xs text-mut">{line}</div>
    </Card>
  );
}

/** A small table that becomes stacked lines on a phone — no sideways scroll. */
function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="hidden text-left text-xs text-mut sm:table-header-group">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="pb-1 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {rows.map((r, i) => (
            <tr key={i} className="block py-1.5 sm:table-row sm:py-0">
              {r.map((c, j) => (
                <td key={j} className={`block py-0.5 sm:table-cell sm:py-1.5 sm:pr-3 ${j === 0 ? "font-semibold sm:font-normal" : ""}`}>
                  {head[j] ? <span className="mr-1 text-xs text-mut sm:hidden">{head[j]}:</span> : null}
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
