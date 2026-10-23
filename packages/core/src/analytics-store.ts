import { getServiceSql } from "./db.js";
import { correlationOf } from "./inventory-common.js";

/**
 * The analytics store (TASK-071): each machine record's sales per Dubai day and hour, built from the Televend mirror and kept
 * for the analysis, the forecasts and the patterns (R0.2, R15.3 — "stored for future learning and model building").
 *
 * Built only from days the sync read to their end AND checked against Televend's own count (a daily check or a backfill:
 * tv_sync_run.complete on a whole-day window) — never from a day that might be missing sales. Each build of a day replaces the
 * day's rows in one transaction and is recorded in analytics_run with its input (how many sales it read, the newest stored)
 * and whether its total equals Televend's count, so a figure traces to its run and the run can be repeated to the same answer.
 *
 * A day is built again when its input changes — a late sale stored after the build — and not otherwise. Everything here is
 * counted by Postgres; this file only decides which days to build. Bounded: at most `limit` days per call (CLAUDE.md rule 4).
 *
 * Each sale carries the machine's Televend name and region at the time (raw.machine_caption, raw.location_caption): the
 * store keeps those of the day's last sale, so a machine that moved (a new Televend record, G160 — asset 796 had four) is
 * counted where it stood, not where it stands now.
 */

/** Televend's payment types (VF85): 0 Cash, 1 Cashless, 3 Cashless 3, 7 Token, 8 Wallet; anything else is "other". */
export const PAYMENT = { cash: 0, cashless: 1, cashless3: 3, token: 7, wallet: 8 } as const;
/** The most days one call builds. */
export const STORE_DAYS_PER_RUN = 31;

export interface StoreBuild {
  day: string;
  runId: string;
  vendsRead: number;
  cups: number;
  machines: number;
  televendCount: number | null;
  /** The sales read equal Televend's own count for the day; null when no count was recorded. */
  agrees: boolean | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole days whose sales are complete and checked, but not built yet — or built from different input. Oldest first, at most
 * `limit`; `from`/`to` narrow the search (a rebuild of a range).
 */
export async function daysToBuild(opts: { limit?: number; from?: string; to?: string } = {}): Promise<string[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? STORE_DAYS_PER_RUN, 400));
  const sql = getServiceSql();
  const rows = await sql<{ day: string }[]>`
    with checked as (
      select distinct (r.window_from at time zone 'Asia/Dubai')::date as day
        from tv_sync_run r
       where r.stream = 'vends' and r.complete and r.mode in ('daily_check', 'backfill')
         and r.window_to = r.window_from + interval '1 day'
         and (${opts.from ?? null}::date is null or (r.window_from at time zone 'Asia/Dubai')::date >= ${opts.from ?? null}::date)
         and (${opts.to ?? null}::date is null or (r.window_from at time zone 'Asia/Dubai')::date <= ${opts.to ?? null}::date)
    ),
    input as (
      select c.day,
             (select count(*)::int from tv_vend v
               where v.at >= c.day::timestamp at time zone 'Asia/Dubai' and v.at < (c.day + 1)::timestamp at time zone 'Asia/Dubai') as vends,
             (select max(v.synced_at) from tv_vend v
               where v.at >= c.day::timestamp at time zone 'Asia/Dubai' and v.at < (c.day + 1)::timestamp at time zone 'Asia/Dubai') as synced
        from checked c
    ),
    last_run as (
      select distinct on (day) day, vends_read, input_synced_through
        from analytics_run where kind = 'sales_day' and status = 'ok'
       order by day, started_at desc
    )
    select to_char(i.day, 'YYYY-MM-DD') as day
      from input i left join last_run l on l.day = i.day
     where l.day is null or l.vends_read <> i.vends or l.input_synced_through is distinct from i.synced
     order by i.day
     limit ${limit}`;
  return rows.map((r) => r.day);
}

/**
 * Build one whole day: its rows replaced in one transaction, the run recorded with what it read and whether that equals
 * Televend's own count. Under an advisory lock per day, so two builds of one day never interleave.
 */
