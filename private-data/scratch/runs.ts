import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const cols = (await sql`select column_name from information_schema.columns where table_name = 'tv_sync_run' order by ordinal_position`).map((c) => c.column_name);
console.log(cols.join(", "));
const r = await sql`select stream, mode, count(*)::int runs, round(avg(requests))::int avg_req, max(requests)::int max_req,
  round(avg(extract(epoch from finished_at - started_at)))::int avg_s, max(extract(epoch from finished_at - started_at))::int max_s
  from tv_sync_run where finished_at is not null group by 1, 2 order by 2, 1`;
console.table(r);
await sql.end();
