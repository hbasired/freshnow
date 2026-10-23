import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const one = await sql`select televend_id, raw->>'last_vend_utc' lv, raw->>'last_refill_utc' lr from tv_machine where televend_id in (505434, 506389)`;
console.log(one);
// Disabled records whose last vend is on/after 1 Oct: the only ones that can have been live during the backfilled days.
const recent = await sql`select televend_id, caption, raw->>'last_vend_utc' lv, raw->>'last_refill_utc' lr from tv_machine
  where not enabled and (raw->>'last_vend_utc')::timestamptz >= '2026-09-25' order by (raw->>'last_vend_utc')::timestamptz`;
console.log("disabled records with last vend since 25 Sep:", recent.length);
for (const r of recent) console.log(" ", r.televend_id, JSON.stringify(r.caption), "| last vend", r.lv, "| last refill", r.lr);
const hist = await sql`select date_trunc('month', (raw->>'last_vend_utc')::timestamptz)::date m, count(*)::int n from tv_machine where not enabled group by 1 order by 1`;
console.log("disabled records by month of last vend:", hist.map((h) => `${h.m?.toISOString?.().slice(0,7) ?? "none"}:${h.n}`).join(" "));
await sql.end();