export async function buildSalesDay(day: string, opts: { correlationId?: string; isSynthetic?: boolean } = {}): Promise<StoreBuild> {
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error(`not a day: ${day}`);
  const correlationId = correlationOf(opts.correlationId);
  const synthetic = opts.isSynthetic ?? false;
  return getServiceSql().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`analytics:sales_day:${day}`}))`;
    // Televend's own count, from the newest run that found the whole day complete.
    const [count] = await tx<{ n: number | null }[]>`
      select televend_count as n from tv_sync_run
       where stream = 'vends' and complete and mode in ('daily_check', 'backfill')
         and window_from = ${day}::date::timestamp at time zone 'Asia/Dubai'
         and window_to = (${day}::date + 1)::timestamp at time zone 'Asia/Dubai'
       order by started_at desc limit 1`;
    // The input is measured and recorded inside Postgres: a timestamp taken through JavaScript loses its microseconds (G202),
    // and the next run would see "different input" and build the day again for ever.
    const [run] = await tx<{ id: string; vends: number }[]>`
      insert into analytics_run (kind, day, vends_read, input_synced_through, cups, machines, televend_count, status, is_synthetic, correlation_id)
      select 'sales_day', ${day}::date, count(*)::int, max(synced_at), 0, 0, ${count?.n ?? null}, 'ok', ${synthetic}, ${correlationId}
        from tv_vend
       where at >= ${day}::date::timestamp at time zone 'Asia/Dubai' and at < (${day}::date + 1)::timestamp at time zone 'Asia/Dubai'
      returning id, vends_read as vends`;
    const runId = run!.id;
    const vendsRead = run!.vends;
    await tx`delete from sales_hour where day = ${day}`;
    await tx`delete from sales_day where day = ${day}`;
    await tx`
      insert into sales_day (day, machine_tv_id, machine_caption, location_caption, cups, cash_cups, cashless_cups, cashless3_cups,
                             token_cups, wallet_cups, other_cups, first_sale_at, last_sale_at, run_id, is_synthetic)
      select ${day}::date, v.machine_tv_id,
             (array_agg(v.raw->>'machine_caption' order by v.at desc, v.external_id desc))[1],
             (array_agg(v.raw->>'location_caption' order by v.at desc, v.external_id desc))[1],
             sum(v.quantity)::int,
             coalesce(sum(v.quantity) filter (where v.payment_type = ${PAYMENT.cash}), 0)::int,
             coalesce(sum(v.quantity) filter (where v.payment_type = ${PAYMENT.cashless}), 0)::int,
             coalesce(sum(v.quantity) filter (where v.payment_type = ${PAYMENT.cashless3}), 0)::int,
             coalesce(sum(v.quantity) filter (where v.payment_type = ${PAYMENT.token}), 0)::int,
             coalesce(sum(v.quantity) filter (where v.payment_type = ${PAYMENT.wallet}), 0)::int,
             coalesce(sum(v.quantity) filter (where v.payment_type is null or v.payment_type not in (${PAYMENT.cash}, ${PAYMENT.cashless}, ${PAYMENT.cashless3}, ${PAYMENT.token}, ${PAYMENT.wallet})), 0)::int,
             min(v.at), max(v.at), ${runId}, ${synthetic}
        from tv_vend v
       where v.at >= ${day}::date::timestamp at time zone 'Asia/Dubai' and v.at < (${day}::date + 1)::timestamp at time zone 'Asia/Dubai'
       group by v.machine_tv_id`;
    await tx`
      insert into sales_hour (day, machine_tv_id, hour, cups, run_id, is_synthetic)
      select ${day}::date, v.machine_tv_id, extract(hour from v.at at time zone 'Asia/Dubai')::int, sum(v.quantity)::int, ${runId}, ${synthetic}
        from tv_vend v
       where v.at >= ${day}::date::timestamp at time zone 'Asia/Dubai' and v.at < (${day}::date + 1)::timestamp at time zone 'Asia/Dubai'
       group by v.machine_tv_id, 3
      having sum(v.quantity) > 0`;
    const [out] = await tx<{ cups: number; machines: number }[]>`
      select coalesce(sum(cups), 0)::int as cups, count(*)::int as machines from sales_day where day = ${day}`;
    const agrees = count?.n === null || count?.n === undefined ? null : count.n === vendsRead;
    await tx`update analytics_run set cups = ${out!.cups}, machines = ${out!.machines}, agrees = ${agrees}, finished_at = now() where id = ${runId}`;
    return {
      day,
      runId,
      vendsRead,
      cups: out!.cups,
      machines: out!.machines,
      televendCount: count?.n ?? null,
      agrees,
    };
  });
}

/** Record a build that failed, so a day that cannot be built is seen rather than retried silently for ever. */
async function recordFailure(day: string, err: unknown, correlationId: string): Promise<void> {
  await getServiceSql()`
    insert into analytics_run (kind, day, vends_read, cups, machines, status, error, finished_at, correlation_id)
    values ('sales_day', ${day}, 0, 0, 0, 'failed', ${err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)}, now(), ${correlationId})`;
}

/**
 * The store's scheduled run: build every day that needs it, oldest first, at most `limit`. A day that fails is recorded and the
 * others go on; it is tried again next run.
 */
export async function runAnalyticsStore(opts: { limit?: number; from?: string; to?: string; correlationId?: string } = {}): Promise<{
  built: StoreBuild[];
  failed: { day: string; error: string }[];
}> {
  const correlationId = correlationOf(opts.correlationId);
  const days = await daysToBuild(opts);
  const built: StoreBuild[] = [];
  const failed: { day: string; error: string }[] = [];
  for (const day of days) {
    try {
      built.push(await buildSalesDay(day, { correlationId }));
    } catch (err) {
      failed.push({ day, error: err instanceof Error ? err.message : String(err) });
      await recordFailure(day, err, correlationId).catch(() => {});
    }
  }
  return { built, failed };
}

// ── Televend's own daily totals, for the months its sales list no longer holds ──
export interface DayTotalsSource {
  vendTotals(range: { from: Date; to: Date }): Promise<{ vends: number; quantity: number | null | undefined }>;
}

const dubaiMidnight = (day: string): Date => new Date(`${day}T00:00:00+04:00`);
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Televend's own count of the fleet's sales for each whole day of a range — one read per day, newest first, skipping days
 * already fetched, stopping at `maxRequests` (run it again to continue). Read-only towards Televend.
 */
export async function backfillDayTotals(
  source: DayTotalsSource,
  p: { from: string; to: string; maxRequests: number; correlationId?: string; onDay?: (line: string) => void },
): Promise<{ days: number; stoppedAt: string | null }> {
  if (!DAY.test(p.from) || !DAY.test(p.to) || p.from > p.to) throw new Error("day totals need --from and --to, YYYY-MM-DD, the earlier first");
  const correlationId = correlationOf(p.correlationId);
  const sql = getServiceSql();
  const have = new Set(
    (await sql<{ day: string }[]>`select to_char(day, 'YYYY-MM-DD') as day from tv_day_total where day between ${p.from} and ${p.to}`).map((r) => r.day),
  );
  let requests = 0;
  let days = 0;
  for (let d = p.to; d >= p.from; d = new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)) {
    if (have.has(d)) continue;
    if (requests >= p.maxRequests) return { days, stoppedAt: d };
    requests++;
    const t = await source.vendTotals({ from: dubaiMidnight(d), to: dubaiMidnight(nextDay(d)) });
    await sql`
      insert into tv_day_total (day, vends, quantity, correlation_id) values (${d}, ${t.vends}, ${t.quantity ?? null}, ${correlationId})
      on conflict (day) do update set vends = excluded.vends, quantity = excluded.quantity, fetched_at = now(), correlation_id = excluded.correlation_id`;
    days++;
    p.onDay?.(`${d}: ${t.vends} sales`);
  }
  return { days, stoppedAt: null };
}

// ── for /health ─────────────────────────────────────────────────────────────
export interface StoreHealth {
  /** The newest day with a good build. */
  lastBuiltDay: string | null;
  lastBuildAt: string | null;
  daysBuilt: number;
  /** Days whose latest build's sales differ from Televend's own count — each needs a look. */
  differ: string[];
  /** Days whose latest build failed. */
  failed: string[];
}

/** Cheap enough for every /health call: the latest build of each day, nothing recomputed. */
export async function analyticsStoreHealth(): Promise<StoreHealth> {
  const rows = await getServiceSql()<{ day: string; status: string; agrees: boolean | null; finished_at: Date | null }[]>`
    select distinct on (day) to_char(day, 'YYYY-MM-DD') as day, status, agrees, finished_at
      from analytics_run where kind = 'sales_day'
     order by day, started_at desc`;
  const ok = rows.filter((r) => r.status === "ok");
  const last = ok.reduce<{ day: string; at: Date | null } | null>((b, r) => (!b || r.day > b.day ? { day: r.day, at: r.finished_at } : b), null);
  return {
    lastBuiltDay: last?.day ?? null,
    lastBuildAt: last?.at ? last.at.toISOString() : null,
    daysBuilt: ok.length,
    differ: ok.filter((r) => r.agrees === false).map((r) => r.day).slice(-10),
    failed: rows.filter((r) => r.status === "failed").map((r) => r.day).slice(-10),
  };
}
