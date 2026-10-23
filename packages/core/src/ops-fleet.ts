import { loadConfig } from "./config.js";
import { withContext, type AppContext, type Tx } from "./db.js";
import { alarmDecision, alarmsNow, OpsRefused, UNCLASSIFIED, type AlarmRule, type NeedsAction } from "./ops-alarms.js";
import { OpsDayRefused } from "./ops-sales.js";
import { can, type Actor } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * The fleet (TASK-059): every enabled machine's state now, one machine's page, and a day's report —
 * counted by Postgres over the Televend mirror (CLAUDE.md rule 2), under the viewer's row-level
 * security (televend.read).
 *
 * Expected cash. Televend gives each cash collection's time (the "Cash Collection" event the Staff App
 * writes) but not its amount without the cash-centre permission. What it does give is every cash vend.
 * So the cash a collection should have found is the cash vends between the previous collection and
 * this one × the machine's cash price — 18 of 29 reported collections on 16 Oct matched it exactly at
 * AED 10 a vend, and the other 11 reported MORE (VF75). The window is [previous + 1 min, this + 1 min):
 * a vend in the minute of a collection belongs to it, and no vend falls in two windows.
 */

/**
 * Televend's "should have found" — the cash waiting in a machine, what a collection should have found — goes only to whoever
 * sees all cash (cash.read). A Supervisor handles cash without cash.read: shown the figure, a collector can match it, so they get
 * null (D237; review of 20 Oct — the Operations reads were built before D237 and never applied it).
 */
export const seesExpectedCash = (viewer: Actor): boolean => can(viewer, "cash.read");

const EMIRATE: Readonly<Record<string, string>> = { DXB: "Dubai", SHJ: "Sharjah", AJM: "Ajman", UAQ: "Umm Al Quwain" };

export type MachineState = "offline" | "needs_action" | "warning" | "ok";

export interface FleetMachine {
  machineTvId: number;
  assetNo: number | null;
  label: string;
  /** Televend's grouping: Metro, Hospital / Clinics, Shopping Mall … */
  region: string | null;
  emirate: string | null;
  /** Ours: offline first, then an alarm past its on-delay, then Televend's own warning. */
  state: MachineState;
  lastVendAt: string | null;
  lastRefillAt: string | null;
  lastCashAt: string | null;
  cupsToday: number;
  cashCupsToday: number;
  /** Cash vends since the last collection × the cash price. Null: no collection seen in 60 days — or not for this viewer (D237). */
  cashWaitingFils: number | null;
  /** Televend's stock figure: the share of capacity it thinks is left (below 0 when sales outran the logged fills). */
  stockPercent: number | null;
  problems: Pick<NeedsAction, "alarm" | "severity" | "since" | "advice" | "problem">[];
}

export interface FleetNow {
  at: string;
  machines: FleetMachine[];
  counts: { total: number; ok: number; needsAction: number; warning: number; offline: number };
  cupsToday: number;
  cashCollectionsToday: number;
  refillsToday: number;
  /** Whether this viewer is given Televend's expected cash at all (cash.read, D237). */
  seesExpectedCash: boolean;
  /** Across the fleet, waiting in the machines since each one's last collection — null when not seesExpectedCash. */
  cashWaitingFils: number | null;
  alarms: { needsAction: number; waiting: number; quietNoise: number; problemsEnabled: boolean };
}

const priceDefault = () => loadConfig().OPS_DEFAULT_CASH_PRICE_FILS;

function stateOf(r: { connection_status: number | null; last_status: number | null }, problems: number): MachineState {
  if (r.connection_status === 0) return "offline";
  if (problems > 0) return "needs_action";
  if (r.last_status === 2 || r.last_status === 3) return "warning";
  return "ok";
}

