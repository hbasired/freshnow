// Read-only: what one stored sale's raw Televend record carries, and the caption history kept for machines.
import postgres from "postgres";
import { config } from "dotenv";
config({ path: "C:/Users/acer/Downloads/freshnow/.env", quiet: true });
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { max: 1, onnotice: () => {} });
const keys = await sql`select k, count(*)::int n from (select raw from tv_vend order by at desc limit 2000) v, jsonb_object_keys(v.raw) k group by k order by n desc, k`;
const [one] = await sql`select raw from tv_vend where machine_tv_id in (select televend_id from tv_machine where asset_no = 796) order by at desc limit 1`;
const capCols = await sql`select column_name from information_schema.columns where table_name = 'tv_machine_caption' order by ordinal_position`;
const caps = await sql`select * from tv_machine_caption where televend_id in (select televend_id from tv_machine where asset_no in (796, 543)) order by 1, 2 limit 20`;
const tvIds796 = await sql`select televend_id, caption, enabled, region_caption from tv_machine where asset_no = 796 or caption ilike '%796%'`;
console.log(JSON.stringify({ keys, raw796: one?.raw, capCols: capCols.map((c) => c.column_name), caps, tvIds796 }, null, 1));
await sql.end();
