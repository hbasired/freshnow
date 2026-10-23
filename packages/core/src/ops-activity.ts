import { withContext, type AppContext } from "./db.js";
import { OpsRefused } from "./ops-alarms.js";
import { OpsDayRefused } from "./ops-sales.js";
import { can, type Actor } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * A day's activity, row by row (TASK-072): every refill — by whom, how much, how full after (R7.3, R13) — and every sale with its
 * machine, category and payment, filterable and paged (R10, "recent purchases"). Counted by Postgres under the viewer's row-level
 * security (televend.read); bounded (at most 200 rows a page, CLAUDE.md rule 4).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 200;

function checkDay(date: string, now: Date): void {
  if (!DAY.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+04:00`))) throw new OpsDayRefused("The day must be a date, YYYY-MM-DD.");
  if (date > localDate(now)) throw new OpsDayRefused("That day has not begun yet.");
}

export interface RefillRow {
  at: string;
  assetNo: number | null;
  label: string;
  action: string;
  change: number;
  after: number | null;
  capacity: number | null;
  by: string | null;
}

/** Every refill logged in Televend on a Dubai day, newest first (at most 300). */
export async function refillsOn(viewer: AppContext & Actor, date: string, now: Date = new Date()): Promise<RefillRow[]> {
  if (!can(viewer, "televend.read")) throw new OpsRefused();
  checkDay(date, now);
  const rows = await withContext(
    viewer,
    (sql) => sql<{ at: Date; asset_no: number | null; label: string; action: string; change: string; after: string | null; capacity: string | null; by: string | null }[]>`
      select r.at, coalesce(m.asset_no, t.asset_no) as asset_no, coalesce(m.label, t.caption, r.machine_caption, 'Machine') as label,
             r.action, r.quantity_change::text as change, r.quantity_after::text as after, r.capacity::text as capacity, r.filled_by as by
        from tv_refill r
        left join tv_machine t on t.televend_id = r.machine_tv_id
        left join machine_placement pl on pl.tv_machine_id = r.machine_tv_id and pl.valid_to is null
        left join machine m on m.id = pl.machine_id
       where r.at >= (${date}::date::timestamp at time zone 'Asia/Dubai') and r.at < ((${date}::date + 1)::timestamp at time zone 'Asia/Dubai')
         and r.at <= ${now}
       order by r.at desc limit 300`,
    { readOnly: true },
  );
  return rows.map((r) => ({
    at: r.at.toISOString(),
    assetNo: r.asset_no,
    label: r.label,
    action: r.action,
    change: Number(r.change),
    after: r.after === null ? null : Number(r.after),
    capacity: r.capacity === null ? null : Number(r.capacity),
    by: r.by,
  }));
}

export interface SaleRow {
  at: string;
  id: string;
  machineTvId: number;
  assetNo: number | null;
  label: string;
  category: string | null;
  payment: string | null;
  product: string | null;
}

export interface SalesList {
  date: string;
  rows: SaleRow[];
  /** Pass as `before` to read the next page; null at the end. */
  next: string | null;
  /** The whole day under the same filters. */
  summary: { cups: number; machines: number; byPayment: { caption: string; cups: number }[]; byHour: { hour: number; cups: number }[] };
  /** The filters' choices for this day: categories and payments that occur. */
  choices: { categories: string[]; payments: string[] };
}

/**
 * The sales of a Dubai day, newest first, `limit` at a time, with the day's totals under the same filters — by machine record,
 * category (FreshNow's correction, else Televend's region) and payment caption. `before` is the previous page's `next`.
 */
export async function salesList(
  viewer: AppContext & Actor,
  q: { date: string; machineTvId?: number; category?: string; payment?: string; before?: string; limit?: number },
  now: Date = new Date(),
): Promise<SalesList> {
  if (!can(viewer, "televend.read")) throw new OpsRefused();
  checkDay(q.date, now);
  const limit = Math.max(1, Math.min(q.limit ?? 50, MAX_PAGE));
  // The cursor is "<ISO time>|<external id>": rows strictly older, ties broken by id — never a row twice, never one skipped.
  let curAt: string | null = null;
  let curId: string | null = null;
  if (q.before) {
    const [a, b] = q.before.split("|");
    if (!a || !b || Number.isNaN(Date.parse(a))) throw new OpsDayRefused("That page marker is not one this list gave.");
    curAt = a;
    curId = b;
  }
  const machine = q.machineTvId ?? null;
  const category = q.category?.trim() || null;
  const payment = q.payment?.trim() || null;
  return withContext(
    viewer,
    async (sql) => {
      const base = sql`
        from tv_vend v
        left join tv_machine t on t.televend_id = v.machine_tv_id
        left join machine_placement pl on pl.tv_machine_id = v.machine_tv_id and pl.valid_to is null
        left join machine m on m.id = pl.machine_id
       where v.at >= (${q.date}::date::timestamp at time zone 'Asia/Dubai') and v.at < ((${q.date}::date + 1)::timestamp at time zone 'Asia/Dubai')
         and v.at <= ${now}
         and (${machine}::bigint is null or v.machine_tv_id = ${machine}::bigint)
         and (${category}::text is null or lower(coalesce(m.category_override, t.region_caption, 'No category')) = lower(${category}::text))
         and (${payment}::text is null or coalesce(v.payment_caption, 'Other') = ${payment}::text)`;
      const rows = await sql<{ at: Date; external_id: string; machine_tv_id: string; asset_no: number | null; label: string; category: string | null; payment: string | null; product: string | null }[]>`
        select v.at, v.external_id, v.machine_tv_id::text, coalesce(m.asset_no, t.asset_no) as asset_no,
               coalesce(m.label, t.caption, v.raw->>'machine_caption', 'Machine') as label,
               coalesce(m.category_override, t.region_caption) as category, v.payment_caption as payment, v.product
        ${base}
         and (${curAt}::text is null or (v.at, v.external_id) < (${curAt}::text::timestamptz, ${curId}::text))
       order by v.at desc, v.external_id desc
       limit ${limit + 1}`;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const [tot] = await sql<{ cups: number; machines: number }[]>`select coalesce(sum(v.quantity), 0)::int as cups, count(distinct v.machine_tv_id)::int as machines ${base}`;
      const byPayment = await sql<{ caption: string; cups: number }[]>`
        select coalesce(v.payment_caption, 'Other') as caption, sum(v.quantity)::int as cups ${base} group by 1 order by 2 desc`;
      const byHour = await sql<{ hour: number; cups: number }[]>`
        select extract(hour from v.at at time zone 'Asia/Dubai')::int as hour, sum(v.quantity)::int as cups ${base} group by 1 order by 1`;
      // The choices ignore the category and payment filters, so a chosen filter never hides the other options.
      const cats = await sql<{ c: string }[]>`
        select distinct coalesce(m.category_override, t.region_caption, 'No category') as c
          from tv_vend v
          left join tv_machine t on t.televend_id = v.machine_tv_id
          left join machine_placement pl on pl.tv_machine_id = v.machine_tv_id and pl.valid_to is null
          left join machine m on m.id = pl.machine_id
         where v.at >= (${q.date}::date::timestamp at time zone 'Asia/Dubai') and v.at < ((${q.date}::date + 1)::timestamp at time zone 'Asia/Dubai')
         order by 1`;
      const pays = await sql<{ p: string }[]>`
        select distinct coalesce(v.payment_caption, 'Other') as p from tv_vend v
         where v.at >= (${q.date}::date::timestamp at time zone 'Asia/Dubai') and v.at < ((${q.date}::date + 1)::timestamp at time zone 'Asia/Dubai')
         order by 1`;
      return {
        date: q.date,
        rows: page.map((r) => ({
          at: r.at.toISOString(),
          id: r.external_id,
          machineTvId: Number(r.machine_tv_id),
          assetNo: r.asset_no,
          label: r.label,
          category: r.category,
          payment: r.payment,
          product: r.product,
        })),
        next: rows.length > limit && last ? `${last.at.toISOString()}|${last.external_id}` : null,
        summary: {
          cups: tot!.cups,
          machines: tot!.machines,
          byPayment,
          byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, cups: byHour.find((x) => x.hour === h)?.cups ?? 0 })),
        },
        choices: { categories: cats.map((c) => c.c), payments: pays.map((p) => p.p) },
      };
    },
    { readOnly: true },
  );
}