export async function fleetNow(viewer: AppContext & Actor, now: Date = new Date()): Promise<FleetNow> {
  if (!can(viewer, "televend.read")) throw new OpsRefused();
  const alarms = await alarmsNow(viewer, now);
  const price = priceDefault();
  const cashOk = seesExpectedCash(viewer);
  const { rows, day } = await withContext(
    viewer,
    async (sql) => {
      const rows = await sql<
        {
          machine_tv_id: string;
          asset_no: number | null;
          label: string;
          region: string | null;
          emirate_code: string | null;
          last_status: number | null;
          connection_status: number | null;
          last_vend_at: Date | null;
          last_refill_at: Date | null;
          last_cash_at: Date | null;
          cups: number;
          cash_cups: number;
          cash_vends: number | null;
          price_fils: number;
          stock_percent: string | null;
        }[]
      >`
        with d as (select (date_trunc('day', ${now}::timestamptz at time zone 'Asia/Dubai') at time zone 'Asia/Dubai') as d0),
        lc as (
          select machine_tv_id, max(started_at) as at from tv_event
           where name = 'Cash Collection' and started_at > ${now}::timestamptz - interval '60 days' and started_at <= ${now}
           group by 1
        ),
        sold as (
          select v.machine_tv_id, sum(v.quantity)::int as cups, coalesce(sum(v.quantity) filter (where v.payment_type = 0), 0)::int as cash_cups
            from tv_vend v, d where v.at >= d.d0 and v.at <= ${now} group by 1
        ),
        waiting as (
          select v.machine_tv_id, count(*)::int as cash_vends
            from tv_vend v join lc on lc.machine_tv_id = v.machine_tv_id
           where v.payment_type = 0 and v.at >= lc.at + interval '1 minute' and v.at <= ${now}
           group by 1
        )
        select t.televend_id::text as machine_tv_id, coalesce(m.asset_no, t.asset_no) as asset_no, coalesce(m.label, t.caption) as label,
               t.region_caption as region, upper(substring(t.caption from '-\\s*([A-Za-z]{3})\\s*$')) as emirate_code,
               t.last_status, t.connection_status, t.last_vend_at, t.last_refill_at, lc.at as last_cash_at,
               coalesce(s.cups, 0) as cups, coalesce(s.cash_cups, 0) as cash_cups,
               case when lc.at is null then null else coalesce(w.cash_vends, 0) end as cash_vends,
               coalesce(m.cash_price_fils, ${price}) as price_fils, t.stock_percent::text as stock_percent
          from tv_machine t
          left join machine_placement p on p.tv_machine_id = t.televend_id and p.valid_to is null
          left join machine m on m.id = p.machine_id
          left join lc on lc.machine_tv_id = t.televend_id
          left join sold s on s.machine_tv_id = t.televend_id
          left join waiting w on w.machine_tv_id = t.televend_id
         where t.enabled
         order by t.region_caption nulls last, coalesce(m.asset_no, t.asset_no) nulls last`;
      const [day] = await sql<{ collections: number; refills: number }[]>`
        with d as (select (date_trunc('day', ${now}::timestamptz at time zone 'Asia/Dubai') at time zone 'Asia/Dubai') as d0)
        select (select count(*) from tv_event e, d where e.name = 'Cash Collection' and e.started_at >= d.d0 and e.started_at <= ${now})::int as collections,
               (select count(*) from tv_refill r, d where r.action = 'filled' and r.at >= d.d0 and r.at <= ${now})::int as refills`;
      return { rows, day };
    },
    { readOnly: true },
  );

  const byMachine = new Map<number, NeedsAction[]>();
  for (const a of alarms.needsAction) byMachine.set(a.machineTvId, [...(byMachine.get(a.machineTvId) ?? []), a]);
  const machines: FleetMachine[] = rows.map((r) => {
    const id = Number(r.machine_tv_id);
    const problems = byMachine.get(id) ?? [];
    return {
      machineTvId: id,
      assetNo: r.asset_no,
      label: r.label,
      region: r.region,
      emirate: r.emirate_code ? (EMIRATE[r.emirate_code] ?? null) : null,
      state: stateOf(r, problems.length),
      lastVendAt: r.last_vend_at?.toISOString() ?? null,
      lastRefillAt: r.last_refill_at?.toISOString() ?? null,
      lastCashAt: r.last_cash_at?.toISOString() ?? null,
      cupsToday: r.cups,
      cashCupsToday: r.cash_cups,
      cashWaitingFils: !cashOk || r.cash_vends === null ? null : r.cash_vends * r.price_fils,
      stockPercent: r.stock_percent === null ? null : Number(r.stock_percent),
      problems: problems.map((p) => ({ alarm: p.alarm, severity: p.severity, since: p.since, advice: p.advice, problem: p.problem })),
    };
  });
  const count = (s: MachineState) => machines.filter((m) => m.state === s).length;
  return {
    at: now.toISOString(),
    machines,
    counts: { total: machines.length, ok: count("ok"), needsAction: count("needs_action"), warning: count("warning"), offline: count("offline") },
    cupsToday: machines.reduce((n, m) => n + m.cupsToday, 0),
    cashCollectionsToday: day?.collections ?? 0,
    refillsToday: day?.refills ?? 0,
    seesExpectedCash: cashOk,
    cashWaitingFils: cashOk ? machines.reduce((n, m) => n + (m.cashWaitingFils ?? 0), 0) : null,
    alarms: { needsAction: alarms.needsAction.length, waiting: alarms.waiting, quietNoise: alarms.quietNoise, problemsEnabled: alarms.problemsEnabled },
  };
}

