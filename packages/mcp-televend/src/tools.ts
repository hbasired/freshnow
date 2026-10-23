import {
  CASH_COLLECTED_DESCRIPTION,
  EVENT_LEVEL,
  assetNumber,
  dubaiDay,
  refillCupsDelta,
  type TelevendSource,
  type TvEvent,
  type TvMachine,
  type TvRefill,
} from "@freshnow/televend";

/**
 * What each MCP tool returns, computed here in code — never by a model (CLAUDE.md rule 2:
 * "the model never counts, sums or aggregates"). A tool hands the model a small, bounded,
 * already-computed answer: totals first, then at most MAX_ROWS rows as evidence, and an
 * explicit `truncated` / `complete` flag whenever something was cut.
 *
 * Personal data: Televend records who filled each machine. By default a tool shows initials
 * only ("K.S."), which is enough to tell people apart in an answer; full names only when the
 * caller asks for them. (The model's context is a processor of whatever we put in it.)
 */

export const MAX_ROWS = 50;

/** "2026-10-12 04:51" in Asia/Dubai. */
export function dubaiTime(d: Date | null): string | null {
  if (!d) return null;
  return new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

export function initials(name: string | null): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts.map((p) => `${p[0]?.toUpperCase()}.`).join("") : null;
}

function bump<K>(m: Map<K, number>, k: K, by = 1): void {
  m.set(k, (m.get(k) ?? 0) + by);
}

const top = <K>(m: Map<K, number>, n: number): [K, number][] => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

export function machinesSummary(machines: TvMachine[], opts: { enabledOnly: boolean; search?: string | undefined; limit: number }) {
  const q = opts.search?.trim().toLowerCase();
  const filtered = machines
    .filter((m) => !opts.enabledOnly || m.enabled)
    .filter((m) => !q || m.caption.toLowerCase().includes(q) || String(assetNumber(m.caption) ?? "") === q);
  const limit = Math.min(Math.max(opts.limit, 1), MAX_ROWS);
  return {
    totalMachines: machines.length,
    enabledMachines: machines.filter((m) => m.enabled).length,
    matching: filtered.length,
    truncated: filtered.length > limit,
    rows: filtered.slice(0, limit).map((m) => ({
      televendId: m.televendId,
      asset: assetNumber(m.caption),
      name: m.caption,
      region: m.regionCaption,
      type: m.machineTypeCaption,
      enabled: m.enabled,
      lastVend: dubaiTime(m.lastVendAt),
      lastRefill: dubaiTime(m.lastRefillAt),
      stockPercent: m.stockPercent,
    })),
  };
}

export async function salesDay(source: TelevendSource, day: string) {
  const range = dubaiDay(day);
  const list = await source.vends(range, { maxRows: 20_000 });
  const totals = await source.vendTotals(range);
  if (!list) return { day, available: false, reason: `the ${source.transport} transport has no vend data` };
  const byPayment = new Map<string, number>();
  const byMachine = new Map<string, number>();
  let cups = 0;
  let value = 0;
  let valued = 0;
  for (const v of list.rows) {
    cups += v.quantity;
    bump(byPayment, v.paymentTypeCaption ?? `type ${v.paymentType}`, v.quantity);
    bump(byMachine, v.machineCaption ?? `machine ${v.machineTelevendId}`, v.quantity);
    if (v.value !== null) {
      value += v.value;
      valued++;
    }
  }
  return {
    day,
    complete: list.complete,
    cupsSold: cups,
    vendRecords: list.rows.length,
    televendOwnCount: totals?.vends ?? null,
    countsAgree: totals ? totals.vends === list.rows.length : null,
    byPaymentType: Object.fromEntries(top(byPayment, 20)),
    revenueAed: valued === list.rows.length && valued > 0 ? Math.round(value * 100) / 100 : null,
    revenueNote: valued < list.rows.length ? "vend values are hidden from this Televend account (needs the vend-revenue permission)" : undefined,
    topMachinesByCups: top(byMachine, 20).map(([name, n]) => ({ name, asset: assetNumber(name), cups: n })),
    machinesWithSales: byMachine.size,
  };
}

const levelName = (e: TvEvent): string =>
  typeof e.level === "number" ? (EVENT_LEVEL[e.level] ?? `level ${e.level}`) : String(e.type ?? "unknown").toLowerCase();

