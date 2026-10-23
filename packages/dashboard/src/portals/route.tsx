import { useCallback, useEffect, useState } from "react";
import { Card, Empty, Pill, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { newId } from "../lib/inventory-api";
import {
  EVIDENCE_ICON,
  EVIDENCE_KINDS,
  EVIDENCE_WORDS,
  TASK_WORDS,
  dayLabel,
  dubaiDateOf,
  dubaiDay,
  route,
  type GridRow,
  type OffPlanVisit,
  type PlanCard,
  type RouteHome,
  type RouteMachine,
} from "../lib/route-api";
import { ROUTE_VIEWS, type RouteView } from "../portals";
import { BigButton, Problem, errorText, hhmm } from "./inv-ui";
import { PlanEditor, ServiceRules, VisitSheet } from "./route-sheets";

/**
 * The Route portal (TASK-061 part 2): the service team's instruction sheet in the app (migration 0036).
 *
 *   Today   the person's round — each team plan they are on, the machines in order, what to do at each, the crates
 *           to take, and how far the team has got; a visit starts by the machine's sticker (its link opens this
 *           page) or its number typed in
 *   Plans   for a Supervisor, the Ops Head, the CEO or an Admin: each team's plan for a day and shift — made, copied
 *           from the day before, changed, cancelled
 *   Proof   the sheet's OK / NO columns, worked out from the visits, with the fill, the cash and Televend's refill
 *
 * The server decides what each may see and do; this page only leaves out buttons that would be refused.
 */

const VIEW_LABEL: Record<RouteView, string> = { today: "Today", plans: "Plans", proof: "Proof" };

type Open = { kind: "visit"; id: string } | { kind: "plan"; plan: PlanCard | null; date: string };

export default function RoutePortal({
  viewer,
  view,
  onView,
  liveTick,
  sticker,
  onStickerUsed,
}: {
  viewer: string;
  view: RouteView;
  onView: (v: RouteView) => void;
  liveTick: number;
  /** A sticker's token, when the page was opened by its link (#visit/<token>). */
  sticker: string | null;
  /** The sticker's visit was started, or put aside: it is not offered again. */
  onStickerUsed: () => void;
}) {
  const [home, setHome] = useState<RouteHome | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [planDate, setPlanDate] = useState(() => dubaiDay(0));
  // The person's own change reloads the lists at once — not only when the doorbell rings (it may not reach them).
  const [changes, setChanges] = useState(0);
  const tick = liveTick + changes;

  const load = useCallback(async () => {
    try {
      setHome(await route.home(viewer));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? e.message : errorText(e));
    }
  }, [viewer]);
  // Postgres rings the doorbell when a plan or a visit changes (0036's live scope); the minute's poll is the fallback.
  useEffect(() => {
    void load();
  }, [load, liveTick]);
  useEffect(() => {
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const can = home?.can;
  const views = ROUTE_VIEWS.filter((v) => (v === "today" ? can?.visit : can?.plan));
  const shown: RouteView = home && !views.includes(view) ? (views[0] ?? "today") : view;
  const done = (msg: string) => {
    setOpen(null);
    setChanges((n) => n + 1);
    setFlash(msg);
    void load();
    setTimeout(() => setFlash(null), 7_000);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Route</h2>
          <p className="text-sm text-mut">Each team's machines for the shift, what to do at each — and the proof, stop by stop.</p>
        </div>
        {views.length > 1 ? (
          <div className="flex rounded-xl border border-edge bg-sunken p-0.5" role="tablist" aria-label="Route views">
            {views.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={shown === v}
                onClick={() => onView(v)}
                className={`min-h-10 rounded-lg px-3 py-1.5 text-sm ${shown === v ? "bg-panel font-semibold text-ink shadow-sm" : "text-mut hover:text-ink"}`}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {flash ? (
        <p role="status" className="rounded-xl border border-ok/40 bg-ok/10 p-3 font-semibold text-ok">
          {flash}
        </p>
      ) : null}
      {err && !home ? <Empty>{err}</Empty> : null}
      {!home && !err ? <Spinner label="Opening your route…" /> : null}

      {home && sticker && can?.visit ? (
        <StickerCard
          viewer={viewer}
          token={sticker}
          onStarted={(id) => {
            onStickerUsed();
            setOpen({ kind: "visit", id });
          }}
          onDismiss={onStickerUsed}
        />
      ) : null}
      {home && shown === "today" ? <Today viewer={viewer} home={home} onOpenVisit={(id) => setOpen({ kind: "visit", id })} /> : null}
      {home && shown === "plans" ? (
        <Plans viewer={viewer} liveTick={tick} date={planDate} onDate={setPlanDate} onEdit={(plan) => setOpen({ kind: "plan", plan, date: planDate })} onChanged={done} />
      ) : null}
      {home && shown === "proof" ? <Proof viewer={viewer} liveTick={tick} /> : null}

      {open?.kind === "visit" && home ? (
        <VisitSheet viewer={viewer} visitId={open.id} canCash={home.can.cash} onDone={done} onClose={() => { setOpen(null); void load(); }} />
      ) : null}
      {open?.kind === "plan" ? <PlanEditor viewer={viewer} plan={open.plan} date={open.date} onDone={done} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

// ── a sticker's link ─────────────────────────────────────────────────────────
function StickerCard({ viewer, token, onStarted, onDismiss }: { viewer: string; token: string; onStarted: (visitId: string) => void; onDismiss: () => void }) {
  const [machine, setMachine] = useState<{ assetNo: number | null; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [id] = useState(newId);
  useEffect(() => {
    route.sticker(viewer, token).then(setMachine, (e) => setErr(errorText(e)));
  }, [viewer, token]);
  return (
    <Card className="space-y-2 border-ok/50 bg-ok/10">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold">📍 You scanned a machine's sticker</div>
        <button onClick={onDismiss} aria-label="Not now" className="flex size-10 items-center justify-center rounded-lg text-mut hover:bg-sunken">
          ✕
        </button>
      </div>
      {machine ? <p className="text-lg">{machine.label}{machine.assetNo ? ` · ${machine.assetNo}` : ""}</p> : !err ? <p className="text-sm text-mut">Finding the machine…</p> : null}
      {machine ? (
        <BigButton
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await route.start(viewer, { id, qrToken: token });
              onStarted(r.visitId);
            } catch (e) {
              setErr(errorText(e));
              setBusy(false);
            }
          }}
        >
          Start the visit here
        </BigButton>
      ) : null}
      <Problem text={err} />
    </Card>
  );
}

// ── today ────────────────────────────────────────────────────────────────────
function Today({ viewer, home, onOpenVisit }: { viewer: string; home: RouteHome; onOpenVisit: (id: string) => void }) {
  const open = home.openVisit;
  return (
    <div className="space-y-4">
      {open ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-ok/50">
          <div>
            <div className="text-sm text-mut">You are at</div>
            <div className="text-lg font-bold">
              {open.machine.label}
              {open.machine.assetNo ? ` · ${open.machine.assetNo}` : ""}
            </div>
            <div className="text-sm text-mut">since {hhmm(open.startedAt)}{open.missing.length > 0 ? ` · ${open.missing.length} proof still to add` : " · proof complete"}</div>
          </div>
          <button onClick={() => onOpenVisit(open.id)} className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok">
            Carry on
          </button>
        </Card>
      ) : (
        <StartVisit viewer={viewer} onStarted={onOpenVisit} />
      )}

      {home.round.plans.length === 0 ? (
        <Empty>No route for you today. When a Supervisor makes your team's plan, it appears here.</Empty>
      ) : (
        home.round.plans.map((p) => (
          <section key={p.id} aria-label={p.name} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-bold">
                {p.shiftWindow === "night" ? "🌙" : "☀️"} {p.name} · {dayLabel(p.businessDate)}, {p.shiftWindow} shift
              </h3>
              <span className="text-sm text-mut">
                {p.stops.filter((s) => s.visits.length > 0).length} of {p.stops.length} visited
                {p.crates > 0 ? ` · take ${p.crates} crate${p.crates === 1 ? "" : "s"} of oranges` : ""}
              </span>
            </div>
            {p.note ? <p className="text-sm">{p.note}</p> : null}
            <ol className="divide-y divide-edge rounded-2xl border border-edge bg-panel">
              {p.stops.map((s) => (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <div className="font-semibold">
                      <span className="mr-1 text-mut">{s.seq}.</span>
                      {s.machine.label}
                      {s.machine.assetNo ? <span className="font-normal text-mut"> · {s.machine.assetNo}</span> : null}
                    </div>
                    <div className="text-sm">
                      {s.tasks.map((t) => TASK_WORDS[t]).join(", ")}
                      {s.crates ? ` · ${s.crates} crate${s.crates === 1 ? "" : "s"}` : ""}
                    </div>
                    {s.instructions ? <div className="text-sm text-mut">“{s.instructions}”</div> : null}
                    <div className="mt-1 flex flex-wrap gap-1 text-xs">
                      {s.evidence.map((k) => (
                        <Pill key={k} tone={s.visits.length === 0 ? "mut" : s.missing.includes(k) ? "crit" : "ok"}>
                          {EVIDENCE_ICON[k]} {EVIDENCE_WORDS[k]}
                        </Pill>
                      ))}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    {s.visits.length === 0 ? (
                      <span className="text-mut">not yet</span>
                    ) : (
                      s.visits.map((v) => (
                        <div key={v.id}>
                          {v.endedAt ? "✓" : "…"} {v.employee.name.split(" ").slice(-1)[0]} {hhmm(v.startedAt)}
                        </div>
                      ))
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}

function StartVisit({ viewer, onStarted }: { viewer: string; onStarted: (visitId: string) => void }) {
  const [machines, setMachines] = useState<RouteMachine[]>([]);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    route.machines(viewer).then(setMachines, () => setMachines([]));
  }, [viewer]);
  const n = Number(number);
  const known = machines.find((m) => m.assetNo === n);
  return (
    <Card className="space-y-2">
      <div className="font-semibold">📍 At a machine? Start the visit</div>
      <p className="text-sm text-mut">Scan the sticker on the machine with your phone's camera — or type the number printed on it (“Machine ID”).</p>
      <div className="flex flex-wrap items-end gap-2">
        <input
          inputMode="numeric"
          list="route-machines"
          value={number}
          onChange={(e) => setNumber(e.target.value.replace(/\D/g, "").slice(0, 5))}
          placeholder="e.g. 699"
          aria-label="Machine number"
          className="h-12 w-32 rounded-xl border border-edge bg-sunken px-3 text-xl font-bold tabular-nums"
        />
        <datalist id="route-machines">
          {machines.map((m) => (
            <option key={m.assetNo} value={m.assetNo}>
              {m.label}
            </option>
          ))}
        </datalist>
        <button
          disabled={!known || busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await route.start(viewer, { id: newId(), machineAssetNo: n });
              setNumber("");
              onStarted(r.visitId);
            } catch (e) {
              setErr(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
          className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok disabled:opacity-50"
        >
          Start visit
        </button>
      </div>
      <p className={`text-sm ${number && !known && machines.length > 0 ? "text-crit" : "text-mut"}`}>
        {known ? `✓ ${known.label}${known.serviceShift ? ` · ${known.serviceShift} shift only` : ""}` : number && machines.length > 0 ? "No machine with this number." : " "}
      </p>
      <Problem text={err} />
    </Card>
  );
}

// ── plans ────────────────────────────────────────────────────────────────────
function DatePick({ date, onDate }: { date: string; onDate: (d: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input type="date" value={date} onChange={(e) => e.target.value && onDate(e.target.value)} aria-label="Day" className="h-11 rounded-xl border border-edge bg-sunken px-3" />
      {[
        ["Yesterday", -1],
        ["Today", 0],
        ["Tomorrow", 1],
      ].map(([label, off]) => (
        <button
          key={label}
          onClick={() => onDate(dubaiDay(off as number))}
          className={`min-h-11 rounded-xl border px-3 text-sm ${date === dubaiDay(off as number) ? "border-link font-semibold" : "border-edge"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Plans({
  viewer,
  liveTick,
  date,
  onDate,
  onEdit,
  onChanged,
}: {
  viewer: string;
  liveTick: number;
  date: string;
  onDate: (d: string) => void;
  onEdit: (plan: PlanCard | null) => void;
  onChanged: (msg: string) => void;
}) {
  const [plans, setPlans] = useState<PlanCard[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPlans(null);
    route.plans(viewer, date).then(
      (r) => {
        setPlans(r);
        setErr(null);
      },
      (e) => setErr(errorText(e)),
    );
  }, [viewer, date, liveTick]);
  const dayBefore = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const active = plans?.filter((p) => p.state === "active") ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DatePick date={date} onDate={onDate} />
        <div className="flex flex-wrap gap-2">
          <button onClick={() => onEdit(null)} className="min-h-11 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok">
            + New team plan
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await route.copyPlans(viewer, dayBefore, date);
                const left = r.skippedPlans.map((x) => `${x.name} (${x.shiftWindow}: ${x.why === "already_there" ? "already on this day" : "nobody on it can visit machines any more"})`);
                onChanged(
                  (r.created.length > 0 ? `Copied ${r.created.length} plan${r.created.length === 1 ? "" : "s"} from ${dayLabel(dayBefore)}.` : `Nothing copied from ${dayLabel(dayBefore)}.`) +
                    (left.length > 0 ? ` Left out: ${left.join("; ")}.` : ""),
                );
              } catch (e) {
                setErr(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
            className="min-h-11 rounded-xl border border-edge px-4 font-semibold disabled:opacity-50"
          >
            Copy {dayLabel(dayBefore)}'s plans
          </button>
        </div>
      </div>
      <Problem text={err} />
      {!plans && !err ? <Spinner label="Loading plans…" /> : null}
      {plans && plans.length === 0 ? <Empty>No plans for {dayLabel(date)} yet. Make one, or copy the day before's.</Empty> : null}
      {plans ? (
        <p className="text-sm text-mut">
          {active.length} team plan{active.length === 1 ? "" : "s"} · {active.reduce((t, p) => t + p.stops.length, 0)} machines ·{" "}
          {active.reduce((t, p) => t + p.crates, 0)} crates of oranges to take from the warehouse
        </p>
      ) : null}
      <ul className="grid gap-2 md:grid-cols-2">
        {plans?.map((p) => {
          const visited = p.stops.filter((s) => s.visits.length > 0).length;
          const complete = p.stops.filter((s) => s.proofComplete).length;
          return (
            <li key={p.id}>
              <Card className={`space-y-1 ${p.state === "cancelled" ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="font-semibold">
                    {p.shiftWindow === "night" ? "🌙" : "☀️"} {p.name}
                    {p.state === "cancelled" ? <Pill tone="mut">cancelled</Pill> : null}
                  </div>
                  {p.may.edit ? (
                    <button onClick={() => onEdit(p)} className="min-h-10 rounded-lg border border-edge px-3 text-sm font-semibold hover:border-link">
                      Edit
                    </button>
                  ) : null}
                </div>
                <div className="text-sm text-mut">{p.members.map((m) => m.name).join(", ")}</div>
                <div className="text-sm">
                  {p.stops.length} machine{p.stops.length === 1 ? "" : "s"}
                  {p.crates > 0 ? ` · ${p.crates} crate${p.crates === 1 ? "" : "s"}` : ""} · visited {visited}/{p.stops.length} · proof complete {complete}/{p.stops.length}
                </div>
                <div className="truncate text-xs text-mut">{p.stops.map((s) => s.machine.label).join(" · ")}</div>
              </Card>
            </li>
          );
        })}
      </ul>
      <ServiceRules viewer={viewer} liveTick={liveTick} />
    </div>
  );
}

// ── proof: the sheet's OK / NO ───────────────────────────────────────────────
function Proof({ viewer, liveTick }: { viewer: string; liveTick: number }) {
  const [date, setDate] = useState(() => dubaiDay(0));
  const [grid, setGrid] = useState<{ rows: GridRow[]; unplanned: OffPlanVisit[]; seesMachines: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setGrid(null);
    route.grid(viewer, date).then(
      (g) => {
        setGrid(g);
        setErr(null);
      },
      (e) => setErr(errorText(e)),
    );
  }, [viewer, date, liveTick]);
  const teams = [...new Set(grid?.rows.map((r) => r.planId) ?? [])];
  const missing = grid?.rows.reduce((t, r) => t + (r.stop.visits.length > 0 ? r.stop.missing.length : 0), 0) ?? 0;
  const notVisited = grid?.rows.filter((r) => r.stop.visits.length === 0).length ?? 0;
  return (
    <div className="space-y-3">
      <DatePick date={date} onDate={setDate} />
      <Problem text={err} />
      {!grid && !err ? <Spinner label="Working out the proof…" /> : null}
      {grid && grid.rows.length === 0 ? <Empty>No plans for {dayLabel(date)}.</Empty> : null}
      {grid && grid.rows.length > 0 ? (
        <p className="text-sm">
          <b>{grid.rows.length}</b> stops · <b className={notVisited ? "text-crit" : ""}>{notVisited}</b> not visited · <b className={missing ? "text-crit" : ""}>{missing}</b> proof missing on visited stops
        </p>
      ) : null}
      {teams.map((planId) => {
        const rows = grid!.rows.filter((r) => r.planId === planId);
        const first = rows[0]!;
        return (
          <section key={planId} aria-label={first.team} className="space-y-1">
            <h3 className="text-base font-bold">
              {first.shiftWindow === "night" ? "🌙" : "☀️"} {first.team} — {first.shiftWindow.toUpperCase()} SHIFT
            </h3>
            <div className="overflow-x-auto rounded-xl border border-edge">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-sunken text-left text-xs text-mut">
                  <tr>
                    <th className="p-2">Machine / instructions</th>
                    {EVIDENCE_KINDS.map((k) => (
                      <th key={k} className="p-2">
                        {EVIDENCE_WORDS[k]}
                      </th>
                    ))}
                    <th className="p-2">Visited</th>
                    <th className="p-2">Fill · cash</th>
                    {grid?.seesMachines ? <th className="p-2">Televend</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {rows.map((r) => {
                    const v = r.stop.visits[r.stop.visits.length - 1];
                    return (
                      <tr key={r.stop.id}>
                        <td className="p-2">
                          <div className="font-semibold">
                            {r.stop.machine.label}
                            {r.stop.machine.assetNo ? <span className="font-normal text-mut"> {r.stop.machine.assetNo}</span> : null}
                          </div>
                          <div className="text-xs text-mut">
                            {r.stop.tasks.map((t) => TASK_WORDS[t]).join(", ")}
                            {r.stop.crates ? ` (${r.stop.crates} crate${r.stop.crates === 1 ? "" : "s"})` : ""}
                            {r.stop.instructions ? ` — ${r.stop.instructions}` : ""}
                          </div>
                        </td>
                        {EVIDENCE_KINDS.map((k) => (
                          <td key={k} className="p-2">
                            {!r.stop.evidence.includes(k) ? null : !v ? (
                              <span className="text-mut">—</span>
                            ) : r.stop.missing.includes(k) ? (
                              <span className="rounded bg-crit px-2 py-0.5 text-xs font-bold text-white">NO</span>
                            ) : (
                              <span className="font-semibold text-ok">OK</span>
                            )}
                          </td>
                        ))}
                        <td className="p-2 text-xs">
                          {v ? (
                            <>
                              {v.employee.name} {hhmm(v.startedAt)}
                              <br />
                              <span className="text-mut">{v.startedHow === "qr" ? "sticker" : "number typed"}{v.endedAt ? "" : " · still there"}</span>
                            </>
                          ) : (
                            <span className="text-crit">not visited</span>
                          )}
                        </td>
                        <td className="p-2 text-xs">
                          {r.fill ? r.fill.items : <span className="text-mut">no fill</span>}
                          <br />
                          {r.cashCollected ? "cash ✓" : <span className="text-mut">no cash entry</span>}
                        </td>
                        {grid?.seesMachines ? (
                          <td className="p-2 text-xs">
                            {!r.televend ? (
                              <span className="text-mut">—</span>
                            ) : (
                              <>
                                {r.televend.refillAt ? `refill ${r.televend.refillCups ?? "?"} cups ${hhmm(r.televend.refillAt)}` : <span className="text-mut">no refill near</span>}
                                <br />
                                {r.televend.collectionAt ? `collection ${hhmm(r.televend.collectionAt)}` : <span className="text-mut">no collection near</span>}
                              </>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {grid && grid.unplanned.length > 0 ? (
        <section aria-label="Visits off the plans" className="space-y-1">
          <h3 className="text-base font-bold">Visits off the plans</h3>
          <ul className="text-sm">
            {grid.unplanned.map((u) => (
              <li key={u.id}>
                {u.employee.name} at {u.machine.label}
                {u.machine.assetNo ? ` ${u.machine.assetNo}` : ""}, {dubaiDateOf(u.startedAt) === date ? hhmm(u.startedAt) : `${hhmm(u.startedAt)} (${dayLabel(dubaiDateOf(u.startedAt))})`}
                {u.why === "stop_removed" ? <span className="text-mut"> — its stop was taken off the plan</span> : u.why === "plan_cancelled" ? <span className="text-mut"> — its plan was cancelled</span> : null}
                {u.tasksDone.length > 0 || u.evidence.length > 0 ? (
                  <span className="block text-xs text-mut">
                    {u.tasksDone.length > 0 ? `done: ${u.tasksDone.map((t) => TASK_WORDS[t]).join(", ")}` : ""}
                    {u.tasksDone.length > 0 && u.evidence.length > 0 ? " · " : ""}
                    {u.evidence.length > 0 ? `proof: ${u.evidence.map((k) => EVIDENCE_WORDS[k]).join(", ")}` : ""}
                  </span>
                ) : (
                  <span className="block text-xs text-crit">no proof</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