// ── One machine ────────────────────────────────────────────────────────────────

export interface CashCollection {
  at: string;
  previousAt: string | null;
  /** Null for a viewer who is not given Televend's expected cash (D237). */
  cashVends: number | null;
  expectedFils: number | null;
}

export interface MachineDetail {
  assetNo: number;
  label: string;
  region: string | null;
  priceFils: number;
  /** Cups per Dubai hour today, 0–23. */
  hourlyToday: number[];
  openAlarms: { alarm: string; since: string; class: AlarmRule["class"]; decision: "wait" | "raise"; advice: string }[];
  /** Alarms started in the last 7 days, by name. */
  alarmsLast7Days: { alarm: string; count: number }[];
  collections: CashCollection[];
  refills: { at: string; action: string; quantity: number; product: string | null; by: string | null }[];
}

/** The last collections of these Televend machine records, each with the cash it should have found — when `withExpected` (D237). */
export async function collectionsOf(sql: Tx, tvIds: string[], priceFils: number, limit: number, until: Date, withExpected: boolean): Promise<CashCollection[]> {
  const rows = await sql<{ at: Date; prev_at: Date | null; cash_vends: number }[]>`
    with c as (
      select e.started_at as at, lag(e.started_at) over (order by e.started_at) as prev_at
        from tv_event e
       where e.machine_tv_id = any(${tvIds}::bigint[]) and e.name = 'Cash Collection' and e.started_at <= ${until}
         and e.started_at > ${until}::timestamptz - interval '120 days'
    )
    select c.at, c.prev_at,
           (select count(*) from tv_vend v
             where v.machine_tv_id = any(${tvIds}::bigint[]) and v.payment_type = 0
               and v.at >= coalesce(c.prev_at, c.at - interval '30 days') + interval '1 minute' and v.at < c.at + interval '1 minute')::int as cash_vends
      from c order by c.at desc limit ${limit}`;
  return rows.map((r) => ({
    at: r.at.toISOString(),
    previousAt: r.prev_at?.toISOString() ?? null,
    cashVends: withExpected ? r.cash_vends : null,
    expectedFils: withExpected ? r.cash_vends * priceFils : null,
  }));
}

