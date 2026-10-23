import { useEffect, useState } from "react";
import { Card, Empty, Spinner } from "../components/ui";
import { COUNT_KIND_WORDS, amount, inv, units, type InventoryDay } from "../lib/inventory-api";
import { errorText, hhmm } from "./inv-ui";

/**
 * One Dubai day's stock (TASK-060): for each item, the warehouse's opening, what came in and went out by
 * kind, and its closing — and for each person, what they took, gave back, used, and still hold at the
 * end. Summed by Postgres from the ledger; opening + in − out = closing on every line, because both come
 * from the same moves.
 */

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
function shift(day: string, n: number): string {
  const d = new Date(new Date(`${day}T12:00:00+04:00`).getTime() + n * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(d);
}
const nice = (day: string) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Dubai" }).format(new Date(`${day}T12:00:00+04:00`));
const n = (q: number) => (q === 0 ? "" : String(Math.round(q * 1000) / 1000));
const signed = (q: number) => (q === 0 ? "" : `${q > 0 ? "+" : "−"}${Math.round(Math.abs(q) * 1000) / 1000}`);

export default function DayView({ viewer }: { viewer: string }) {
  const [date, setDate] = useState(today);
  const [day, setDay] = useState<InventoryDay | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setDay(null);
    setErr(null);
    inv.day(viewer, date).then(setDay, (e) => setErr(errorText(e)));
  }, [viewer, date]);

  const moved = day?.warehouse.filter((r) => r.opening || r.closing || r.received || r.givenOut || r.cameBack || r.takenBack || r.used || r.damaged || r.adjusted || r.reversed) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setDate(shift(date, -1))} aria-label="The day before" className="flex size-12 items-center justify-center rounded-xl border border-edge bg-panel text-xl">
          ‹
        </button>
        <div className="text-center">
          <div className="font-bold">{nice(date)}</div>
          {day && !day.complete ? <div className="text-xs text-warn">Still running — "closing" is now</div> : null}
        </div>
        <button onClick={() => setDate(shift(date, 1))} disabled={date >= today()} aria-label="The day after" className="flex size-12 items-center justify-center rounded-xl border border-edge bg-panel text-xl disabled:opacity-40">
          ›
        </button>
      </div>
      {err ? <Empty>{err}</Empty> : null}
      {!day && !err ? <Spinner label="Adding up the day…" /> : null}
      {day ? (
        <>
          <section className="space-y-2" aria-label="The warehouse">
            <h3 className="text-base font-bold">The warehouse</h3>
            {moved.length === 0 ? (
              <Empty>Nothing in or out of the warehouse that day.</Empty>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-edge">
                <table className="w-full text-sm">
                  <thead className="bg-sunken text-left text-xs text-mut">
                    <tr>
                      <th className="p-2">Item</th>
                      <th className="p-2 text-right">Start</th>
                      <th className="p-2 text-right">In</th>
                      <th className="p-2 text-right">Given out</th>
                      <th className="p-2 text-right">Back</th>
                      <th className="p-2 text-right">Used</th>
                      <th className="p-2 text-right">Damaged</th>
                      <th className="p-2 text-right">Counts</th>
                      <th className="p-2 text-right">End</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {moved.map((r) => (
                      <tr key={r.itemId}>
                        <td className="p-2 font-semibold">
                          {r.icon} {r.name} <span className="text-xs font-normal text-mut">{units(r.unit)}</span>
                        </td>
                        <td className="p-2 text-right tabular-nums">{n(r.opening) || "0"}</td>
                        <td className="p-2 text-right tabular-nums">{n(r.received)}</td>
                        <td className="p-2 text-right tabular-nums">{n(r.givenOut)}</td>
                        <td className="p-2 text-right tabular-nums">{n(r.takenBack + r.cameBack)}</td>
                        <td className="p-2 text-right tabular-nums">{n(r.used)}</td>
                        <td className="p-2 text-right tabular-nums">{n(r.damaged)}</td>
                        <td className={`p-2 text-right tabular-nums ${r.adjusted + r.reversed < 0 ? "text-crit" : ""}`}>{signed(r.adjusted + r.reversed)}</td>
                        <td className="p-2 text-right font-bold tabular-nums">{n(r.closing) || "0"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-mut">Start + In − Given out + Back − Used − Damaged ± Counts = End, on every line.</p>
          </section>

          <section className="space-y-2" aria-label="People">
            <h3 className="text-base font-bold">People</h3>
            {day.people.length === 0 ? <Empty>Nobody held or moved stock that day.</Empty> : null}
            {day.people.map((p) => {
              const holding = p.items.filter((i) => i.closing > 0);
              return (
                <Card key={p.employeeId}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="font-semibold">{p.name}</div>
                    <div className={`text-sm ${holding.length ? "text-warn" : "text-ok"}`}>
                      {holding.length ? `Still holds ${holding.map((i) => amount(i.closing, i.unit) + " " + i.name).join(", ")}` : "Holds nothing at the end"}
                    </div>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm text-mut">
                    {p.items.map((i) => (
                      <li key={i.itemId}>
                        {i.icon} {i.name}: {[
                          i.opening ? `started with ${n(i.opening)}` : "",
                          i.received ? `took ${n(i.received)}` : "",
                          i.gaveOut ? `gave ${n(i.gaveOut)}` : "",
                          i.cameBack ? `${n(i.cameBack)} came back` : "",
                          i.used ? `used ${n(i.used)}` : "",
                          i.damaged ? `damaged ${n(i.damaged)}` : "",
                          i.reversed ? `undone ${signed(i.reversed)}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </li>
                    ))}
                  </ul>
                </Card>
              );
            })}
          </section>

          <section className="space-y-2" aria-label="Counts">
            <h3 className="text-base font-bold">Counts</h3>
            {day.counts.length === 0 ? <Empty>No count of the warehouse that day.</Empty> : null}
            <ul className="space-y-1 text-sm">
              {day.counts.map((c) => (
                <li key={c.id} className="rounded-lg border border-edge bg-panel p-2">
                  {COUNT_KIND_WORDS[c.kind] ?? c.kind} · {c.at ? hhmm(c.at) : "not handed in"} · {c.by} ·{" "}
                  {c.state === "closed" ? (c.differing ? `${c.differing} item(s) decided` : "matched") : c.state === "approval" ? "waiting for a decision" : c.state === "recount" ? "waiting for a recount" : c.state}
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
