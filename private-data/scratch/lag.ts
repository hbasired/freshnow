import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const runs = await sql<{ started_at: Date; finished_at: Date | null; requests: number; status: string }[]>`
  select started_at, finished_at, requests, status from tv_sync_run where stream = 'machines' and mode = 'incremental' order by started_at`;
const dubai = (d: Date) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(11, 19);
let prev: Date | null = null;
for (const r of runs) {
  const gap = prev ? Math.round((r.started_at.getTime() - prev.getTime()) / 60000) : null;
  console.log(dubai(r.started_at), "Dubai |", r.status, "| gap", gap === null ? "-" : `${gap} min`);
  prev = r.started_at;
}
// Freshness of the mirror right now: newest vend stored vs now.
const v = await sql`select max(at) as newest from tv_vend`;
console.log("now", dubai(new Date()), "| newest vend stored", dubai(v[0].newest), "| behind", Math.round((Date.now() - v[0].newest.getTime()) / 60000), "min");
await sql.end();