export async function machineDetail(viewer: AppContext & Actor, assetNo: number, now: Date = new Date()): Promise<MachineDetail | null> {
  if (!can(viewer, "televend.read")) throw new OpsRefused();
  const price = priceDefault();
  return withContext(
    viewer,
    async (sql) => {
      const [m] = await sql<{ label: string; region: string | null; price_fils: number; tv_ids: string[]; current_tv: string | null }[]>`
        select coalesce(m.label, t.caption) as label, t.region_caption as region, coalesce(m.cash_price_fils, ${price}) as price_fils,
               array(select p2.tv_machine_id::text from machine_placement p2 where p2.machine_id = m.id) as tv_ids,
               t.televend_id::text as current_tv
          from machine m
          left join machine_placement p on p.machine_id = m.id and p.valid_to is null
          left join tv_machine t on t.televend_id = p.tv_machine_id
         where m.asset_no = ${assetNo}`;
      if (!m) return null;
      const ids = m.tv_ids.length > 0 ? m.tv_ids : m.current_tv ? [m.current_tv] : [];
      const hours = await sql<{ hour: number; cups: number }[]>`
        with d as (select (date_trunc('day', ${now}::timestamptz at time zone 'Asia/Dubai') at time zone 'Asia/Dubai') as d0)
        select extract(hour from v.at at time zone 'Asia/Dubai')::int as hour, sum(v.quantity)::int as cups
          from tv_vend v, d where v.machine_tv_id = any(${ids}::bigint[]) and v.at >= d.d0 and v.at <= ${now}
         group by 1`;
      const hourlyToday = Array.from({ length: 24 }, (_, h) => hours.find((x) => x.hour === h)?.cups ?? 0);
      const open = await sql<{ name: string; since: Date; class: AlarmRule["class"] | null; on_delay_minutes: number | null; advice: string | null }[]>`
        select coalesce(e.name, '(unnamed alarm)') as name, min(e.started_at) as since, r.class, r.on_delay_minutes, r.advice
          from tv_event e left join alarm_rule r on r.name = e.name
         where e.machine_tv_id = any(${ids}::bigint[]) and e.kind in ('alarm', 'warning') and e.resolved_at is null
           and e.started_at <= ${now}
           -- The last 14 days — and, whatever its age, an alarm behind a problem still open, which the re-check keeps reading
           -- (D260): a screen never drops an alarm the problems board still pages about (review of the fixes, 20 Oct).
           and (e.started_at > ${now}::timestamptz - interval '14 days'
                or exists (select 1 from machine_alarm mb join blocker bb on bb.id = mb.blocker_id
                            where mb.event_source = e.source and mb.event_id = e.external_id and bb.status in ('open', 'acknowledged')))
         group by 1, 3, 4, 5 order by 2`;
      const week = await sql<{ name: string; count: number }[]>`
        select coalesce(e.name, '(unnamed alarm)') as name, count(*)::int as count from tv_event e
         where e.machine_tv_id = any(${ids}::bigint[]) and e.kind in ('alarm', 'warning')
           and e.started_at > ${now}::timestamptz - interval '7 days' and e.started_at <= ${now}
         group by 1 order by 2 desc`;
      const refills = await sql<{ at: Date; action: string; quantity_change: string; product: string | null; filled_by: string | null }[]>`
        select at, action, quantity_change, product, filled_by from tv_refill
         where machine_tv_id = any(${ids}::bigint[]) and at <= ${now} order by at desc limit 10`;
      return {
        assetNo,
        label: m.label,
        region: m.region,
        priceFils: m.price_fils,
        hourlyToday,
        openAlarms: open
          .map((o) => {
            const rule = o.class ? { class: o.class, onDelayMinutes: o.on_delay_minutes ?? 0 } : UNCLASSIFIED;
            const decision = alarmDecision(rule, { startedAt: o.since, resolvedAt: null }, now);
            return { alarm: o.name, since: o.since.toISOString(), class: rule.class, decision, advice: o.advice ?? UNCLASSIFIED.advice };
          })
          .filter((o): o is typeof o & { decision: "wait" | "raise" } => o.decision !== "ignore"),
        alarmsLast7Days: week.map((w) => ({ alarm: w.name, count: w.count })),
        collections: await collectionsOf(sql, ids, m.price_fils, 10, now, seesExpectedCash(viewer)),
        refills: refills.map((r) => ({ at: r.at.toISOString(), action: r.action, quantity: Number(r.quantity_change), product: r.product, by: r.filled_by })),
      };
    },
    { readOnly: true },
  );
}

