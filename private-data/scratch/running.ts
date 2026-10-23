import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const r = await sql`select stream, mode, status, requests, window_from, started_at, finished_at from tv_sync_run order by started_at desc limit 6`;
for (const x of r) console.log(x.stream, x.mode, x.status, "req", x.requests, "| window", x.window_from?.toISOString?.().slice(0, 10) ?? "-", "| started", x.started_at.toISOString().slice(11, 19), "| finished", x.finished_at?.toISOString().slice(11, 19) ?? "running");
await sql.end();
