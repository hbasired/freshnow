// Read-only: what Televend's stock fields on a machine record hold, and the refill log's shape.
import postgres from "postgres";
import { config } from "dotenv";
config({ path: "C:/Users/acer/Downloads/freshnow/.env", quiet: true });
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { max: 1, onnotice: () => {} });
const sample = await sql`
  select asset_no, caption, stock_percent, stock_tracking, last_refill_at, last_vend_at, signal_strength, last_status, connection_status,
         raw->'stock' as stock, raw->'stock_data' as stock_data, raw->'status_info' as status_info, raw->'free_vend' as free_vend
    from tv_machine where enabled and asset_no in (395, 857, 864, 798, 312) order by asset_no`;
const dist = await sql`select count(*)::int n, count(stock_percent)::int with_pct, min(stock_percent) mn, max(stock_percent) mx, count(*) filter (where stock_tracking)::int tracking from tv_machine where enabled`;
const refills = await sql`select action, count(*)::int n, min(quantity_change)::text mn, max(quantity_change)::text mx from tv_refill where at > now() - interval '14 days' group by 1 order by 2 desc`;
const rcols = await sql`select column_name from information_schema.columns where table_name = 'tv_refill' order by ordinal_position`;
const oneRefill = await sql`select at, action, quantity_change::text, product, filled_by, raw from tv_refill where machine_tv_id = (select televend_id from tv_machine where asset_no = 395 and enabled limit 1) order by at desc limit 2`;
console.log(JSON.stringify({ sample, dist, refills, rcols: rcols.map((c) => c.column_name), oneRefill }, null, 1));
await sql.end();