// ── A day's report ─────────────────────────────────────────────────────────────

export interface DayReportMachine {
  assetNo: number | null;
  label: string;
  region: string | null;
  cups: number;
  cashCups: number;
  cardCups: number;
  otherCups: number;
  /** Null figures for a viewer who is not given Televend's expected cash (D237). */
  collections: { at: string; cashVends: number | null; expectedFils: number | null }[];
  refills: number;
  /**
   * Alarms that started that day and stayed open past their rule's wait (on-delay) — whatever their
   * class: a "noise" alarm that lasted hours needed someone too. Counted by what happened, not by rule
   * (review 2026-10-17, command-centre#6). Info rules are left out.
   */
  alarmsNeedingSomeone: number;
  /** Alarms that started that day and cleared within their wait. */
  alarmsClearedThemselves: number;
}

export interface DayReport {
  date: string;
  /** Whether this viewer is given Televend's expected cash at all (cash.read, D237). */
  seesExpectedCash: boolean;
  machines: DayReportMachine[];
  totals: {
    cups: number;
    cashCups: number;
    cardCups: number;
    collections: number;
    expectedCashFils: number | null;
    refills: number;
    alarmsNeedingSomeone: number;
    alarmsClearedThemselves: number;
    /** Enabled machines with no sale all day. */
    silentMachines: number;
  };
}

/**
 * Everything the machines did on one Dubai day: cups by how they were paid, each cash collection with
 * the cash it should have found, refills, alarms. The yesterday-report the CEO used to assemble from
 * the WhatsApp groups — except that the cash here is what Televend says should be there, not what
 * anyone typed. Days not fully in the mirror are the caller's to flag (salesByHour.covered).
 */
