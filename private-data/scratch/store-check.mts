// Read-only: does the store agree with Televend's own counts and with the raw mirror, day by day?
import postgres from "postgres";
import { config } from "dotenv";
config({ path: "C:/Users/acer/Downloads/freshnow/.env", quiet: true });
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { max: 1, onnotice: () => {} });
const [runs] = await sql`
  select count(*)::int as runs, count(*) filter (where agrees)::int as agree, count(*) filter (where agrees = false)::int as differ,
         count(*) filter (where agrees is null)::int as no_count, count(*) filter (where status = 'failed')::int as failed,
         min(day)::text as first, max(day)::text as last
    from (select distinct on (day) * from analytics_run where kind = 'sales_day' order by day, started_at desc) r`;
// The store against the raw mirror for every built day: same cups, same hours total.
const mismatch = await sql`
  with s as (select day, sum(cups)::int c from sales_day group by day),
       h as (select day, sum(cups)::int c from sales_hour group by day),
       raw as (select (at at time zone 'Asia/Dubai')::date as day, sum(quantity)::int c from tv_vend
                where (at at time zone 'Asia/Dubai')::date in (select day from s) group by 1)
  select s.day::text, s.c as store, h.c as hours, raw.c as raw from s join h using (day) join raw using (day)
   where s.c <> raw.c or h.c <> raw.c`;
const [parts] = await sql`select count(*)::int as bad from sales_day where cups <> cash_cups + cashless_cups + cashless3_cups + token_cups + wallet_cups + other_cups`;
const regions = await sql`
  select location_caption, sum(cups)::int as cups, count(distinct machine_tv_id)::int as records
    from sales_day group by 1 order by 2 desc`;
console.log(JSON.stringify({ runs, mismatch, partsBad: parts!.bad, regions }, null, 1));
await sql.end();
