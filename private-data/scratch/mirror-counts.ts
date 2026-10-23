import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
console.table(await sql`select stream, mode, count(*)::int runs, sum(rows_new)::int new_rows, bool_and(complete) all_complete, sum(requests)::int requests from tv_sync_run group by 1,2 order by 1,2`);
console.table(await sql`select (select count(*)::int from tv_vend) vends, (select count(*)::int from tv_event) events, (select count(*)::int from tv_refill) refills, (select count(*)::int from tv_machine) tv_machines, (select count(*)::int from machine) machines, (select count(*)::int from machine_placement where valid_to is null) open_placements`);
console.table(await sql`select stream, read_until from tv_sync_cursor order by stream`);
console.table(await sql`select kind, count(*)::int n, count(*) filter (where resolved_at is null)::int open from tv_event group by kind order by kind`);
await sql.end();
