import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const since = new Date("2026-10-15T11:00:00Z");
const runs = await sql<{ started_at: Date; finished_at: Date | null; status: string; requests: number }[]>`
  select started_at, finished_at, status, requests from tv_sync_run where stream = 'machines' and mode = 'incremental' and started_at >= ${since} order by started_at`;
const dubai = (d: Date) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(11, 19);
const gaps: number[] = [];
for (let i = 1; i < runs.length; i++) gaps.push((runs[i]!.started_at.getTime() - runs[i - 1]!.started_at.getTime()) / 60000);
console.log(`runs since 11:00 UTC: ${runs.length}, all ok: ${runs.every((r) => r.status === "ok")}, first ${dubai(runs[0]!.started_at)} Dubai, last ${dubai(runs.at(-1)!.started_at)} Dubai`);
console.log(`gaps (min): min ${Math.min(...gaps).toFixed(1)}, max ${Math.max(...gaps).toFixed(1)}`);
const all = await sql`select stream, count(*)::int n, count(*) filter (where status <> 'ok')::int not_ok, sum(requests)::int req, max(extract(epoch from finished_at - started_at))::int max_s
  from tv_sync_run where mode = 'incremental' and started_at >= ${since} group by 1 order by 1`;
console.table(all);
const v = await sql`select max(at) newest from tv_vend`;
console.log(`now ${dubai(new Date())} Dubai, newest vend stored ${dubai(v[0].newest)} Dubai (${Math.round((Date.now() - v[0].newest.getTime()) / 60000)} min behind)`);
await sql.end();
