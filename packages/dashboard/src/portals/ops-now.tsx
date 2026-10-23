import { useCallback, useEffect, useMemo, useState } from "react";
import { aed, api, ApiError, hhmm, type FleetMachine, type FleetNow, type MachineState } from "../lib/api";
import { Card, Empty, Severity, Spinner } from "../components/ui";
import { Icon } from "../components/icons";
import { Drill, LOW_STOCK, type DrillKind } from "./ops-drill";

/**
 * Operations — Now (TASK-059): the command centre. Glance, understand, act in one tap: how many machines
 * need someone, which alarms (blips that clear themselves are filtered by their rules), and every
 * machine by region with what it sold today and the cash waiting in it since its last collection.
 *
 * Every number comes from /dashboard/ops/fleet, counted by Postgres over the Televend mirror. A state is
 * never colour alone: each has an icon and a word.
 *
 * TASK-072 (R11, R13): a machine opens as its own page, and the tiles are buttons — cash in the machines, today's collections and
 * refills, and the machines lowest on stock open a panel under the tiles with the list and a chart; cups today opens the sales.
 */

/** Televend is read every 10 minutes; a minute keeps the "for 2 h 10 min" ages true in between. */
const REFRESH_MS = 60_000;

const STATE: Record<MachineState, { label: string; tone: string; border: string; icon: keyof typeof Icon }> = {
  needs_action: { label: "Needs someone", tone: "text-crit", border: "border-crit/50", icon: "alertCircle" },
  offline: { label: "Offline", tone: "text-warn", border: "border-warn/50", icon: "ban" },
  warning: { label: "Televend warning", tone: "text-warn", border: "border-edge", icon: "alert" },
  ok: { label: "OK", tone: "text-ok", border: "border-edge", icon: "checkCircle" },
};
const STATE_ORDER: MachineState[] = ["needs_action", "offline", "warning", "ok"];
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** "2 h 10 min", "45 min", "3 d" — how long ago, in words. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `${Math.floor(h / 24)} d`;
}

/** "Metro Stadium-399-DXB" → "Metro Stadium": the asset number and emirate are shown beside it. */
export function shortLabel(label: string, assetNo: number | null): string {
  const cut = assetNo !== null ? label.split(new RegExp(`\\s*-?\\s*${assetNo}\\b`))[0] : label;
  return (cut ?? label).replace(/-\s*(DXB|SHJ|AJM|UAQ)\s*$/i, "").trim() || label;
}