export async function eventsDay(
  source: TelevendSource,
  day: string,
  opts: { level: "alarm" | "warning" | "info" | "all"; asset?: number | undefined; limit: number },
) {
  const range = dubaiDay(day);
  const r = await source.events(range, { maxRows: 20_000 });
  if (!r) return { day, available: false };
  const byLevel = new Map<string, number>();
  for (const e of r.rows) bump(byLevel, levelName(e));
  const picked = r.rows
    .filter((e) => opts.level === "all" || levelName(e) === opts.level)
    .filter((e) => opts.asset === undefined || assetNumber(e.machineCaption) === opts.asset);
  const byWhat = new Map<string, number>();
  for (const e of picked) bump(byWhat, e.name ?? e.description ?? "(no description)");
  const limit = Math.min(Math.max(opts.limit, 1), MAX_ROWS);
  return {
    day,
    complete: r.complete,
    allEventsByLevel: Object.fromEntries(byLevel),
    selected: picked.length,
    unresolved: picked.filter((e) => !e.resolvedAt).length,
    topReasons: top(byWhat, 15).map(([what, n]) => ({ what, count: n })),
    truncated: picked.length > limit,
    rows: picked
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit)
      .map((e) => ({
        machine: e.machineCaption,
        asset: assetNumber(e.machineCaption),
        level: levelName(e),
        what: e.name ?? e.description,
        started: dubaiTime(e.startedAt),
        resolved: dubaiTime(e.resolvedAt),
        // Televend sometimes reports a repeating alarm "resolved" before its latest start
        // (seen 2026-10-12: started 23:54, resolved 23:45). Never print a negative duration.
        minutesOpen:
          e.resolvedAt && e.resolvedAt >= e.startedAt ? Math.round((e.resolvedAt.getTime() - e.startedAt.getTime()) / 60_000) : null,
        ...(e.resolvedAt && e.resolvedAt < e.startedAt && { note: "Televend shows this resolved before its latest start" }),
        ...(e.counter !== null && e.counter > 1 && { repeats: e.counter }),
      })),
  };
}

/**
 * The Televend records of one physical machine: every record — enabled or not — whose name carries
 * that asset number, by the same rule the mirror and the row filter use (a moved machine keeps
 * refills on its old, disabled record, G160).
 */
export function recordsForAsset(machines: readonly TvMachine[], asset: number): { televendId: number; caption: string; enabled: boolean }[] {
  return machines
    .filter((m): m is TvMachine & { televendId: number } => m.televendId !== null && assetNumber(m.caption) === asset)
    .map((m) => ({ televendId: m.televendId, caption: m.caption, enabled: m.enabled }));
}

export async function refillsDay(
  source: TelevendSource,
  day: string,
  opts: {
    asset?: number | undefined;
    names: "initials" | "full";
    limit: number;
    machineIds?: readonly number[] | undefined;
    records?: readonly { televendId: number; caption: string; enabled: boolean }[] | undefined;
  },
) {
  const rows = await source.refills(day, opts.machineIds);
  if (!rows) return { day, available: false };
  const picked = rows.filter((r) => opts.asset === undefined || assetNumber(r.machineCaption) === opts.asset);
  const who = (r: TvRefill) => (opts.names === "full" ? r.filledBy : initials(r.filledBy));
  const byPerson = new Map<string, number>();
  const byAction = new Map<string, number>();
  for (const r of picked) {
    if (r.action === "filled") bump(byPerson, who(r) ?? "(unknown)", r.quantityChange);
    bump(byAction, r.action);
  }
  const limit = Math.min(Math.max(opts.limit, 1), MAX_ROWS);
  return {
    day,
    rows: picked.length,
    cupsFilled: picked.filter((r) => r.action === "filled").reduce((s, r) => s + r.quantityChange, 0),
    // A removal takes cups out; a row whose code has no known meaning is counted, never guessed.
    netCupsChange: picked.reduce((s, r) => s + (refillCupsDelta(r) ?? 0), 0),
    ...(picked.some((r) => refillCupsDelta(r) === null) && {
      rowsOfUnknownMeaning: picked.filter((r) => refillCupsDelta(r) === null).length,
    }),
    ...(opts.records && { records: opts.records }),
    machinesVisited: new Set(picked.map((r) => r.machineCaption)).size,
    byAction: Object.fromEntries(byAction),
    cupsFilledByPerson: Object.fromEntries(top(byPerson, 30)),
    truncated: picked.length > limit,
    sample: picked.slice(0, limit).map((r) => ({
      at: dubaiTime(r.at),
      machine: r.machineCaption,
      asset: assetNumber(r.machineCaption),
      by: who(r),
      action: r.action,
      cups: r.quantityChange,
      after: r.quantityAfter,
      capacity: r.capacity,
      via: r.origin,
    })),
  };
}

export async function cashCollectionsDay(source: TelevendSource, day: string) {
  const r = await source.events(dubaiDay(day), { maxRows: 20_000 });
  if (!r) return { day, available: false };
  const hits = r.rows.filter((e) => (e.description ?? "").trim() === CASH_COLLECTED_DESCRIPTION);
  const byMachine = new Map<string, string[]>();
  for (const e of hits) {
    const k = e.machineCaption ?? "?";
    byMachine.set(k, [...(byMachine.get(k) ?? []), dubaiTime(e.startedAt) ?? ""]);
  }
  return {
    day,
    complete: r.complete,
    source: "Televend machine events 'Cash has been collected from the machine.' (amounts need the cash-centre permission)",
    collections: hits.length,
    machines: byMachine.size,
    rows: [...byMachine.entries()]
      .slice(0, MAX_ROWS)
      .map(([machine, times]) => ({ machine, asset: assetNumber(machine), times: times.sort() })),
    truncated: byMachine.size > MAX_ROWS,
  };
}
