// Read-only: which stretches of 18-20 Oct (Dubai) the vends sync read to their end, and the gaps between them.
import postgres from "postgres";
import { config } from "dotenv";
config({ path: "C:/Users/acer/Downloads/freshnow/.env", quiet: true });
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { max: 1, onnotice: () => {} });
const runs = await sql`
  select mode, status, complete,
         to_char(window_from at time zone 'Asia/Dubai', 'MM-DD HH24:MI') as from_dxb,
         to_char(window_to at time zone 'Asia/Dubai', 'MM-DD HH24:MI') as to_dxb,
         to_char(started_at at time zone 'Asia/Dubai', 'MM-DD HH24:MI') as ran
    from tv_sync_run
   where stream = 'vends' and window_to > '2026-10-18T20:00:00Z' and window_from < '2026-10-20T00:00:00Z'
   order by window_from`;
const gaps = await sql`
  with r as (select range_agg(tstzrange(window_from, window_to)) as m from tv_sync_run
              where stream = 'vends' and complete and window_to > window_from
                and window_to > '2026-10-18T20:00:00Z' and window_from < '2026-10-20T20:00:00Z')
  select to_char(lower(g) at time zone 'Asia/Dubai', 'MM-DD HH24:MI:SS') as gap_from, to_char(upper(g) at time zone 'Asia/Dubai', 'MM-DD HH24:MI:SS') as gap_to
    from r, unnest(tstzmultirange(tstzrange('2026-10-18T20:00:00Z', least(now(), '2026-10-20T20:00:00Z'))) - r.m) as g`;
const modes = await sql`select mode, count(*)::int n, count(*) filter (where complete)::int complete from tv_sync_run where stream = 'vends' and started_at > now() - interval '3 days' group by 1`;
console.log(JSON.stringify({ runs: runs.length, first: runs.slice(0, 3), last: runs.slice(-3), incomplete: runs.filter((r) => !r.complete).slice(0, 10), gaps, modes }, null, 1));
await sql.end();
