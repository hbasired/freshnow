import { useEffect, useState } from "react";
import { aed, api, companyToday, hhmm, type DayReport, type FleetNow, type RefillRow } from "../lib/api";
import { Card, Empty, Spinner } from "../components/ui";
import { ValueBars } from "../components/charts/analytics-charts";
import { ago, shortLabel } from "./ops-now";

/**
 * The command centre's tiles, opened (TASK-072, R13): which machines hold cash and how much; today's collections, each with what it
 * should have found; today's refills — who, how much, how full after; and the machines lowest on stock. Shown in the page under the
 * tiles, not over it; every row opens its machine's page. Figures come from the server — the fleet, the day report, the refills —
 * and are only sorted here.
 */

export type DrillKind = "cash" | "collections" | "refills" | "stock";
/** Televend's stock below this share is "needs a refill" on this list (assumed — A-T72.1). */
export const LOW_STOCK = 0.25;

const TITLE: Record<DrillKind, string> = {
  cash: "Cash in the machines",
  collections: "Collections today",
  refills: "Refills today",
  stock: "Lowest on stock",
};

export function Drill({ kind, viewer, fleet, onMachine, onClose }: { kind: DrillKind; viewer: string; fleet: FleetNow; onMachine: (asset: number) => void; onClose: () => void }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{TITLE[kind]}</h3>
        <button onClick={onClose} className="min-h-10 rounded-lg border border-edge px-3 text-sm">
          Close
        </button>
      </div>
      {kind === "cash" ? <CashDrill fleet={fleet} onMachine={onMachine} /> : null}
      {kind === "stock" ? <StockDrill fleet={fleet} onMachine={onMachine} /> : null}
      {kind === "collections" ? <CollectionsDrill viewer={viewer} onMachine={onMachine} /> : null}
      {kind === "refills" ? <RefillsDrill viewer={viewer} onMachine={onMachine} /> : null}
    </Card>
  );
}

function MachineLink({ assetNo, label, onMachine }: { assetNo: number | null; label: string; onMachine: (asset: number) => void }) {
  if (assetNo === null) return <span className="font-semibold">{label}</span>;
  return (
    <button onClick={() => onMachine(assetNo)} className="min-h-8 text-left font-semibold text-link hover:underline">
      {shortLabel(label, assetNo)} · {assetNo}
    </button>
  );
}

