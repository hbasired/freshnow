import { useCallback, useEffect, useState } from "react";
import { api, ApiError, companyToday, hhmm, type SalesList } from "../lib/api";
import { Card, Empty, Spinner } from "../components/ui";
import { HourlyLines, ValueBars } from "../components/charts/analytics-charts";
import { shortLabel } from "./ops-now";

/**
 * Operations — Recent sales (TASK-072, R10): every sale of a day, newest first, with its machine, category and payment — filtered,
 * paged, and summed for the whole day under the same filters (cups, machines, by payment, by hour). Today's list looks again every
 * minute. Every figure comes from /dashboard/ops/sales, counted by Postgres; a machine opens as its own page.
 */

function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
const dayName = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

export function RecentSales({ viewer, onMachine }: { viewer: string; onMachine: (asset: number) => void }) {
  const today = companyToday();
  const [date, setDate] = useState(today);
  const [category, setCategory] = useState("");
  const [payment, setPayment] = useState("");
  const [data, setData] = useState<SalesList | null>(null);
  const [more, setMore] = useState<SalesList["rows"]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [err, setErr] = useState<{ refused: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.opsSales(viewer, { date, ...(category ? { category } : {}), ...(payment ? { payment } : {}), limit: 50 });
      setData(r);
      setMore([]);
      setNext(r.next);
      setErr(null);
    } catch (e) {
      setErr({ refused: e instanceof ApiError && e.status === 403, message: e instanceof Error ? e.message : "Could not reach the API" });
    }
  }, [viewer, date, category, payment]);
  useEffect(() => {
    void load();
  }, [load]);
  // Today's sales keep arriving: the first page looks again every minute (later pages stay as read).
  useEffect(() => {
    if (date !== today) return;
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [date, today, load]);

  const loadMore = async () => {
    if (!next) return;
    setBusy(true);
    try {
      const r = await api.opsSales(viewer, { date, ...(category ? { category } : {}), ...(payment ? { payment } : {}), limit: 50, before: next });
      setMore((m) => [...m, ...r.rows]);
      setNext(r.next);
    } catch (e) {
      setErr({ refused: false, message: e instanceof Error ? e.message : "Could not reach the API" });
    } finally {
      setBusy(false);
    }
  };

  if (err?.refused) return <Card><p className="text-sm">{err.message}</p></Card>;
  const rows = [...(data?.rows ?? []), ...more];
  const current = dubaiHourNow();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        {[
          ["Today", today],
          ["Yesterday", shiftDay(today, -1)],
        ].map(([label, d]) => (
          <button key={label} onClick={() => setDate(d!)} aria-pressed={date === d} className={`min-h-10 rounded-xl border px-3 text-sm ${date === d ? "border-link font-semibold" : "border-edge"}`}>
            {label}
          </button>
        ))}
        <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" className="h-10 rounded-xl border border-edge bg-sunken px-2 text-sm" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="h-10 rounded-xl border border-edge bg-sunken px-2 text-sm">
          <option value="">Every category</option>
          {data?.choices.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={payment} onChange={(e) => setPayment(e.target.value)} aria-label="Payment" className="h-10 rounded-xl border border-edge bg-sunken px-2 text-sm">
          <option value="">Every payment</option>
          {data?.choices.payments.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      {err ? <p className="text-sm text-crit">● {err.message}</p> : null}
      {!data ? (
        <Spinner label="Reading the sales…" />
      ) : (
        <>
          <section aria-label="The day" className="grid gap-4 xl:grid-cols-3">
            <Card className="space-y-1">
              <div className="text-xs text-mut">{date === today ? "Today so far" : dayName(date)}</div>
              <div className="text-2xl font-bold">{data.summary.cups.toLocaleString("en-GB")} cups</div>
              <div className="text-xs text-mut">from {data.summary.machines} machine{data.summary.machines === 1 ? "" : "s"}{category || payment ? " — with the filters" : ""}</div>
            </Card>
            <Card className="xl:col-span-2">
              <h3 className="mb-1 text-sm font-bold">By payment</h3>
              <ValueBars rows={data.summary.byPayment.map((p) => ({ key: p.caption, name: p.caption, value: p.cups }))} unit="cups" format={(n) => n.toLocaleString("en-GB")} />
            </Card>
          </section>
          <Card>
            <h3 className="mb-1 text-sm font-bold">By hour</h3>
            <HourlyLines
              points={data.summary.byHour.map((h) => ({ hour: h.hour, now: date === today && h.hour > current ? null : h.cups, before: null }))}
              names={{ now: date === today ? "Today" : dayName(date), before: "" }}
            />
          </Card>
          <Card>
            <h3 className="mb-2 text-sm font-bold">Every sale, newest first</h3>
            {rows.length === 0 ? (
              <Empty>No sales{category || payment ? " with these filters" : ""} on this day.</Empty>
            ) : (
              <ul className="divide-y divide-edge text-sm">
                {rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                    <span className="w-12 shrink-0 tabular-nums text-mut">{hhmm(r.at)}</span>
                    {r.assetNo !== null ? (
                      <button onClick={() => onMachine(r.assetNo!)} className="min-h-8 min-w-0 truncate text-left font-semibold text-link hover:underline">
                        {shortLabel(r.label, r.assetNo)} · {r.assetNo}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate font-semibold">{r.label}</span>
                    )}
                    <span className="text-xs text-mut">{r.category ?? "—"}</span>
                    <span className="ml-auto text-xs">{r.payment ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )}
            {next ? (
              <button onClick={() => void loadMore()} disabled={busy} className="mt-2 min-h-11 w-full rounded-xl border border-edge text-sm font-semibold hover:border-link disabled:opacity-50">
                {busy ? "…" : "Show more"}
              </button>
            ) : null}
          </Card>
        </>
      )}
    </div>
  );
}

const dubaiHourNow = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", hour12: false }).format(new Date()));