export function CommandCentre({ viewer, onMachine, onSales }: { viewer: string; onMachine: (asset: number) => void; onSales: () => void }) {
  const [data, setData] = useState<FleetNow | null>(null);
  const [problem, setProblem] = useState<{ refused: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | MachineState>("all");
  const [q, setQ] = useState("");
  const [drill, setDrill] = useState<DrillKind | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.opsFleet(viewer));
      setProblem(null);
    } catch (e) {
      const refused = e instanceof ApiError && e.status === 403;
      setProblem({ refused, message: e instanceof Error ? e.message : "Could not reach the API" });
      if (refused) setData(null);
    } finally {
      setLoading(false);
    }
  }, [viewer]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const needs = useMemo(
    () =>
      (data?.machines ?? [])
        .flatMap((m) => m.problems.map((p) => ({ m, p })))
        .sort((a, b) => (SEVERITY_RANK[a.p.severity] ?? 9) - (SEVERITY_RANK[b.p.severity] ?? 9) || a.p.since.localeCompare(b.p.since)),
    [data],
  );
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    return (data?.machines ?? []).filter(
      (m) => (filter === "all" || m.state === filter) && (!words || `${m.label} ${m.assetNo ?? ""} ${m.region ?? ""}`.toLowerCase().includes(words)),
    );
  }, [data, filter, q]);
  const regions = useMemo(() => {
    const by = new Map<string, FleetMachine[]>();
    for (const m of shown) by.set(m.region ?? "Other", [...(by.get(m.region ?? "Other") ?? []), m]);
    return [...by.entries()];
  }, [shown]);

  if (problem?.refused) {
    return (
      <Card>
        <p className="font-semibold">This portal is for the people who run the machines.</p>
        <p className="mt-1 text-sm text-mut">{problem.message} If you need it, ask the CEO or an Admin to change your role.</p>
      </Card>
    );
  }
  if (!data) return problem ? <Card><p className="text-sm text-crit">● {problem.message}</p></Card> : <Spinner label="Reading the machines…" />;

  const c = data.counts;
  const lowStock = data.machines.filter((m) => m.stockPercent !== null && m.stockPercent < LOW_STOCK).length;
  const toggle = (k: DrillKind) => setDrill((d) => (d === k ? null : k));
  const showState = (s: MachineState) => {
    setDrill(null);
    setFilter(s);
    document.getElementById("every-machine")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className={`space-y-4 transition-opacity ${loading ? "opacity-80" : ""}`} aria-busy={loading}>
      {problem ? <Card><p className="text-sm text-crit">● {problem.message} — showing the last reading.</p></Card> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Tile label="Need someone" value={String(c.needsAction)} tone={c.needsAction > 0 ? "text-crit" : "text-ink"} sub={`of ${c.total} machines`} onClick={() => showState("needs_action")} />
        <Tile label="Offline" value={String(c.offline)} tone={c.offline > 0 ? "text-warn" : "text-ink"} sub="no contact with Televend" onClick={() => showState("offline")} />
        <Tile label="Cups today" value={data.cupsToday.toLocaleString("en-GB")} sub="all machines — every sale" onClick={onSales} />
        {data.seesExpectedCash && data.cashWaitingFils !== null ? (
          <Tile label="Cash in the machines" value={aed(data.cashWaitingFils)} sub="since each one's last collection" onClick={() => toggle("cash")} open={drill === "cash"} />
        ) : null}
        <Tile label="Collections today" value={String(data.cashCollectionsToday)} sub="cash collected (Televend)" onClick={() => toggle("collections")} open={drill === "collections"} />
        <Tile label="Refills today" value={String(data.refillsToday)} sub="fills logged in Televend" onClick={() => toggle("refills")} open={drill === "refills"} />
        <Tile label="Low on stock" value={String(lowStock)} tone={lowStock > 0 ? "text-warn" : "text-ink"} sub={`under ${Math.round(LOW_STOCK * 100)} % (Televend)`} onClick={() => toggle("stock")} open={drill === "stock"} />
      </div>
      {drill ? <Drill kind={drill} viewer={viewer} fleet={data} onMachine={onMachine} onClose={() => setDrill(null)} /> : null}

      <Card>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold">Needs someone now</h3>
          <span className="text-xs text-mut">
            {data.alarms.waiting + data.alarms.quietNoise > 0
              ? `${data.alarms.waiting + data.alarms.quietNoise} more alarm(s) may still clear themselves — not shown yet`
              : "No alarms waiting to clear themselves"}
          </span>
        </div>
        {needs.length === 0 ? (
          <Empty>Nothing needs anyone right now.</Empty>
        ) : (
          <ul className="divide-y divide-edge">
            {needs.map(({ m, p }) => (
              <li key={`${m.machineTvId}-${p.alarm}`}>
                <button
                  onClick={() => m.assetNo !== null && onMachine(m.assetNo)}
                  className="flex w-full flex-wrap items-start gap-x-3 gap-y-1 py-2.5 text-left hover:bg-sunken/60 sm:flex-nowrap"
                >
                  <Severity value={p.severity} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      {p.alarm} <span className="font-normal text-mut">— {shortLabel(m.label, m.assetNo)}{m.assetNo !== null ? ` · ${m.assetNo}` : ""}</span>
                    </span>
                    <span className="block text-sm text-mut">{p.advice}</span>
                    {p.problem ? (
                      <span className="mt-0.5 block text-xs text-mut">
                        Problem {p.problem.status}
                        {p.problem.resolver ? ` · with ${p.problem.resolver}` : ""}
                        {p.problem.slaDueAt ? ` · due ${hhmm(p.problem.slaDueAt)}` : ""}
                      </span>
                    ) : null}
                  </span>
                  <span className="whitespace-nowrap text-xs text-mut">for {ago(p.since)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!data.alarms.problemsEnabled && needs.length > 0 ? (
          <p className="mt-2 text-xs text-mut">
            Shown here only: these alarms are not yet sent to anyone as problems. An Admin switches that on once the routing
            rules say who handles machine, stock and cash problems.
          </p>
        ) : null}
      </Card>

      <Card>
        <div id="every-machine" className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Every machine</h3>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a machine — name or number"
            aria-label="Find a machine"
            className="w-full rounded-xl border border-edge bg-sunken px-3 py-2 text-sm sm:w-72"
          />
        </div>
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Show machines">
          <Chip on={filter === "all"} onClick={() => setFilter("all")}>All {c.total}</Chip>
          {STATE_ORDER.map((s) => {
            const n = s === "needs_action" ? c.needsAction : c[s];
            return (
              <Chip key={s} on={filter === s} onClick={() => setFilter(s)}>
                <span className={STATE[s].tone}>{Icon[STATE[s].icon]({ size: 14 })}</span> {STATE[s].label} {n}
              </Chip>
            );
          })}
        </div>
        {regions.length === 0 ? (
          <Empty>No machine matches.</Empty>
        ) : (
          <div className="space-y-4">
            {regions.map(([region, ms]) => (
              <section key={region} aria-label={region}>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-mut">
                  {region} · {ms.length}
                </h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {ms.map((m) => (
                    <MachineTile key={m.machineTvId} m={m} seesCash={data.seesExpectedCash} onOpen={() => m.assetNo !== null && onMachine(m.assetNo)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-mut">
          Read at {hhmm(data.at)}. Cash in a machine is Televend's cash sales since its last collection × its cash price (AED 10
          unless set) — what the next collection should find.
        </p>
      </Card>

    </div>
  );
}

function MachineTile({ m, seesCash, onOpen }: { m: FleetMachine; seesCash: boolean; onOpen: () => void }) {
  const s = STATE[m.state];
  return (
    <button
      onClick={onOpen}
      disabled={m.assetNo === null}
      className={`flex min-h-16 w-full flex-col gap-1 rounded-xl border bg-sunken/40 p-3 text-left hover:border-link ${s.border}`}
      aria-label={`${m.label}: ${s.label}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 font-semibold leading-tight">
          {shortLabel(m.label, m.assetNo)}
          {m.emirate && m.emirate !== "Dubai" ? <span className="font-normal text-mut"> · {m.emirate}</span> : null}
        </span>
        {m.assetNo !== null ? <span className="rounded bg-panel px-1.5 text-xs tabular-nums text-mut">{m.assetNo}</span> : null}
      </span>
      <span className={`flex items-center gap-1 text-xs font-semibold ${s.tone}`}>
        {Icon[s.icon]({ size: 14 })} {s.label}
        {m.problems.length > 0 ? <span className="font-normal text-mut"> — {m.problems.map((p) => p.alarm).join(", ")}</span> : null}
      </span>
      <span className="text-xs text-mut">
        {m.cupsToday} cups today
        {m.cashWaitingFils !== null ? ` · ${aed(m.cashWaitingFils)} cash waiting` : seesCash ? " · no collection seen in 60 days" : ""}
        {m.lastCashAt ? ` · collected ${ago(m.lastCashAt)} ago` : ""}
        {m.stockPercent !== null ? ` · stock ${Math.round(m.stockPercent * 100)} %` : ""}
      </span>
    </button>
  );
}

/** A key figure that opens what it counts — a button, with an arrow so it looks like one. */
function Tile({ label, value, sub, tone = "text-ink", onClick, open }: { label: string; value: string; sub: string; tone?: string; onClick: () => void; open?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      className={`flex min-h-24 flex-col rounded-2xl border bg-panel p-4 text-left hover:border-link ${open ? "border-link" : "border-edge"}`}
    >
      <span className="flex items-center justify-between gap-1 text-xs text-mut">
        {label}
        <Icon.chevronRight size={14} />
      </span>
      <span className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</span>
      <span className="mt-0.5 text-[11px] text-mut">{sub}</span>
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`flex min-h-9 items-center gap-1 rounded-xl border px-3 py-1.5 text-sm ${on ? "border-link bg-link/10 font-semibold text-ink" : "border-edge bg-sunken text-mut hover:text-ink"}`}
    >
      {children}
    </button>
  );
}