export async function dayReport(viewer: AppContext & Actor, date: string, now: Date = new Date()): Promise<DayReport> {
  if (!can(viewer, "televend.read")) throw new OpsRefused();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+04:00`))) {
    throw new OpsDayRefused("The day must be a date, YYYY-MM-DD.");
  }
  if (date > localDate(now)) throw new OpsDayRefused("That day has not begun yet.");
  const d0 = new Date(`${date}T00:00:00+04:00`);
  const price = priceDefault();
  const cashOk = seesExpectedCash(viewer);
  const rows = await withContext(
    viewer,
    (sql) => sql<
      {
        machine_tv_id: string;
        asset_no: number | null;
        label: string;
        region: string | null;
        enabled: boolean;
        price_fils: number;
        cups: number;
        cash_cups: number;
        card_cups: number;
        refills: number;
        needed: number;
        cleared: number;
        collections: { at: string; cash_vends: number }[] | null;
      }[]
    >`
      with d as (select ${d0}::timestamptz as d0, ${d0}::timestamptz + interval '1 day' as d1),
      sold as (
        select v.machine_tv_id, sum(v.quantity)::int as cups,
               coalesce(sum(v.quantity) filter (where v.payment_type = 0), 0)::int as cash_cups,
               coalesce(sum(v.quantity) filter (where v.payment_type in (1, 2, 3)), 0)::int as card_cups
          from tv_vend v, d where v.at >= d.d0 and v.at < d.d1 group by 1
      ),
      cols as (
        select e.machine_tv_id, e.started_at as at, lag(e.started_at) over (partition by e.machine_tv_id order by e.started_at) as prev_at
          from tv_event e, d
         where e.name = 'Cash Collection' and e.started_at > d.d0 - interval '60 days' and e.started_at < d.d1
      ),
      day_cols as (
        select c.machine_tv_id, c.at,
               (select count(*) from tv_vend v
                 where v.machine_tv_id = c.machine_tv_id and v.payment_type = 0
                   and v.at >= coalesce(c.prev_at, c.at - interval '30 days') + interval '1 minute'
                   and v.at < c.at + interval '1 minute')::int as cash_vends
          from cols c, d where c.at >= d.d0 and c.at < d.d1
      ),
      fills as (select r.machine_tv_id, count(*)::int as n from tv_refill r, d where r.action = 'filled' and r.at >= d.d0 and r.at < d.d1 group by 1),
      alarms as (
        select e.machine_tv_id,
               -- Still open: measured to now, not to the day's end — an alarm from 23:45 still open in the morning needed someone
               -- (review, 20 Oct: it was counted in neither group). For today's report the two are the same.
               count(*) filter (where coalesce(e.resolved_at, ${now}::timestamptz) - e.started_at
                                      >= make_interval(mins => coalesce(ar.on_delay_minutes, 30)))::int as needed,
               count(*) filter (where e.resolved_at is not null
                                  and e.resolved_at - e.started_at < make_interval(mins => coalesce(ar.on_delay_minutes, 30)))::int as cleared
          from tv_event e left join alarm_rule ar on ar.name = coalesce(e.name, '(unnamed alarm)'), d
         where e.kind in ('alarm', 'warning') and e.started_at >= d.d0 and e.started_at < d.d1
           and coalesce(ar.class, 'actionable') <> 'info'
         group by 1
      )
      select t.televend_id::text as machine_tv_id, coalesce(m.asset_no, t.asset_no) as asset_no, coalesce(m.label, t.caption) as label,
             t.region_caption as region, t.enabled, coalesce(m.cash_price_fils, ${price}) as price_fils,
             coalesce(s.cups, 0) as cups, coalesce(s.cash_cups, 0) as cash_cups, coalesce(s.card_cups, 0) as card_cups,
             coalesce(f.n, 0) as refills, coalesce(a.needed, 0) as needed, coalesce(a.cleared, 0) as cleared,
             (select json_agg(json_build_object('at', dc.at, 'cash_vends', dc.cash_vends) order by dc.at)
                from day_cols dc where dc.machine_tv_id = t.televend_id) as collections
        from tv_machine t
        left join machine_placement p on p.tv_machine_id = t.televend_id and p.valid_to is null
        left join machine m on m.id = p.machine_id
        left join sold s on s.machine_tv_id = t.televend_id
        left join fills f on f.machine_tv_id = t.televend_id
        left join alarms a on a.machine_tv_id = t.televend_id
       where t.enabled or s.cups is not null or f.n is not null or exists (select 1 from day_cols dc where dc.machine_tv_id = t.televend_id)
       order by t.region_caption nulls last, coalesce(m.asset_no, t.asset_no) nulls last`,
    { readOnly: true },
  );
  const machines: DayReportMachine[] = rows.map((r) => ({
    assetNo: r.asset_no,
    label: r.label,
    region: r.region,
    cups: r.cups,
    cashCups: r.cash_cups,
    cardCups: r.card_cups,
    otherCups: r.cups - r.cash_cups - r.card_cups,
    collections: (r.collections ?? []).map((c) => ({
      at: new Date(c.at).toISOString(),
      cashVends: cashOk ? c.cash_vends : null,
      expectedFils: cashOk ? c.cash_vends * r.price_fils : null,
    })),
    refills: r.refills,
    alarmsNeedingSomeone: r.needed,
    alarmsClearedThemselves: r.cleared,
  }));
  const sum = (f: (m: DayReportMachine) => number) => machines.reduce((n, m) => n + f(m), 0);
  return {
    date,
    seesExpectedCash: cashOk,
    machines,
    totals: {
      cups: sum((m) => m.cups),
      cashCups: sum((m) => m.cashCups),
      cardCups: sum((m) => m.cardCups),
      collections: sum((m) => m.collections.length),
      expectedCashFils: cashOk ? sum((m) => m.collections.reduce((n, c) => n + (c.expectedFils ?? 0), 0)) : null,
      refills: sum((m) => m.refills),
      alarmsNeedingSomeone: sum((m) => m.alarmsNeedingSomeone),
      alarmsClearedThemselves: sum((m) => m.alarmsClearedThemselves),
      silentMachines: rows.filter((r) => r.enabled && r.cups === 0).length,
    },
  };
}