function CashDrill({ fleet, onMachine }: { fleet: FleetNow; onMachine: (asset: number) => void }) {
  const holding = fleet.machines.filter((m) => (m.cashWaitingFils ?? 0) > 0).sort((a, b) => (b.cashWaitingFils ?? 0) - (a.cashWaitingFils ?? 0));
  const unknown = fleet.machines.filter((m) => m.cashWaitingFils === null).length;
  return (
    <div className="space-y-2">
      <p className="text-sm text-mut">
        {aed(fleet.cashWaitingFils ?? 0)} in {holding.length} machine{holding.length === 1 ? "" : "s"} — each machine's cash sales since its last collection × its cash
        price. {unknown > 0 ? `${unknown} with no collection seen in 60 days are not counted.` : ""}
      </p>
      <ValueBars
        rows={holding.slice(0, 25).map((m) => ({ key: String(m.assetNo ?? m.machineTvId), name: `${m.assetNo ?? "—"} ${shortLabel(m.label, m.assetNo)}`, value: (m.cashWaitingFils ?? 0) / 100 }))}
        unit="AED waiting"
        format={(n) => `AED ${n.toLocaleString("en-GB")}`}
        onPick={(k) => onMachine(Number(k))}
      />
      {holding.length > 25 ? <p className="text-xs text-mut">The 25 holding the most; the list below has them all.</p> : null}
      <ul className="divide-y divide-edge text-sm">
        {holding.map((m) => (
          <li key={m.machineTvId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <MachineLink assetNo={m.assetNo} label={m.label} onMachine={onMachine} />
            <span className="tabular-nums">
              {aed(m.cashWaitingFils ?? 0)} <span className="text-xs text-mut">{m.lastCashAt ? `· collected ${ago(m.lastCashAt)} ago` : ""}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StockDrill({ fleet, onMachine }: { fleet: FleetNow; onMachine: (asset: number) => void }) {
  const known = fleet.machines.filter((m) => m.stockPercent !== null).sort((a, b) => (a.stockPercent ?? 0) - (b.stockPercent ?? 0));
  const low = known.filter((m) => (m.stockPercent ?? 1) < LOW_STOCK);
  const below = known.filter((m) => (m.stockPercent ?? 0) < 0).length;
  return (
    <div className="space-y-2">
      <p className="text-sm text-mut">
        {low.length} machine{low.length === 1 ? "" : "s"} under {Math.round(LOW_STOCK * 100)} % of capacity by Televend's stock figure
        {below > 0 ? ` — ${below} below empty, where sales outran the fills logged in the Staff App` : ""}. Televend's figure is only as good as the fills logged.
      </p>
      <ValueBars
        rows={known.slice(0, 20).map((m) => ({ key: String(m.assetNo ?? m.machineTvId), name: `${m.assetNo ?? "—"} ${shortLabel(m.label, m.assetNo)}`, value: Math.round((m.stockPercent ?? 0) * 100) }))}
        unit="% of capacity left"
        format={(n) => `${n} %`}
        onPick={(k) => onMachine(Number(k))}
      />
      <ul className="divide-y divide-edge text-sm">
        {known.slice(0, 40).map((m) => (
          <li key={m.machineTvId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <MachineLink assetNo={m.assetNo} label={m.label} onMachine={onMachine} />
            <span className={`tabular-nums ${(m.stockPercent ?? 1) < LOW_STOCK ? "font-semibold text-crit" : ""}`}>
              {Math.round((m.stockPercent ?? 0) * 100)} %<span className="text-xs font-normal text-mut">{m.lastRefillAt ? ` · refilled ${ago(m.lastRefillAt)} ago` : ""}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CollectionsDrill({ viewer, onMachine }: { viewer: string; onMachine: (asset: number) => void }) {
  const [r, setR] = useState<DayReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.opsDayReport(viewer, companyToday()).then(setR, (e: unknown) => setErr(e instanceof Error ? e.message : "Could not read the day"));
  }, [viewer]);
  if (err) return <p className="text-sm text-crit">● {err}</p>;
  if (!r) return <Spinner label="Reading today's collections…" />;
  const rows = r.machines.flatMap((m) => m.collections.map((c) => ({ m, c }))).sort((a, b) => b.c.at.localeCompare(a.c.at));
  if (rows.length === 0) return <Empty>No collection logged in Televend today yet.</Empty>;
  return (
    <div className="space-y-2">
      {r.seesExpectedCash ? (
        <ValueBars
          rows={r.machines
            .filter((m) => m.collections.length > 0)
            .map((m) => ({ key: String(m.assetNo ?? 0), name: `${m.assetNo ?? "—"} ${shortLabel(m.label, m.assetNo)}`, value: m.collections.reduce((t, c) => Math.max(t, c.expectedFils ?? 0), 0) / 100 }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 25)}
          unit="AED it should have found (largest collection)"
          format={(n) => `AED ${n.toLocaleString("en-GB")}`}
          onPick={(k) => onMachine(Number(k))}
        />
      ) : null}
      <ul className="divide-y divide-edge text-sm">
        {rows.map(({ m, c }) => (
          <li key={`${m.assetNo}-${c.at}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="flex items-center gap-2">
              <span className="w-12 tabular-nums text-mut">{hhmm(c.at)}</span>
              <MachineLink assetNo={m.assetNo} label={m.label} onMachine={onMachine} />
            </span>
            {c.expectedFils !== null && c.cashVends !== null ? (
              <span className="tabular-nums">
                {aed(c.expectedFils)} <span className="text-xs text-mut">· {c.cashVends} cash sale{c.cashVends === 1 ? "" : "s"} since the one before</span>
              </span>
            ) : (
              <span className="text-xs text-mut">collected</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefillsDrill({ viewer, onMachine }: { viewer: string; onMachine: (asset: number) => void }) {
  const [rows, setRows] = useState<RefillRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.opsRefills(viewer, companyToday()).then(setRows, (e: unknown) => setErr(e instanceof Error ? e.message : "Could not read the refills"));
  }, [viewer]);
  if (err) return <p className="text-sm text-crit">● {err}</p>;
  if (!rows) return <Spinner label="Reading today's refills…" />;
  if (rows.length === 0) return <Empty>No refill logged in Televend today yet.</Empty>;
  return (
    <ul className="divide-y divide-edge text-sm">
      {rows.map((r) => (
        <li key={`${r.at}-${r.assetNo}-${r.change}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
          <span className="flex items-center gap-2">
            <span className="w-12 tabular-nums text-mut">{hhmm(r.at)}</span>
            <MachineLink assetNo={r.assetNo} label={r.label} onMachine={onMachine} />
          </span>
          <span className="tabular-nums">
            {r.action === "filled" ? "+" : ""}
            {r.change} {r.action !== "filled" ? `(${r.action})` : ""}
            <span className="text-xs text-mut">
              {r.after !== null ? ` · ${r.after}${r.capacity ? ` of ${r.capacity}` : ""} after` : ""} · {r.by ?? "—"}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
