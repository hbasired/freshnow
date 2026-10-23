import { loadConfig } from "./config.js";
import { getServiceSql, withContext, type AppContext } from "./db.js";
import { collectionsOf, seesExpectedCash, type CashCollection, type MachineState } from "./ops-fleet.js";
import { alarmDecision, OpsRefused, UNCLASSIFIED, type AlarmRule } from "./ops-alarms.js";
import { can, type Actor } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * One machine as a full page (TASK-072, R11, R7.3–7.5) — everything FreshNow knows about it, across every Televend record it has
 * had (a machine that moves gets a new record: asset 796 has had four, G160), counted by Postgres under the viewer's row-level
 * security (televend.read; visits need routes.plan, which every role that reads Televend's data has).
 *
 * Stock (Televend's figure, an estimate): `stock_percent` is the share of capacity Televend thinks is left — it goes below zero
 * when sales outrun the fills logged in the Staff App (seen at −0.22, VF90). Cups left ≈ that share × the capacity of each column
 * (from the newest refill) × the columns. Said as "about", with the figure it came from.
 *
 * Prices (A-T70.3, VF89 evidence): the cash price is the one set on the machine, else AED 10 — what the collections match; the card
 * price is the "AED n" in the Televend name, else the cash price. Cash collected at machines named "AED 12" came in tens
 * (Nad Al Hammar 789: AED 110 and 160), so the name's price is the card price.
 *
 * Today is compared with the same weekday a week before, up to the same minute; earlier days with the same weekday a week before;
 * a day the sync did not read to its end is empty, never zero.
 */

const EMIRATE: Readonly<Record<string, string>> = { DXB: "Dubai", SHJ: "Sharjah", AJM: "Ajman", UAQ: "Umm Al Quwain" };
const DAYS_SHOWN = 28;

export interface MachinePlace {
  televendId: number;
  caption: string;
  region: string | null;
  enabled: boolean;
  current: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface MachinePage {
  assetNo: number;
  label: string;
  category: string | null;
  televendRegion: string | null;
  corrected: boolean;
  emirate: string | null;
  cardOnly: boolean;
  prices: { cashFils: number; cashSource: "set" | "default"; cardFils: number; cardSource: "name" | "cash" };
  status: {
    state: MachineState;
    connection: "online" | "offline" | "unknown";
    signal: number | null;
    lastSaleAt: string | null;
    lastRefillAt: string | null;
    lastCollectionAt: string | null;
  };
  stock: { percent: number | null; columns: number | null; capacityPerColumn: number | null; cupsLeft: number | null; negative: boolean };
  /** Every Televend record this machine has had, newest first. */
  places: MachinePlace[];
  today: {
    date: string;
    /** How far Televend has been read; sales after it are not in yet. */
    readUntil: string | null;
    hours: { hour: number; cups: number; cupsWeekBefore: number | null }[];
    cups: number;
    /** The same weekday a week before, up to the same minute (null when that day was not read). */
    cupsWeekBeforeSameTime: number | null;
  };
  days: { date: string; cups: number | null; weekBefore: number | null }[];
  /** The last 7 days' cups by payment. */
  payments: { caption: string; cups: number }[];
  recentSales: { at: string; payment: string | null; product: string | null }[];
  refills: { at: string; action: string; change: number; after: number | null; capacity: number | null; by: string | null }[];
  /** Whether Televend's expected cash is given to this viewer (cash.read, D237): if not, collections carry only their times. */
  seesExpectedCash: boolean;
  collections: CashCollection[];
  alarms: {
    open: { alarm: string; since: string; class: AlarmRule["class"]; decision: "wait" | "raise"; advice: string }[];
    last7Days: { alarm: string; count: number }[];
    recent: { alarm: string; startedAt: string; resolvedAt: string | null }[];
  };
  visits: { at: string; by: string; how: "qr" | "typed"; endedAt: string | null; proof: number }[];
  notes: { machine: string | null; serviceShift: "day" | "night" | null; serviceNote: string | null; categoryNote: string | null };
}

export async function machinePage(viewer: AppContext & Actor, assetNo: number, now: Date = new Date()): Promise<MachinePage | null> {
  if (!can(viewer, "televend.read")) throw new OpsRefused();
  if (!Number.isInteger(assetNo) || assetNo < 1 || assetNo > 99_999) return null;
  const defaultPrice = loadConfig().OPS_DEFAULT_CASH_PRICE_FILS;
  const today = localDate(now);
  return withContext(
    viewer,
    async (sql) => {
      const [m] = await sql<
        {
          label: string;
          override: string | null;
          category_note: string | null;
          notes: string | null;
          service_shift: "day" | "night" | null;
          service_note: string | null;
          cash_price_fils: number | null;
          current_tv: string | null;
          caption: string | null;
          region: string | null;
          enabled: boolean | null;
          last_status: number | null;
          connection_status: number | null;
          signal_strength: number | null;
          last_vend_at: Date | null;
          last_refill_at: Date | null;
          stock_percent: string | null;
          num_column: number | null;
          tv_ids: string[];
        }[]
      >`
        select coalesce(m.label, t.caption) as label, m.category_override as override, m.category_note, m.notes,
               m.service_shift, m.service_note, m.cash_price_fils,
               t.televend_id::text as current_tv, t.caption, t.region_caption as region, t.enabled,
               t.last_status, t.connection_status, t.signal_strength, t.last_vend_at, t.last_refill_at,
               t.stock_percent::text as stock_percent, (t.raw->'stock_data'->>'num_column')::int as num_column,
               array(select p2.tv_machine_id::text from machine_placement p2 where p2.machine_id = m.id) as tv_ids
          from machine m
          left join machine_placement p on p.machine_id = m.id and p.valid_to is null
          left join tv_machine t on t.televend_id = p.tv_machine_id
         where m.asset_no = ${assetNo}`;
      if (!m) return null;
      const ids = m.tv_ids.length > 0 ? m.tv_ids : m.current_tv ? [m.current_tv] : [];

      const places = await sql<{ televend_id: string; caption: string; region: string | null; enabled: boolean; first_seen: Date | null; last_seen: Date | null }[]>`
        select t.televend_id::text, t.caption, t.region_caption as region, t.enabled,
               (select min(c.first_seen_at) from tv_machine_caption c where c.televend_id = t.televend_id) as first_seen,
               (select max(c.last_seen_at) from tv_machine_caption c where c.televend_id = t.televend_id) as last_seen
          from tv_machine t where t.televend_id = any(${ids}::bigint[])
         order by t.enabled desc, last_seen desc nulls last`;

      // Today by hour against the same weekday a week before; the week before only up to the same minute in its total.
      const [cut] = await sql<{ d0: Date; read_until: Date | null; week_read: boolean }[]>`
        with b as (select (${today}::date::timestamp at time zone 'Asia/Dubai') as d0),
        reads as (
          select range_agg(tstzrange(r.window_from, r.window_to)) as m from tv_sync_run r, b
           where r.stream = 'vends' and r.complete and r.window_to > r.window_from
             and r.window_to > b.d0 - interval '7 days' and r.window_from < b.d0 - interval '6 days'
        )
        select b.d0, least(${now}::timestamptz, (select read_until from tv_sync_cursor where stream = 'vends')) as read_until,
               coalesce(tstzrange(b.d0 - interval '7 days', b.d0 - interval '6 days') <@ reads.m, false) as week_read
          from b, reads`;
      const hours = await sql<{ this_day: boolean; hour: number; cups: number }[]>`
        select v.at >= ${cut!.d0} as this_day, extract(hour from v.at at time zone 'Asia/Dubai')::int as hour, sum(v.quantity)::int as cups
          from tv_vend v
         where v.machine_tv_id = any(${ids}::bigint[])
           and ((v.at >= ${cut!.d0} and v.at <= ${now}) or (v.at >= ${cut!.d0}::timestamptz - interval '7 days' and v.at < ${cut!.d0}::timestamptz - interval '6 days'))
         group by 1, 2`;
      const [same] = await sql<{ cups: number }[]>`
        select coalesce(sum(v.quantity), 0)::int as cups from tv_vend v
         where v.machine_tv_id = any(${ids}::bigint[])
           and v.at >= ${cut!.d0}::timestamptz - interval '7 days'
           and v.at < coalesce(${cut!.read_until}::timestamptz, ${now}::timestamptz) - interval '7 days'`;

      // The last 28 days and the same weekday a week before each, read days only.
      const first = new Date(Date.parse(`${today}T00:00:00Z`) - (DAYS_SHOWN + 7) * 86_400_000).toISOString().slice(0, 10);
      const dayRows = await sql<{ day: string; covered: boolean; cups: number }[]>`
        with reads as (
          select range_agg(tstzrange(r.window_from, r.window_to)) as m from tv_sync_run r
           where r.stream = 'vends' and r.complete and r.window_to > r.window_from
             and r.window_to > (${first}::date::timestamp at time zone 'Asia/Dubai') and r.window_from < (${today}::date::timestamp at time zone 'Asia/Dubai')
        ),
        sold as (
          select (v.at at time zone 'Asia/Dubai')::date as day, sum(v.quantity)::int as cups from tv_vend v
           where v.machine_tv_id = any(${ids}::bigint[])
             and v.at >= (${first}::date::timestamp at time zone 'Asia/Dubai') and v.at < (${today}::date::timestamp at time zone 'Asia/Dubai')
           group by 1
        )
        select to_char(d, 'YYYY-MM-DD') as day,
               coalesce(tstzrange(d::date::timestamp at time zone 'Asia/Dubai', (d::date + 1)::timestamp at time zone 'Asia/Dubai') <@ reads.m, false) as covered,
               coalesce(s.cups, 0) as cups
          from reads, generate_series(${first}::date, (${today}::date - 1), interval '1 day') as d
          left join sold s on s.day = d::date
         order by d`;
      const byDay = new Map(dayRows.map((r) => [r.day, r]));
      const at = (d: string): number | null => {
        const r = byDay.get(d);
        return r && r.covered ? r.cups : null;
      };

      const payments = await sql<{ caption: string; cups: number }[]>`
        select coalesce(v.payment_caption, 'Other') as caption, sum(v.quantity)::int as cups from tv_vend v
         where v.machine_tv_id = any(${ids}::bigint[]) and v.at > ${now}::timestamptz - interval '7 days' and v.at <= ${now}
         group by 1 order by 2 desc`;
      const recent = await sql<{ at: Date; payment: string | null; product: string | null }[]>`
        select v.at, v.payment_caption as payment, v.product from tv_vend v
         where v.machine_tv_id = any(${ids}::bigint[]) and v.at <= ${now} order by v.at desc limit 30`;
      const refills = await sql<{ at: Date; action: string; change: string; after: string | null; capacity: string | null; by: string | null }[]>`
        select r.at, r.action, r.quantity_change::text as change, r.quantity_after::text as after, r.capacity::text as capacity, r.filled_by as by
          from tv_refill r where r.machine_tv_id = any(${ids}::bigint[]) and r.at <= ${now} order by r.at desc limit 15`;
      const [lastCash] = await sql<{ at: Date | null }[]>`
        select max(e.started_at) as at from tv_event e where e.machine_tv_id = any(${ids}::bigint[]) and e.name = 'Cash Collection' and e.started_at <= ${now}`;
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
      const recentAlarms = await sql<{ name: string; started_at: Date; resolved_at: Date | null }[]>`
        select coalesce(e.name, '(unnamed alarm)') as name, e.started_at, e.resolved_at from tv_event e
         where e.machine_tv_id = any(${ids}::bigint[]) and e.kind in ('alarm', 'warning') and e.started_at <= ${now}
         order by e.started_at desc limit 10`;
      // Visits as row security lets this viewer see them (routes.plan sees all); the names of those people are looked up
      // apart — a Supervisor may read the visit but not every person's employee row.
      const visitRows = await sql<{ at: Date; employee_id: string; how: "qr" | "typed"; ended_at: Date | null; proof: number }[]>`
        select v.started_at as at, v.employee_id, v.started_how as how, v.ended_at,
               (select count(*)::int from visit_evidence ve where ve.visit_id = v.id and ve.removed_at is null) as proof
          from visit v join machine mm on mm.id = v.machine_id
         where mm.asset_no = ${assetNo} order by v.started_at desc limit 10`;
      const who = new Map(
        visitRows.length === 0
          ? []
          : (await getServiceSql()<{ id: string; name: string }[]>`
              select id, display_name as name from employee where id = any(${[...new Set(visitRows.map((v) => v.employee_id))]}::uuid[])`).map((e) => [e.id, e.name] as const),
      );
      const visits = visitRows.map((v) => ({ at: v.at, by: who.get(v.employee_id) ?? "—", how: v.how, ended_at: v.ended_at, proof: v.proof }));

      // A whole word, as in analytics: "Al Raed 2 Tower" names no price (review, 20 Oct).
      const nameAed = /\baed\s*(\d{1,3})(?!\d)/i.exec(m.caption ?? "");
      const cashFils = m.cash_price_fils ?? defaultPrice;
      const cardFils = nameAed ? Number(nameAed[1]) * 100 : cashFils;
      const capacity = refills.find((r) => r.capacity !== null && Number(r.capacity) > 0)?.capacity ?? null;
      const pct = m.stock_percent === null ? null : Number(m.stock_percent);
      const columns = m.num_column ?? null;
      const openMapped = open
        .map((o) => {
          const rule = o.class ? { class: o.class, onDelayMinutes: o.on_delay_minutes ?? 0 } : UNCLASSIFIED;
          const decision = alarmDecision(rule, { startedAt: o.since, resolvedAt: null }, now);
          return { alarm: o.name, since: o.since.toISOString(), class: rule.class, decision, advice: o.advice ?? UNCLASSIFIED.advice };
        })
        .filter((o): o is typeof o & { decision: "wait" | "raise" } => o.decision !== "ignore");
      const state: MachineState =
        m.connection_status === 0 ? "offline" : openMapped.some((o) => o.decision === "raise") ? "needs_action" : m.last_status === 2 || m.last_status === 3 ? "warning" : "ok";
      const emirate = /-\s*(DXB|SHJ|AJM|UAQ)\s*$/i.exec(m.caption ?? "")?.[1]?.toUpperCase() ?? null;
      const days = Array.from({ length: DAYS_SHOWN }, (_, i) => {
        const date = new Date(Date.parse(`${today}T00:00:00Z`) - (DAYS_SHOWN - i) * 86_400_000).toISOString().slice(0, 10);
        const weekBefore = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
        return { date, cups: at(date), weekBefore: at(weekBefore) };
      });
      return {
        assetNo,
        label: m.label,
        category: m.override ?? m.region,
        televendRegion: m.region,
        corrected: m.override !== null,
        emirate: emirate ? (EMIRATE[emirate] ?? null) : null,
        cardOnly: /\bcard\b/i.test(m.caption ?? ""),
        prices: { cashFils, cashSource: m.cash_price_fils === null ? "default" : "set", cardFils, cardSource: nameAed ? "name" : "cash" },
        status: {
          state,
          connection: m.connection_status === 0 ? "offline" : m.connection_status === null ? "unknown" : "online",
          signal: m.signal_strength,
          lastSaleAt: m.last_vend_at?.toISOString() ?? null,
          lastRefillAt: m.last_refill_at?.toISOString() ?? null,
          lastCollectionAt: lastCash?.at?.toISOString() ?? null,
        },
        stock: {
          percent: pct,
          columns,
          capacityPerColumn: capacity === null ? null : Number(capacity),
          cupsLeft: pct === null || capacity === null ? null : Math.round(pct * Number(capacity) * (columns ?? 1)),
          negative: pct !== null && pct < 0,
        },
        places: places.map((p) => ({
          televendId: Number(p.televend_id),
          caption: p.caption,
          region: p.region,
          enabled: p.enabled,
          current: p.televend_id === m.current_tv,
          firstSeen: p.first_seen?.toISOString() ?? null,
          lastSeen: p.last_seen?.toISOString() ?? null,
        })),
        today: {
          date: today,
          readUntil: cut!.read_until?.toISOString() ?? null,
          hours: Array.from({ length: 24 }, (_, h) => ({
            hour: h,
            cups: hours.find((x) => x.this_day && x.hour === h)?.cups ?? 0,
            cupsWeekBefore: cut!.week_read ? (hours.find((x) => !x.this_day && x.hour === h)?.cups ?? 0) : null,
          })),
          cups: hours.filter((x) => x.this_day).reduce((t, x) => t + x.cups, 0),
          cupsWeekBeforeSameTime: cut!.week_read ? same!.cups : null,
        },
        days,
        payments,
        recentSales: recent.map((r) => ({ at: r.at.toISOString(), payment: r.payment, product: r.product })),
        refills: refills.map((r) => ({
          at: r.at.toISOString(),
          action: r.action,
          change: Number(r.change),
          after: r.after === null ? null : Number(r.after),
          capacity: r.capacity === null ? null : Number(r.capacity),
          by: r.by,
        })),
        seesExpectedCash: seesExpectedCash(viewer),
        collections: await collectionsOf(sql, ids, cashFils, 10, now, seesExpectedCash(viewer)),
        alarms: {
          open: openMapped,
          last7Days: week.map((w) => ({ alarm: w.name, count: w.count })),
          recent: recentAlarms.map((a) => ({ alarm: a.name, startedAt: a.started_at.toISOString(), resolvedAt: a.resolved_at?.toISOString() ?? null })),
        },
        visits: visits.map((v) => ({ at: v.at.toISOString(), by: v.by, how: v.how, endedAt: v.ended_at?.toISOString() ?? null, proof: v.proof })),
        notes: { machine: m.notes, serviceShift: m.service_shift, serviceNote: m.service_note, categoryNote: m.category_note },
      };
    },
    { readOnly: true },
  );
}
